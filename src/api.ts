/**
 * cad-viewer-wasm のデータ層。
 *
 * 元 cad-viewer では fetch で WSL の FastAPI backend を叩いていた。ここでは
 * 同じシグネチャのまま中身をブラウザ内の OCCT-WASM エンジン(occt.ts)へ委譲する。
 * この api.ts だけが唯一の継ぎ目(seam)で、main/viewer/picking/measure は
 * データ源が Python サーバか WASM かを知らずに動く。
 *
 * OCCT-WASM(occt.ts、数百MBのヒープを確保する)は Web Worker(occt.worker.ts)
 * に隔離し、Comlink経由のRPCで呼ぶ（UIスレッドをブロックしないため）。
 * 3MF(threemf.ts)・DXF(dxf.ts)は軽量な純JSなのでメインスレッドのまま。
 *
 * サイドカー(計測の永続化)は localStorage に置く（backend もサーバも不要）。
 */
import type { MeshPack } from './meshpack'
import * as Comlink from 'comlink'
import type { OcctWorkerApi } from './occt.worker'
import { load3mf, meshPackOf3mf, disposeAll as disposeAllThreeMf } from './threemf'
import { loadDxf, svgOf, disposeAll as disposeAllDxf } from './dxf'
import { computeVertexThickness } from './thickness'

// OCCT-WASM（数百MBのヒープを確保する重いエンジン）はUIスレッドをブロック
// しないよう Web Worker に隔離する（README記載の設計目標）。3MF/DXFの
// パーサは軽量な純JSなのでメインスレッドのまま（occt.worker.ts参照）。
const occtWorker = Comlink.wrap<OcctWorkerApi>(
  new Worker(new URL('./occt.worker.ts', import.meta.url), { type: 'module' }),
)

export interface ModelMeta {
  id: string
  name: string
  format: string
  vertexCount: number
  triangleCount: number
  partCount: number
  cached?: boolean
  bbox: { min: number[]; max: number[] }
  bbox2d?: { min: [number, number]; max: [number, number] }
  snapPoints?: { dxf: [number, number]; svg: [number, number]; kind: string }[]
}

export async function fetchDrawingSvg(modelId: string): Promise<string> {
  return svgOf(modelId)
}

// test-only: 次のOCCT読込(occt.ts内のloadModel、gen採番の直後)だけ人為的に
// 遅延させる。2つのアップロードが重なった時の世代ガード（occt.ts の
// _loadGen）を決定的に再現するためのフック（既存の __stallNextMeasure と
// 同じ流儀）。Worker側(occt.ts)のgen採番後に遅延させる必要があるため、
// api.ts側でRPC呼び出し前に遅延させるのではなく、occtWorker自身に委譲する。
export function __stallNextLoad(ms: number): Promise<void> {
  return occtWorker.__stallNextLoad(ms)
}

export async function uploadModel(file: File): Promise<ModelMeta> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const lower = file.name.toLowerCase()
  // 3MF/DXF は OCCT に読込手段が無い（3MF）か WASM化不可（DWG、DXFのみ純JSで
  // 対応）ため専用の純JS経路へ分岐する。モデルIDのプレフィックス
  // （occt.ts='m', threemf.ts='t', dxf.ts='d'）で fetchMesh/fetchDrawingSvg
  // 側の参照先レジストリを判定する。
  //
  // 罠(Codexレビュー指摘、3MF追加時に発覚): 各ローダーは自分のレジストリ内
  // でしか evictOthers しないため、形式を跨いで切り替える（STEP→3MF→STEP...）
  // と前の形式のモデルが「もう一方」のレジストリに残り続ける。OCCT側は embind
  // オブジェクトがGCされずWASMヒープを圧迫し続けるため実害が大きい。新モデルの
  // パース成功後に他の全レジストリを破棄する（occt.ts自身の「成功後に破棄」
  // 規律と同じ順序）。DXF追加でレジストリが3つになったので同じ規律を踏襲する。
  if (lower.endsWith('.dwg')) {
    throw new Error('DWGはこのビルドでは未対応（ODA File ConverterはWASM化不可・非再配布のネイティブバイナリ）。DXFなら対応')
  }
  if (lower.endsWith('.dxf')) {
    const meta = await loadDxf(bytes, file.name)
    // Codexレビュー指摘: occtWorker.disposeAll()をawaitすると、OCCT Workerが
    // 大きいSTEP/STLの重い同期パース中はそのRPCがキューの後ろで詰まり、
    // 既にパース完了しているDXF/3MFの表示までブロックされてしまう
    // （Worker化でUIスレッドは守れても、Worker自体がビジーだと「切替」操作が
    // 巻き込まれる）。破棄はメモリ解放のみが目的で戻り値のmetaに影響しない
    // ため、待たずに投げっぱなしにする。
    void occtWorker.disposeAll().catch(() => {})
    disposeAllThreeMf()
    return meta
  }
  if (lower.endsWith('.3mf')) {
    const meta = await load3mf(bytes, file.name)
    void occtWorker.disposeAll().catch(() => {})
    disposeAllDxf()
    return meta
  }
  const meta = await occtWorker.loadModel(bytes, file.name)
  disposeAllThreeMf()
  disposeAllDxf()
  return meta
}

