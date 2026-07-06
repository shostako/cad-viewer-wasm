import './style.css'
import GUI from 'lil-gui'
import * as THREE from 'three'
import {
  uploadModel,
  fetchMesh,
  fetchDrawingSvg,
  fetchThickness,
  getSidecar,
  putSidecar,
  __stallNextMeasure,
  __stallNextSidecar,
  __stallNextLoad,
  type ModelMeta,
} from './api'
import { Drawing2D } from './drawing2d'
import { MeasureTool, type EntryData } from './measure'
import { toModelData } from './model'
import { Picker } from './picking'
import { SectionTool, type Axis } from './section'
import { renderTree } from './tree'
import { Viewer } from './viewer'

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <div id="viewport"></div>
  <div id="viewport2d" class="hidden"></div>
  <div id="dropzone" class="hidden">ここにドロップして読み込み</div>
  <div id="tree-panel" class="hidden">
    <div id="tree-title">部品ツリー</div>
    <div id="tree-body"></div>
  </div>
  <div id="measure-panel" class="hidden">
    <div id="measure-title">計測</div>
    <ul id="measure-list"></ul>
  </div>
  <div id="hud">
    <div id="hud-title">cad-viewer</div>
    <div id="hud-info">STEP / IGES / STL / 3MF をドロップ、またはメニューから選択</div>
  </div>
  <input type="file" id="file-input" accept=".step,.stp,.iges,.igs,.stl,.3mf,.obj,.ply,.dxf,.dwg" hidden />
