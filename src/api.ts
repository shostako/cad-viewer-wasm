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
import { loadStep, meshPackOf, distance, faceInfo, edgeInfo } from './occt'

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
  return loadStep(bytes, file.name)
}

export async function fetchMesh(modelId: string): Promise<MeshPack> {
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

/** 肉厚: WASM移植の後段（three-mesh-bvh でレイ法を移す予定）。スパイクでは未対応。 */
export async function fetchThickness(
  _modelId: string,
  _method: 'ray' | 'ball' = 'ray',
): Promise<Map<number, Float32Array>> {
  throw new Error('肉厚チェックはこのビルドでは未対応')
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
