import { parseMeshPack, type MeshPack } from './meshpack'

export interface ModelMeta {
  id: string
  name: string
  format: string
  vertexCount: number
  triangleCount: number
  partCount: number
  cached?: boolean
  bbox: { min: number[]; max: number[] }
  // drawing (2D) payloads
  bbox2d?: { min: [number, number]; max: [number, number] }
  snapPoints?: { dxf: [number, number]; svg: [number, number]; kind: string }[]
}

export async function fetchDrawingSvg(modelId: string): Promise<string> {
  const res = await fetch(`/api/models/${modelId}/drawing.svg`)
  if (!res.ok) throw new Error(`svg fetch failed: ${res.status}`)
  return res.text()
}

export async function uploadModel(file: File): Promise<ModelMeta> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/models', { method: 'POST', body: form })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(detail.detail ?? `upload failed: ${res.status}`)
  }
  return res.json()
}

export async function fetchMesh(modelId: string): Promise<MeshPack> {
  const res = await fetch(`/api/models/${modelId}/mesh.bin`)
  if (!res.ok) throw new Error(`mesh fetch failed: ${res.status}`)
  return parseMeshPack(await res.arrayBuffer())
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

async function measureRequest<T>(modelId: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/models/${modelId}/measure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(detail.detail ?? `measure failed: ${res.status}`)
  }
  return res.json()
}

// test-only: lets an E2E hold the NEXT distance request in flight, to exercise
// measure-mode cancellation while a request is pending (one-shot, self-clearing)
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
  return measureRequest<DistanceResult>(modelId, { type: 'distance', a, b })
}

export function measureEdgeInfo(modelId: string, ref: EntityRef) {
  return measureRequest<EdgeInfoResult>(modelId, { type: 'edge_info', ref })
}

export function measureFaceInfo(modelId: string, ref: EntityRef) {
  return measureRequest<FaceInfoResult>(modelId, { type: 'face_info', ref })
}

/** Per-vertex thickness per part (0 = no data). method: ray=fast, ball=rolling ball (exact at junctions) */
export async function fetchThickness(
  modelId: string,
  method: 'ray' | 'ball' = 'ray',
): Promise<Map<number, Float32Array>> {
  const res = await fetch(`/api/models/${modelId}/thickness.bin?method=${method}`)
  if (!res.ok) throw new Error(`thickness fetch failed: ${res.status}`)
  const pack = parseMeshPack(await res.arrayBuffer())
  const out = new Map<number, Float32Array>()
  for (const [name, arr] of Object.entries(pack.buffers)) {
    const m = name.match(/^p(\d+):thickness$/)
    if (m) out.set(Number(m[1]), arr as Float32Array)
  }
  return out
}

export async function getSidecar(modelId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/models/${modelId}/sidecar`)
  if (!res.ok) return {}
  return res.json()
}

// test-only: lets an E2E hold the NEXT sidecar PUT in flight, to exercise a
// teardown flush racing a debounce-timer save (one-shot, self-clearing)
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
  await fetch(`/api/models/${modelId}/sidecar`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
