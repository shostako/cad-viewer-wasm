/** Measurement mode: two-click exact distance + entity info on circular picks.
 *
 * Click A → marker. Click B → server computes exact B-rep distance
 * (BRepExtrema) and we draw the dimension between the true nearest points.
 * Picking a circular edge / cylindrical face also reports its exact
 * diameter (hole/boss measurement, the injection-molding bread & butter).
 */
import * as THREE from 'three'
import {
  measureDistance,
  measureEdgeInfo,
  measureFaceInfo,
  type EntityRef,
} from './api'
import type { PickResult } from './picking'
import type { Viewer } from './viewer'

/** Serializable form of an entry — persisted to the model's sidecar. */
export interface EntryData {
  /** list panel text */
  text: string
  /** 3D label content (empty = no label) */
  labelText: string
  labelPos: [number, number, number]
  line?: [[number, number, number], [number, number, number]]
  markers?: [number, number, number][]
  annotation?: boolean
}

export interface MeasureEntry {
  id: number
  label: string
  objects: THREE.Object3D[]
  data: EntryData
}

const MARKER_COLOR = 0xffb020
const DIM_COLOR = 0xffd060

export class MeasureTool {
  private viewer: Viewer
  private modelId: string | null = null
  // bumped on every clearAll(): invalidates in-flight requests even when a
  // re-upload of identical content yields the same (deduped) model id
  private session = 0
  private isBrep = false
  private pending: { pick: PickResult; marker: THREE.Object3D } | null = null
  private entries: MeasureEntry[] = []
  private nextId = 1
  private listeners: (() => void)[] = []
  busy = false