`

const viewport = document.querySelector<HTMLDivElement>('#viewport')!
const dropzone = document.querySelector<HTMLDivElement>('#dropzone')!
const hudInfo = document.querySelector<HTMLDivElement>('#hud-info')!
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!
const treePanel = document.querySelector<HTMLDivElement>('#tree-panel')!
const treeBody = document.querySelector<HTMLDivElement>('#tree-body')!

const measurePanel = document.querySelector<HTMLDivElement>('#measure-panel')!
const measureList = document.querySelector<HTMLUListElement>('#measure-list')!

const viewport2d = document.querySelector<HTMLDivElement>('#viewport2d')!

const viewer = new Viewer(viewport)
const picker = new Picker(viewer)
const measureTool = new MeasureTool(viewer)
const sectionTool = new SectionTool(viewer)
const drawing2d = new Drawing2D(viewport2d, (msg) => {
  hudInfo.textContent = msg
})

let is2D = false
function show2D(on: boolean): void {
  is2D = on
  viewport2d.classList.toggle('hidden', !on)
  viewport.classList.toggle('hidden', on)
  treePanel.classList.toggle('hidden', on || !treeBody.hasChildNodes())
}

let currentModelId: string | null = null
// Sidecar-save suppression during model teardown/restore. Generation-tagged
// (not a plain boolean) so a superseded load releases its own claim without
// clobbering a newer load's — a boolean got stuck true when the newer load
// failed before entering its own teardown, silently killing all saves.
let restoringOwner = 0 // 0 = not restoring; otherwise the loadGen that owns it

const gui = new GUI({ title: '操作' })
const state = { mode: 'なし' as 'なし' | '計測' | '注記' }
const actions = {
  open: () => fileInput.click(),
  fit: () => (is2D ? drawing2d.fit() : viewer.fitToView()),
  clearMeasure: () => {
    measureTool.clearAll()
    drawing2d.clearMeasurements()
  },
}
gui.add(actions, 'open').name('ファイルを開く')
gui.add(actions, 'fit').name('全体表示')
gui
  .add(state, 'mode', ['なし', '計測', '注記'])
  .name('モード')
  .onChange((mode: string) => {
    if (mode !== '計測') measureTool.cancelPending()
    drawing2d.measureMode = mode === '計測'
    viewport.style.cursor = mode === 'なし' ? '' : 'crosshair'
    viewport2d.style.cursor = mode === '計測' ? 'crosshair' : ''
  })
gui.add(actions, 'clearMeasure').name('計測クリア')

const sectionFolder = gui.addFolder('断面')
sectionFolder.close()
sectionFolder
  .add(sectionTool, 'enabled')
  .name('有効')
  .listen() // state can change programmatically (2D switch) — keep UI in sync
  .onChange(() => sectionTool.update())
sectionFolder
  .add(sectionTool, 'axis', ['X', 'Y', 'Z'] as Axis[])
  .name('軸')
  .onChange(() => sectionTool.update())
sectionFolder
  .add(sectionTool, 'position', 0, 1, 0.01)
  .name('位置')
  .onChange(() => sectionTool.update())
sectionFolder
  .add(sectionTool, 'flip')
  .name('反転')
  .onChange(() => sectionTool.update())
sectionFolder
  .add(sectionTool, 'caps')
  .name('キャップ（切り口を塞ぐ）')
  .onChange(() => sectionTool.update())

// ---- thickness heatmap
const thicknessState = { enabled: false, threshold: 1.5, method: 'ray' as 'ray' | 'ball' }
const thicknessCache = new Map<string, Map<number, Float32Array>>()
async function updateThickness(): Promise<void> {
  if (!currentModelId) return
  if (!thicknessState.enabled) {
    viewer.clearThicknessColors()
    return
  }
  // Capture the request context: a slow fetch can resolve after the user has
  // switched models (or toggled off) — applying that late response would
  // recolor the wrong model and poison the (already cleared) cache.
  const requestedId = currentModelId
  const requestedGen = loadGen
  const requestedMethod = thicknessState.method // method can also change mid-flight
  try {
    let data = thicknessCache.get(requestedMethod)
    if (!data) {
      hudInfo.textContent =
        requestedMethod === 'ball' ? '肉厚計算中（ボール法、少し待て）...' : '肉厚計算中...'
      data = await fetchThickness(requestedId, requestedMethod)
      if (
        requestedGen !== loadGen ||
        requestedId !== currentModelId ||
        requestedMethod !== thicknessState.method ||
        !thicknessState.enabled
      )
        return // superseded: don't cache, don't recolor, don't touch the HUD
      thicknessCache.set(requestedMethod, data)
    }
    viewer.setThicknessColors(data, thicknessState.threshold)
    hudInfo.textContent = `肉厚ヒートマップ表示中（${
      requestedMethod === 'ball' ? 'ローリングボール法' : 'レイ法'
    }、赤=閾値未満）`
  } catch (e) {
    if (requestedGen !== loadGen || requestedId !== currentModelId) return // stale failure
    thicknessState.enabled = false
    hudInfo.textContent = `肉厚計算エラー: ${e instanceof Error ? e.message : e}`
  }
}
const thicknessFolder = gui.addFolder('肉厚')
thicknessFolder.close()
thicknessFolder
  .add(thicknessState, 'enabled')
  .name('ヒートマップ')
  .listen() // reset programmatically on errors / model switch
  .onChange(() => void updateThickness())
thicknessFolder
  .add(thicknessState, 'method', { レイ法: 'ray', 'ローリングボール法': 'ball' })
  .name('方式')
  .onChange(() => void updateThickness())
thicknessFolder
  .add(thicknessState, 'threshold', 0.1, 10, 0.1)
  .name('閾値 (mm)')
  .onChange(() => void updateThickness())

// ---- sidecar persistence (auto-save, debounced)
// The pending payload is captured eagerly (target id + an entries snapshot)
// rather than re-read inside the timer, so it can be flushed synchronously on
// teardown. Otherwise, switching models within the 800ms debounce window drops
// the last edit — the timer is cleared and clearAll() wipes the entries before
// anything is written to the OLD model's sidecar.
let saveTimer: ReturnType<typeof setTimeout> | undefined
let pendingSave: { id: string; body: unknown } | undefined
// The sidecar PUT currently being written. A teardown flush must await THIS —
// not just a queued pendingSave — because a debounce-timer flush may have
// already fired the PUT and cleared pendingSave. Without it, a same-id reload
// can getSidecar() before that write lands and restore stale data.
let inFlightSave: Promise<void> = Promise.resolve()

async function flushSidecar(): Promise<void> {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  if (pendingSave) {
    const save = pendingSave
    pendingSave = undefined
    const prev = inFlightSave
    inFlightSave = (async () => {
      await prev.catch(() => {}) // preserve write ordering; ignore prior failure
      try {
        await putSidecar(save.id, save.body)
      } catch {
        /* best-effort autosave; a failed write must not block teardown */
      }
    })()
  }
  await inFlightSave
}

measureTool.onChange(() => {
  if (restoringOwner !== 0 || !currentModelId) return
  clearTimeout(saveTimer)
  pendingSave = { id: currentModelId, body: { version: 1, entries: measureTool.toJSON() } }
  saveTimer = setTimeout(() => void flushSidecar(), 800)
})

// ---- annotation input (small floating text box at the click point)
function promptAnnotation(screenX: number, screenY: number, at: THREE.Vector3): void {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'note-input'
  input.placeholder = '注記を入力しEnter'
  input.style.left = `${screenX}px`
  input.style.top = `${screenY}px`
  document.body.appendChild(input)
  input.focus()
  let closed = false
  const done = (commit: boolean) => {
    if (closed) return
    closed = true
    const text = input.value.trim()
    input.remove() // fires blur synchronously — guarded by `closed`
    if (commit && text) measureTool.addAnnotation(text, at)
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true)
    else if (e.key === 'Escape') done(false)
  })
  input.addEventListener('blur', () => done(false))
}

measureTool.onChange(() => {
  const entries = measureTool.list()
  measurePanel.classList.toggle('hidden', entries.length === 0)
  measureList.innerHTML = ''
  for (const e of entries) {
    const li = document.createElement('li')
    const span = document.createElement('span')
    span.textContent = e.label
    const del = document.createElement('button')
    del.textContent = '×'
    del.addEventListener('click', () => measureTool.remove(e.id))
    li.append(span, del)
    measureList.appendChild(li)
  }
})

// click-to-pick (suppress when the user is orbiting)
let downAt: [number, number] | null = null
viewport.addEventListener('pointerdown', (e) => {
  downAt = [e.clientX, e.clientY]
})
viewport.addEventListener('pointerup', (e) => {
  if (state.mode === 'なし' || !downAt) return
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1])
  downAt = null
  if (moved > 5 || measureTool.busy) return
  const rect = viewer.renderer.domElement.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  )
  const pick = picker.pick(ndc)
  if (!pick) return

  if (state.mode === '注記') {
    promptAnnotation(e.clientX, e.clientY, pick.point)
    return
  }

  if (!measureTool.available) {
    hudInfo.textContent = '計測はSTEP/IGESモデルのみ（メッシュ形式に真値はない）'
    return
  }
  measureTool
    .handlePick(pick)
    .then((msg) => {
      if (msg) hudInfo.textContent = msg
    })
    .catch((err) => {
      hudInfo.textContent = `計測エラー: ${err instanceof Error ? err.message : err}`
    })
})

function fmtBBox(meta: ModelMeta): string {
  const d = meta.bbox.max.map((v, i) => v - meta.bbox.min[i])
  return d.map((v) => v.toFixed(1)).join(' × ')
}

// generation token: a newer loadFile call supersedes older in-flight ones
let loadGen = 0

async function loadFile(file: File): Promise<void> {
  const gen = ++loadGen
  hudInfo.textContent = `読み込み中: ${file.name} ...`

  try {
    const meta = await uploadModel(file)
    if (gen !== loadGen) return // superseded by a newer load

    // --- teardown of the previous model -----------------------------------
    // ORDER MATTERS (sidecar corruption hazard):
    // 1. FLUSH any pending debounced save to the OLD model and AWAIT it — for a
    //    deduped/same-id reload the PUT must land before the getSidecar() below,
    //    or the GET races ahead and restores a sidecar missing the just-entered
    //    edit (which a later save then persists over)
    // 2. restoring=true so teardown emits can't schedule new saves
    // 3. only then swap currentModelId and clear tools
    await flushSidecar()
    if (gen !== loadGen) return // flush await yielded — a newer load may have won
    restoringOwner = gen
    try {
      currentModelId = meta.id
      measureTool.clearAll()
      thicknessCache.clear()
      thicknessState.enabled = false
      viewer.clearThicknessColors()
      // Clear the stale 3D scene for BOTH branches: while the new model's
      // fetch is in flight (or if it fails), the old geometry must not stay
      // visible and pickable — clicks on it would be saved under the NEW
      // model's sidecar with the old model's coordinates.
      viewer.clearModel()
      picker.setModel([])
      treeBody.replaceChildren()
      treePanel.classList.add('hidden')

      if (meta.format === 'drawing') {
        const svg = await fetchDrawingSvg(meta.id)
        if (gen !== loadGen) return
        sectionTool.enabled = false
        sectionTool.update()
        drawing2d.load(svg, meta.snapPoints ?? [])
        show2D(true)
        const d = meta.bbox2d
          ? meta.bbox2d.max.map((v, i) => (v - meta.bbox2d!.min[i]).toFixed(1)).join(' × ')
          : '?'
        hudInfo.textContent = `${meta.name} — 2D図面, ${d} (計測モードで端点/中心スナップ)`
        return
      }

      show2D(false)
      const pack = await fetchMesh(meta.id)
      if (gen !== loadGen) return
      const model = toModelData(pack)
      viewer.setModel(model)
      picker.setModel(model.parts)
      measureTool.setModel(meta.id, meta.format === 'brep')
      sectionTool.setModelBBox(meta.bbox.min, meta.bbox.max)

      // restore persisted measurements / annotations
      const sidecar = await getSidecar(meta.id)
      if (gen !== loadGen) return
      const entries = (sidecar.entries ?? []) as EntryData[]
      if (entries.length) measureTool.restore(entries)

      if (model.parts.length > 1 || model.parts[0]?.faceRanges.length) {
        renderTree(treeBody, model.tree, (partId, visible) =>
          viewer.setPartVisible(partId, visible),
        )
        treePanel.classList.remove('hidden')
      } else {
        treePanel.classList.add('hidden')
      }

      const partInfo = meta.partCount > 1 ? `${meta.partCount} parts, ` : ''
      hudInfo.textContent =
        `${meta.name} — ${partInfo}${meta.triangleCount.toLocaleString()} tris, ` +
        `サイズ ${fmtBBox(meta)} (単位はファイル依存)`
    } finally {
      // release only our own claim: a newer load may have taken ownership
      if (restoringOwner === gen) restoringOwner = 0
    }
  } catch (e) {
    hudInfo.textContent = `エラー: ${e instanceof Error ? e.message : e}`
  }
}

// --- drag & drop ---
let dragDepth = 0
window.addEventListener('dragenter', (e) => {
  e.preventDefault()
  dragDepth++
  dropzone.classList.remove('hidden')
})
window.addEventListener('dragleave', () => {
  dragDepth--
  if (dragDepth <= 0) {
    dragDepth = 0
    dropzone.classList.add('hidden')
  }
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  dropzone.classList.add('hidden')
  const file = e.dataTransfer?.files[0]
  if (file) void loadFile(file)
})

// E2E test hooks
const testHooks = window as unknown as Record<string, unknown>
testHooks.__cadProject = (x: number, y: number, z: number) => {
  const v = new THREE.Vector3(x, y, z).project(viewer.camera)
  const rect = viewer.renderer.domElement.getBoundingClientRect()
  return {
    x: rect.left + ((v.x + 1) / 2) * rect.width,
    y: rect.top + ((1 - v.y) / 2) * rect.height,
  }
}
// spike検証用: 2D図面のスナップ計測モードをUIのlil-guiセレクトに依らず直接切替
testHooks.__cadSet2DMeasureMode = (on: boolean) => {
  drawing2d.measureMode = on
}
testHooks.__cadStallMeasure = (ms: number) => __stallNextMeasure(ms)
testHooks.__cadStallSidecar = (ms: number) => __stallNextSidecar(ms)
testHooks.__cadStallLoad = (ms: number) => __stallNextLoad(ms)
// spike検証用: 2つの面ID間の真値距離を直接測る（ピクセルピック非依存の計測実証）
testHooks.__cadFaceDistance = async (idA: number, idB: number) => {
  if (!currentModelId) return null
  const { measureDistance } = await import('./api')
  return measureDistance(
    currentModelId,
    { partId: 0, kind: 'face', id: idA },
    { partId: 0, kind: 'face', id: idB },
  )
}
// spike検証用: 肉厚計算を直接叩く（UIのトグル操作非依存の実証）
testHooks.__cadThickness = async (method: 'ray' | 'ball') => {
  if (!currentModelId) return null
  const { fetchThickness } = await import('./api')
  const map = await fetchThickness(currentModelId, method)
  const out: Record<string, number[]> = {}
  for (const [partId, arr] of map) out[String(partId)] = Array.from(arr)
  return out
}
testHooks.__cadPick = (clientX: number, clientY: number) => {
  const rect = viewer.renderer.domElement.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  )
  const r = picker.pick(ndc)
  return r ? { partId: r.partId, kind: r.kind, id: r.id, point: r.point.toArray() } : null
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file) void loadFile(file)
  fileInput.value = ''
})
