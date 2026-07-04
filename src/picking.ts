/** Entity picking with snap priority: vertex > edge > face.
 *
 * Raycasting runs on the display mesh (three-mesh-bvh accelerated), but every
 * pick resolves to a topology ID (faceId / edgeId / vertexId) that maps 1:1 to
 * the server-side B-rep — measurements are then computed exactly on the server.
 */
import * as THREE from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import type { EdgeRange, FaceRange, PartData } from './model'
import type { Viewer } from './viewer'

// install BVH acceleration globally
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

export type EntityKind = 'vertex' | 'edge' | 'face'

export interface PickResult {
  partId: number
  kind: EntityKind
  id: number
  /** snapped 3D point (exact for vertices, approximate for edge/face hits) */
  point: THREE.Vector3
}

const VERTEX_SNAP_PX = 14
const EDGE_SNAP_PX = 10

export class Picker {
  private raycaster = new THREE.Raycaster()
  private parts = new Map<number, PartData>()
  private meshes: THREE.Mesh[] = []

  private viewer: Viewer

  constructor(viewer: Viewer) {
    this.viewer = viewer
  }

  setModel(parts: PartData[]): void {
    this.parts.clear()
    this.meshes = []
    for (const part of parts) {
      this.parts.set(part.id, part)
      const mesh = this.viewer.getPartMesh(part.id)
      if (mesh) {
        // indirect: keep the original index order — faceRanges (triStart/triCount)
        // map triangles to B-rep faceIds and must never be reshuffled
        mesh.geometry.computeBoundsTree({ indirect: true })
        mesh.userData.partId = part.id
        this.meshes.push(mesh)
      }
    }
  }

  clear(): void {
    for (const m of this.meshes) m.geometry.disposeBoundsTree()
    this.meshes = []
    this.parts.clear()
  }

  /** Pick at normalized device coords; returns null when nothing is hit. */
  pick(ndc: THREE.Vector2): PickResult | null {
    this.raycaster.setFromCamera(ndc, this.viewer.camera)
    const visible = this.meshes.filter((m) => m.parent?.visible)
    const hits = this.raycaster.intersectObjects(visible, false)
    if (hits.length === 0) return null

    // The raycaster tests the raw geometry; with the section tool active the
    // nearest hits may lie on the clipped-away side of the plane. Take the
    // first hit that is NOT clipped, so clicks in a sectioned view never
    // select (and measure/annotate) geometry the user cannot see.
    const hit = hits.find((h) => {
      const planes = (h.object as THREE.Mesh).material as THREE.Material
      const clip = (planes as THREE.Material & { clippingPlanes?: THREE.Plane[] }).clippingPlanes
      if (!clip || clip.length === 0) return true
      return clip.every((p) => p.distanceToPoint(h.point) >= 0)
    })
    if (!hit) return null
    const partId = hit.object.userData.partId as number
    const part = this.parts.get(partId)
    if (!part || hit.faceIndex === undefined || hit.faceIndex === null) return null

    // snap candidates must respect the same clipping planes as the hit —
    // a clipped-away vertex/edge within snap radius must not win
    const hitMat = (hit.object as THREE.Mesh).material as THREE.Material & {
      clippingPlanes?: THREE.Plane[]
    }
    const clip = hitMat.clippingPlanes ?? []

    // 1) vertex snap (screen-space)
    const v = this.snapVertex(part, hit.point, clip)
    if (v) return v

    // 2) edge snap (screen-space distance to edge segments)
    const e = this.snapEdge(part, hit.point, clip)
    if (e) return e

    // 3) face
    // Mesh formats (STL/3MF/...) ship faceRanges: [] — no B-rep face ids exist.
    // Still return a generic face pick (id -1) so annotation mode gets its
    // hit.point and measure mode can show the "STEP/IGES only" HUD message
    // instead of silently ignoring every click on the model surface.
    if (part.faceRanges.length === 0) {
      return { partId, kind: 'face', id: -1, point: hit.point.clone() }
    }
    const faceId = findRange(part.faceRanges, hit.faceIndex)
    if (faceId === null) return null
    return { partId, kind: 'face', id: faceId, point: hit.point.clone() }
  }

  private pxScale(at: THREE.Vector3): number {
    // world units per screen pixel at the given depth (perspective camera)
    const cam = this.viewer.camera
    const dist = cam.position.distanceTo(at)
    const height = 2 * dist * Math.tan((cam.fov * Math.PI) / 360)
    return height / this.viewer.renderer.domElement.clientHeight
  }

  private snapVertex(
    part: PartData,
    hitPoint: THREE.Vector3,
    clip: THREE.Plane[] = [],
  ): PickResult | null {
    const maxDist = VERTEX_SNAP_PX * this.pxScale(hitPoint)
    let best = -1
    let bestD = maxDist
    const vs = part.vertices
    const p = new THREE.Vector3()
    for (let i = 0; i < vs.length; i += 3) {
      p.set(vs[i], vs[i + 1], vs[i + 2])
      if (clip.length && !clip.every((pl) => pl.distanceToPoint(p) >= 0)) continue
      const d = p.distanceTo(hitPoint)
      if (d < bestD) {
        bestD = d
        best = i / 3
      }
    }
    if (best < 0) return null
    return {
      partId: part.id,
      kind: 'vertex',
      id: best + 1, // TopTools map indices are 1-based
      point: new THREE.Vector3(vs[best * 3], vs[best * 3 + 1], vs[best * 3 + 2]),
    }
  }

  private snapEdge(
    part: PartData,
    hitPoint: THREE.Vector3,
    clip: THREE.Plane[] = [],
  ): PickResult | null {
    const maxDist = EDGE_SNAP_PX * this.pxScale(hitPoint)
    const segs = part.edges
    let bestD = maxDist
    let bestSeg = -1
    const bestPoint = new THREE.Vector3()
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const closest = new THREE.Vector3()
    const line = new THREE.Line3()
    for (let s = 0; s * 6 + 5 < segs.length; s++) {
      a.set(segs[s * 6], segs[s * 6 + 1], segs[s * 6 + 2])
      b.set(segs[s * 6 + 3], segs[s * 6 + 4], segs[s * 6 + 5])
      line.set(a, b)
      line.closestPointToPoint(hitPoint, true, closest)
      if (clip.length && !clip.every((pl) => pl.distanceToPoint(closest) >= 0)) continue
      const d = closest.distanceTo(hitPoint)
      if (d < bestD) {
        bestD = d
        bestSeg = s
        bestPoint.copy(closest)
      }
    }
    if (bestSeg < 0) return null
    const edgeId = findEdgeRange(part.edgeRanges, bestSeg)
    if (edgeId === null) return null
    return { partId: part.id, kind: 'edge', id: edgeId, point: bestPoint.clone() }
  }
}

// Contract (backend tessellation.py): faceRanges/edgeRanges are emitted in
// ascending triStart/segStart order with no overlap — triangles are packed
// per face in TopTools map order. The binary searches below rely on this.
// Note: hit.faceIndex maps to the ORIGINAL triangle order because the BVH is
// built with {indirect: true}; the E2E pick tests pin this behavior.
function findRange(ranges: FaceRange[], triIndex: number): number | null {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]
    if (triIndex < r.triStart) hi = mid - 1
    else if (triIndex >= r.triStart + r.triCount) lo = mid + 1
    else return r.faceId
  }
  return null
}

function findEdgeRange(ranges: EdgeRange[], segIndex: number): number | null {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]
    if (segIndex < r.segStart) hi = mid - 1
    else if (segIndex >= r.segStart + r.segCount) lo = mid + 1
    else return r.edgeId
  }
  return null
}