export async function fetchMesh(modelId: string): Promise<MeshPack> {
  if (modelId.startsWith('t')) return meshPackOf3mf(modelId)
  return occtWorker.meshPackOf(modelId)
}

export interface EntityRef {
  partId?: number
  kind: 'face' | 'edge' | 'vertex' | 'point'
  id?: number
  xyz?: [number, number, number]
}

export interface DistanceResult {
  type: 'distance'
  value: number
  pointA: [number, number, number]
  pointB: [number, number, number]
}

export interface EdgeInfoResult {
  type: 'edge'
  length: number
  curve: string
  radius?: number
  diameter?: number
  center?: [number, number, number]
  axis?: [number, number, number]
}

export interface FaceInfoResult {
  type: 'face'
  area: number
  surface: string
  radius?: number
  diameter?: number
  center?: [number, number, number]
  axis?: [number, number, number]
  normal?: [number, number, number]
}

// test-only: hold the NEXT distance request in flight (measure-mode cancel test)
let _stallNextMeasureMs = 0
export function __stallNextMeasure(ms: number): void {
  _stallNextMeasureMs = ms
}

export async function measureDistance(modelId: string, a: EntityRef, b: EntityRef) {
  if (_stallNextMeasureMs > 0) {
    const ms = _stallNextMeasureMs
    _stallNextMeasureMs = 0
    await new Promise((r) => setTimeout(r, ms))
  }
  return occtWorker.distance(modelId, a, b)
}

export function measureEdgeInfo(modelId: string, ref: EntityRef) {
  return occtWorker.edgeInfo(modelId, ref)
}

export function measureFaceInfo(modelId: string, ref: EntityRef) {
  return occtWorker.faceInfo(modelId, ref)
}

/**
 * 肉厚チェック。表示メッシュ（MeshPack の positions/normals/indices）に対して
 * three-mesh-bvh でレイ法/ローリングボール法を計算する（backend/thickness.py
 * のtrimesh実装と同じアルゴリズム、詳細は thickness.ts 参照）。B-repではなく
 * 表示メッシュを見るため、STEP/IGES(brep)・STL/3MF(mesh) いずれでも同じ経路で動く。
 * 現状パートは常に単一(id=0)だが、将来のアセンブリ対応（XCAF、現状は保留中）に
 * 備えて header.parts を汎用的に走査する。
 */
export async function fetchThickness(
  modelId: string,
  method: 'ray' | 'ball' = 'ray',
): Promise<Map<number, Float32Array>> {
  const pack = await fetchMesh(modelId)
  const out = new Map<number, Float32Array>()
  for (const part of pack.header.parts as { id: number }[]) {
    const positions = pack.buffers[`p${part.id}:positions`] as Float32Array | undefined
    const normals = pack.buffers[`p${part.id}:normals`] as Float32Array | undefined
    const indices = pack.buffers[`p${part.id}:indices`] as Uint32Array | undefined
    if (!positions || !normals || !indices) continue
    out.set(part.id, computeVertexThickness(positions, normals, indices, method))
  }
  return out
}

// --- サイドカー永続化: localStorage ---------------------------------------
const SIDECAR_PREFIX = 'cad-viewer-wasm:sidecar:'

export async function getSidecar(modelId: string): Promise<Record<string, unknown>> {
  try {
    const raw = localStorage.getItem(SIDECAR_PREFIX + modelId)
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

let _stallNextSidecarMs = 0
export function __stallNextSidecar(ms: number): void {
  _stallNextSidecarMs = ms
}

export async function putSidecar(modelId: string, body: unknown): Promise<void> {
  if (_stallNextSidecarMs > 0) {
    const ms = _stallNextSidecarMs
    _stallNextSidecarMs = 0
    await new Promise((r) => setTimeout(r, ms))
  }
  try {
    localStorage.setItem(SIDECAR_PREFIX + modelId, JSON.stringify(body))
  } catch {
    /* best-effort */
  }
}
