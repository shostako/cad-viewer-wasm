/**
 * 肉厚チェック（表示メッシュ上の頂点ごとの厚み推定）。
 *
 * backend/app/thickness.py（trimesh + embree レイキャスト）と同じ2手法を
 * three-mesh-bvh で再実装する。メッシュは表示用テッセレーション結果
 * （MeshPack の positions/normals/indices）だけを見る — B-rep には触れない
 * （本家のドキュメント通り、STEP/IGES と STL/3MF 双方で同じ経路が動く）。
 *
 * ray  — 頂点の内向き法線方向にレイを飛ばし、最初のヒットまでの距離。
 * ball — 内向き法線上に中心を置いた球が固体内部に収まる最大半径を二分探索
 *        （中心から表面までの最近傍距離 >= 半径、が「収まる」条件）。
 *        ray法の結果を探索範囲の上限（半径 <= d_ray/2）に使う。
 *
 * 罠（実ブラウザで検証済み）: `MeshBVH.raycastFirst(ray)` はデフォルトで
 * バックフェースカリングされ、レイの飛んでいく先の面がレイと同じ向き
 * （反対側の内壁）だと何もヒットしない。`THREE.DoubleSide` を明示的に渡す
 * 必要がある（three.jsのRaycasterはFrontSideをデフォルトとして扱うため）。
 * 忘れると全頂点が「ヒットなし」になり、肉厚が全部0扱いになる。
 */
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

export type ThicknessMethod = 'ray' | 'ball'

/** 頂点ごとの厚み、float32。ヒットなし/収まる球なしは0（フロント側で「データなし」扱い）。 */
export function computeVertexThickness(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  method: ThicknessMethod,
): Float32Array {
  const nVerts = positions.length / 3
  const out = new Float32Array(nVerts) // 0 = no data
  if (nVerts === 0 || indices.length === 0) return out

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  const bvh = new MeshBVH(geometry)

  // モデルスケールに追従する許容誤差（固定値ハードコード禁止 — エッジ
  // サンプリングのdeflectionで踏んだ罠と同じ教訓）
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < nVerts; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)
  const eps = Math.max(diag * 1e-5, 1e-9)

  const dRay = rayThickness(bvh, positions, normals, nVerts, eps)
  if (method === 'ray') return dRay
  return ballThickness(bvh, positions, normals, nVerts, dRay, eps)
}

function rayThickness(
  bvh: MeshBVH,
  positions: Float32Array,
  normals: Float32Array,
  nVerts: number,
  eps: number,
): Float32Array {
  const out = new Float32Array(nVerts)
  const origin = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const ray = new THREE.Ray()
  for (let i = 0; i < nVerts; i++) {
    const n = unitNormal(normals, i)
    if (!n) continue
    const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2]
    origin.set(px - n.x * eps, py - n.y * eps, pz - n.z * eps)
    dir.set(-n.x, -n.y, -n.z)
    ray.set(origin, dir)
    // DoubleSide必須（上記の罠コメント参照）。省略すると裏面ヒットが無視される。
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide)
    if (!hit) continue
    const dist = hit.distance + eps
    // レイが自分自身の面すれすれを掠めただけのヒットは無視する
    if (dist > 3 * eps) out[i] = dist
  }
  return out
}

function ballThickness(
  bvh: MeshBVH,
  positions: Float32Array,
  normals: Float32Array,
  nVerts: number,
  dRay: Float32Array,
  tol: number,
  iterations = 14,
): Float32Array {
  const out = new Float32Array(nVerts)
  const center = new THREE.Vector3()
  for (let i = 0; i < nVerts; i++) {
    const d = dRay[i]
    if (!(d > 0)) continue
    const n = unitNormal(normals, i)
    if (!n) continue
    const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2]
    let lo = 0
    let hi = d / 2
    for (let iter = 0; iter < iterations; iter++) {
      const mid = (lo + hi) / 2
      center.set(px - n.x * mid, py - n.y * mid, pz - n.z * mid)
      const info = bvh.closestPointToPoint(center)
      const dist = info ? info.distance : 0
      // 球が収まる iff 中心からの最近傍表面距離 >= 半径（自分自身の接点で
      // ちょうど等しくなる — thickness.py と同じ判定）
      if (dist >= mid - tol) lo = mid
      else hi = mid
    }
    out[i] = 2 * lo
  }
  return out
}

function unitNormal(normals: Float32Array, i: number): { x: number; y: number; z: number } | null {
  const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2]
  const len = Math.hypot(nx, ny, nz)
  if (len === 0) return null
  return { x: nx / len, y: ny / len, z: nz / len }
}