  constructor(viewer: Viewer) {
    this.viewer = viewer
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  setModel(modelId: string, isBrep: boolean): void {
    this.clearAll()
    this.modelId = modelId
    this.isBrep = isBrep
  }

  get available(): boolean {
    return this.modelId !== null && this.isBrep
  }

  list(): readonly MeasureEntry[] {
    return this.entries
  }

  /** Handle a pick in measure mode. Returns a status message for the HUD. */
  async handlePick(pick: PickResult): Promise<string> {
    if (!this.modelId || this.busy) return ''

    if (!this.pending) {
      const marker = this.makeMarker(pick.point)
      this.viewer.overlay.add(marker)
      this.pending = { pick, marker }
      // circular entity? report its exact diameter as a bonus entry
      void this.reportEntityInfo(pick)
      return `${describe(pick)} を選択 — 相手をクリック`
    }

    const a = this.pending
    this.pending = null
    this.busy = true
    // capture: setModel()/clearAll()/cancelPending() can run while the request
    // is in flight (each bumps session). A late result must neither be added to
    // the new model NOR reset the busy flag the active request now owns.
    const requestedModelId = this.modelId
    const requestedSession = this.session
    try {
      const res = await measureDistance(requestedModelId, toRef(a.pick), toRef(pick))
      if (this.modelId !== requestedModelId || this.session !== requestedSession) {
        this.viewer.disposeOverlayObject(a.marker)
        return '' // stale: model switched mid-flight
      }
      // temporary first-click marker is replaced by the restored-from-data entry
      this.viewer.disposeOverlayObject(a.marker)
      const pa = res.pointA
      const pb = res.pointB
      const mid: [number, number, number] = [
        (pa[0] + pb[0]) / 2,
        (pa[1] + pb[1]) / 2,
        (pa[2] + pb[2]) / 2,
      ]
      const data: EntryData = {
        text: `${describe(a.pick)} ↔ ${describe(pick)} : ${fmt(res.value)}`,
        labelText: fmt(res.value),
        labelPos: mid,
        markers: [a.pick.point.toArray() as [number, number, number], pick.point.toArray() as [number, number, number]],
        ...(res.value > 1e-12 ? { line: [pa, pb] as EntryData['line'] } : {}),
      }
      this.addFromData(data)
      return `距離 ${fmt(res.value)}`
    } catch (e) {
      this.viewer.disposeOverlayObject(a.marker)
      throw e
    } finally {
      // only release busy if we still own it: cancelPending() or a newer pick
      // bumps session and takes over the picker, so a stale return must not
      // clear the busy flag out from under the active request
      if (this.session === requestedSession) this.busy = false
    }
  }

  /** Build overlay graphics from serializable data and register the entry. */
  addFromData(data: EntryData): void {
    const objects: THREE.Object3D[] = []
    for (const m of data.markers ?? []) {
      const marker = this.makeMarker(new THREE.Vector3(...m))
      this.viewer.overlay.add(marker)
      objects.push(marker)
    }
    if (data.line) {
      const line = this.makeDimLine(
        new THREE.Vector3(...data.line[0]),
        new THREE.Vector3(...data.line[1]),
      )
      this.viewer.overlay.add(line)
      objects.push(line)
    }
    if (data.labelText) {
      const label = this.viewer.makeLabel(
        data.labelText,
        new THREE.Vector3(...data.labelPos),
        data.annotation ? 'note-label' : 'dim-label',
      )
      this.viewer.overlay.add(label)
      objects.push(label)
    }
    this.addEntry(data.text, objects, data)
  }

  toJSON(): EntryData[] {
    return this.entries.map((e) => e.data)
  }

  restore(datas: EntryData[]): void {
    for (const d of datas) this.addFromData(d)
  }

  cancelPending(): void {
    // invalidate in-flight distance / entity-info requests too — leaving
    // measure mode must not let a late response add (and autosave) an entry
    this.session++
    // free the picker immediately: the in-flight request (if any) is now stale
    // and its late response is dropped by the session guard, so don't make the
    // user wait for it to release busy. (Slow exact B-rep measurements used to
    // freeze all new picks until the abandoned request returned.)
    this.busy = false
    if (this.pending) {
      this.viewer.disposeOverlayObject(this.pending.marker)
      this.pending = null
    }
  }

  private async reportEntityInfo(pick: PickResult): Promise<void> {
    if (!this.modelId) return
    // same stale-response hazard as handlePick: drop late results after a model switch
    const requestedModelId = this.modelId
    const requestedSession = this.session
    try {
      if (pick.kind === 'edge') {
        const info = await measureEdgeInfo(requestedModelId, toRef(pick))
        if (this.modelId !== requestedModelId || this.session !== requestedSession) return
        if (info.curve === 'circle' && info.diameter !== undefined && info.center) {
          this.addFromData({
            text: `円エッジ ⌀${fmt(info.diameter)} (L=${fmt(info.length)})`,
            labelText: `⌀${fmt(info.diameter)}`,
            labelPos: info.center,
          })
        }
      } else if (pick.kind === 'face') {
        const info = await measureFaceInfo(requestedModelId, toRef(pick))
        if (this.modelId !== requestedModelId || this.session !== requestedSession) return
        if (info.surface === 'cylinder' && info.diameter !== undefined) {
          this.addFromData({
            text: `円筒面 ⌀${fmt(info.diameter)}`,
            labelText: `⌀${fmt(info.diameter)}`,
            labelPos: pick.point.toArray() as [number, number, number],
          })
        }
      }
    } catch {
      /* info is best-effort; distance flow continues regardless */
    }
  }

  /** Add a text annotation pinned to a 3D point. */
  addAnnotation(text: string, at: THREE.Vector3): void {
    this.addFromData({
      text: `📌 ${text}`,
      labelText: text,
      labelPos: at.toArray() as [number, number, number],
      markers: [at.toArray() as [number, number, number]],
      annotation: true,
    })
  }

  private addEntry(label: string, objects: THREE.Object3D[], data: EntryData): void {
    this.entries.push({ id: this.nextId++, label, objects, data })
    this.emit()
  }

  remove(id: number): void {
    const i = this.entries.findIndex((e) => e.id === id)
    if (i < 0) return
    for (const o of this.entries[i].objects) this.viewer.disposeOverlayObject(o)
    this.entries.splice(i, 1)
    this.emit()
  }

  clearAll(): void {
    this.cancelPending() // bumps session — invalidates all in-flight requests
    for (const e of this.entries) for (const o of e.objects) this.viewer.disposeOverlayObject(o)
    this.entries = []
    this.emit()
  }

  private makeMarker(at: THREE.Vector3): THREE.Object3D {
    // screen-constant size via onBeforeRender scaling
    const geo = new THREE.SphereGeometry(1, 12, 12)
    const mat = new THREE.MeshBasicMaterial({ color: MARKER_COLOR, depthTest: false })
    const m = new THREE.Mesh(geo, mat)
    m.renderOrder = 999
    m.position.copy(at)
    const viewer = this.viewer
    m.onBeforeRender = () => {
      const dist = viewer.camera.position.distanceTo(m.position)
      const s = (dist * Math.tan((viewer.camera.fov * Math.PI) / 360) * 2) /
        viewer.renderer.domElement.clientHeight * 4 // ≈4px radius
      m.scale.setScalar(s)
    }
    return m
  }

  private makeDimLine(a: THREE.Vector3, b: THREE.Vector3): THREE.Object3D {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b])
    const mat = new THREE.LineBasicMaterial({ color: DIM_COLOR, depthTest: false })
    const line = new THREE.Line(geo, mat)
    line.renderOrder = 998
    return line
  }
}

function toRef(pick: PickResult): EntityRef {
  // Always send the topology ref. Vertex picks used to be flattened to a
  // 'point' ref, but the snapped coordinate comes from the float32 display
  // mesh — on large-coordinate STEP/IGES models that rounding defeats the
  // exact B-rep measurement. The id IS the 1-based TopTools vertex map index,
  // which the backend resolves to the exact vertex.
  return { partId: pick.partId, kind: pick.kind, id: pick.id }
}

function describe(pick: PickResult): string {
  const kind = { vertex: '頂点', edge: 'エッジ', face: '面' }[pick.kind]
  return `${kind}#${pick.id}`
}

function fmt(v: number): string {
  return v.toFixed(3)
}
