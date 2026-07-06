/**
 * cad-viewer-wasm のデータ層。
 *
 * 元 cad-viewer では fetch で WSL の FastAPI backend を叩いていた。ここでは
 * 同じシグネチャのまま中身をブラウザ内の OCCT-WASM エンジン(occt.ts)へ委譲する。
 * この api.ts だけが唯一の継ぎ目(seam)で、main/viewer/picking/measure は
 * データ源が Python サーバか WASM かを知らずに動く。
 *
 * サイドカー(計測の永続化)は localStorage に置く（backend もサーバも不要）。
 */
import type { MeshPack } from './meshpack'
import { loadModel, meshPackOf, distance, faceInfo, edgeInfo, disposeAll as disposeAllOcct } from './occt'
import { load3mf, meshPackOf3mf, disposeAll as disposeAllThreeMf } from './threemf'
import { computeVertexThickness } from './thickness'

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

export async function fetchDrawingSvg(_modelId: string): Promise<string> {
  // 2D図面(DXF)はWASM移植の後段。スパイクでは未対応。
  throw new Error('2D図面はこのビルドでは未対応')
}

export async function uploadModel(file: File): Promise<ModelMeta> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // 3MF は OCCT に読込手段が無いため専用の純JS経路（threemf.ts）へ分岐する。
  // モデルIDのプレフィックス（occt.ts='m', threemf.ts='t'）で fetchMesh 側の
  // 参照先レジストリを判定する。
  //
  // 罠(Codexレビュー指摘): 各ローダーは自分のレジストリ内でしか evictOthers
  // しないため、形式を跨いで切り替える（STEP→3MF→STEP...）と前の形式の
  // モデルが「もう一方」のレジストリに残り続ける。OCCT側は embind オブジェクトが
  // GCされずWASMヒープを圧迫し続けるため実害が大きい。新モデルのパース成功後に
  // 反対側のレジストリを破棄する（occt.ts自身の「成功後に破棄」規律と同じ順序）。
  if (file.name.toLowerCase().endsWith('.3mf')) {
    const meta = await load3mf(bytes, file.name)
    disposeAllOcct()
    return meta
  }
  const meta = await loadModel(bytes, file.name)
  disposeAllThreeMf()
  return meta
}

export async function fetchMesh(modelId: string): Promise<MeshPack> {
  if (modelId.startsWith('t')) return meshPackOf3mf(modelId)
  return meshPackOf(modelId)
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
  return distance(modelId, a, b)
}

export function measureEdgeInfo(modelId: string, ref: EntityRef) {
  return edgeInfo(modelId, ref)
}

export function measureFaceInfo(modelId: string, ref: EntityRef) {
  return faceInfo(modelId, ref)
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
