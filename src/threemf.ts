/**
 * 3MF ローダー（OCCT を経由しない純JS経路）。
 *
 * OCCT には 3MF の読込手段が無い（本家 backend も trimesh 任せで OCCT を通さない）。
 * 3MF はパラメトリック面を持たない三角形メッシュ形式なので、この経路の出力は
 * 最初から format='mesh' 固定・真値計測（BRepExtrema/GProp）は成立しない —
 * occt.ts の STL 経路と同じ扱いで、本家 backend の mesh ルートと挙動を揃える。
 *
 * 対応範囲: <object><mesh>の頂点/三角形、<components>のネスト参照、
 * <item transform="...">/<component transform="...">の3x4アフィン変換合成。
 * 複数オブジェクトは全て単一パートへ平坦化する（本家 backend の
 * to_mesh() 相当。アセンブリツリー分割は今回のスコープ外）。
 */
import type { MeshPack } from './meshpack'
import type { ModelMeta } from './api'
import { unzip } from './zip'

interface Loaded3mf {
  id: string
  name: string
  bbox: { min: number[]; max: number[] }
  triangleCount: number
  vertexCount: number
  meshPack: MeshPack
}

const _models = new Map<string, Loaded3mf>()

async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  const arr = new Uint8Array(digest).subarray(0, 16)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

function metaOf(m: Loaded3mf): ModelMeta {
  return {
    id: m.id,
    name: m.name,
    format: 'mesh',
    vertexCount: m.vertexCount,
    triangleCount: m.triangleCount,
    partCount: 1,
    bbox: m.bbox,
  }
}

// --- 3x4 アフィン変換（3MF仕様: 行ベクトル規約、v' = [x y z 1] * M） -----------

type Mat4 = number[] // row-major 16要素

function parseTransform(s: string | null): Mat4 | null {
  if (!s) return null
  const v = s.trim().split(/\s+/).map(Number)
  if (v.length !== 12 || v.some((n) => Number.isNaN(n))) return null
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11] = v
  // 3MF の12値は行ベクトル規約の4x3行列（最終列は暗黙に[0,0,0,1]）。
  return [m0, m1, m2, 0, m3, m4, m5, 0, m6, m7, m8, 0, m9, m10, m11, 1]
}

/** Inner を先に適用し、その後 Outer を適用する合成（行ベクトル規約: Inner*Outer）。 */
function composeMat(outer: Mat4 | null, inner: Mat4 | null): Mat4 | null {
  if (!outer) return inner
  if (!inner) return outer
  const a = inner
  const b = outer
  const r = new Array<number>(16).fill(0)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j]
      r[i * 4 + j] = s
    }
  }
  return r
}

function applyMat(x: number, y: number, z: number, m: Mat4 | null): [number, number, number] {
  if (!m) return [x, y, z]
  return [
    x * m[0] + y * m[4] + z * m[8] + m[12],
    x * m[1] + y * m[5] + z * m[9] + m[13],
    x * m[2] + y * m[6] + z * m[10] + m[14],
  ]
}

/** 平行移動を除いた線形部(左上3x3)の行列式。負なら鏡映変換（ミラー）。 */
function determinant3x3(m: Mat4 | null): number {
  if (!m) return 1
  return (
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2] * (m[4] * m[9] - m[5] * m[8])
  )
}

// --- 3MF XML パース -----------------------------------------------------

interface ObjectDef {
  vertices: [number, number, number][]
  triangles: [number, number, number][]
  components: { objectId: string; transform: Mat4 | null }[]
}

async function findModelXmlBytes(entries: Map<string, Uint8Array>): Promise<Uint8Array> {
  // 正攻法: _rels/.rels の Relationship(Type に "3dmodel" を含む) の Target を辿る。
  const rels = entries.get('_rels/.rels')
  if (rels) {
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(rels), 'application/xml')
    const rel = Array.from(doc.getElementsByTagName('Relationship')).find((r) =>
      /3dmodel/i.test(r.getAttribute('Type') ?? ''),
    )
    const target = rel?.getAttribute('Target')?.replace(/^\//, '')
    if (target) {
      const hit = entries.get(target)
      if (hit) return hit
    }
  }
  // フォールバック: 拡張子 .model のエントリを探す。
  for (const [name, data] of entries) {
    if (name.toLowerCase().endsWith('.model')) return data
  }
  throw new Error('3MF: 3dmodel.model が見つからない（不正な3MFファイル）')
}

export async function load3mf(bytes: Uint8Array, name: string): Promise<ModelMeta> {
  const id = `t${await contentHash(bytes)}`
  const cached = _models.get(id)
  if (cached) {
    evictOthers(id)
    return metaOf(cached)
  }

  const entries = await unzip(bytes)
  const modelBytes = await findModelXmlBytes(entries)
  const xml = new TextDecoder().decode(modelBytes)
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('3MF: XML解析に失敗（ファイル破損）')
  }

  const objects = new Map<string, ObjectDef>()
  for (const objEl of Array.from(doc.getElementsByTagName('object'))) {
    const objId = objEl.getAttribute('id')
    if (!objId) continue
    const vertices: [number, number, number][] = []
    const triangles: [number, number, number][] = []
    const meshEl = objEl.getElementsByTagName('mesh')[0]
    if (meshEl) {
      const vEls = meshEl.getElementsByTagName('vertices')[0]?.getElementsByTagName('vertex') ?? []
      for (const v of Array.from(vEls)) {
        vertices.push([Number(v.getAttribute('x')), Number(v.getAttribute('y')), Number(v.getAttribute('z'))])
      }
      const tEls = meshEl.getElementsByTagName('triangles')[0]?.getElementsByTagName('triangle') ?? []
      for (const t of Array.from(tEls)) {
        triangles.push([Number(t.getAttribute('v1')), Number(t.getAttribute('v2')), Number(t.getAttribute('v3'))])
      }
    }
    const components: ObjectDef['components'] = []
    const compEls = objEl.getElementsByTagName('components')[0]?.getElementsByTagName('component') ?? []
    for (const c of Array.from(compEls)) {
      const oid = c.getAttribute('objectid')
      if (oid) components.push({ objectId: oid, transform: parseTransform(c.getAttribute('transform')) })
    }
    objects.set(objId, { vertices, triangles, components })
  }

  const items: { objectId: string; transform: Mat4 | null }[] = []
  const buildEl = doc.getElementsByTagName('build')[0]
  for (const itemEl of Array.from(buildEl?.getElementsByTagName('item') ?? [])) {
    const oid = itemEl.getAttribute('objectid')
    if (oid) items.push({ objectId: oid, transform: parseTransform(itemEl.getAttribute('transform')) })
  }
  if (items.length === 0) {
    // <build> が空/欠落した非標準ファイルへのフォールバック: 全トップレベルobjectを採用。
    for (const oid of objects.keys()) items.push({ objectId: oid, transform: null })
  }

  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  let vertOffset = 0
  let triOffset = 0

  function emit(objectId: string, transform: Mat4 | null, depth: number): void {
    if (depth > 16) throw new Error('3MF: components の参照が深すぎる（循環参照の疑い）')
    const obj = objects.get(objectId)
    if (!obj) return
    if (obj.vertices.length > 0 && obj.triangles.length > 0) {
      const world = obj.vertices.map(([x, y, z]) => applyMat(x, y, z, transform))
      // 3MF Core Spec §3.3: 変換は体積の符号を変えてはならない規約だが、鏡映
      // （行列式が負）が実際に使われた場合、頂点座標だけ変換して巻き順を
      // そのままにすると法線が内側を向く。b/cを入れ替えて巻き順ごと反転する。
      const mirrored = determinant3x3(transform) < 0
      const faceNormals: [number, number, number][] = obj.vertices.map(() => [0, 0, 0])
      for (const [a, b0, c0] of obj.triangles) {
        const [b, c] = mirrored ? [c0, b0] : [b0, c0]
        if (a >= world.length || b >= world.length || c >= world.length) continue
        indices.push(vertOffset + a, vertOffset + b, vertOffset + c)
        const [ax, ay, az] = world[a]
        const [bx, by, bz] = world[b]
        const [cx, cy, cz] = world[c]
        const ux = bx - ax, uy = by - ay, uz = bz - az
        const vx = cx - ax, vy = cy - ay, vz = cz - az
        const nx = uy * vz - uz * vy
        const ny = uz * vx - ux * vz
        const nz = ux * vy - uy * vx
        for (const vi of [a, b, c]) {
          faceNormals[vi][0] += nx
          faceNormals[vi][1] += ny
          faceNormals[vi][2] += nz
        }
      }
      for (let i = 0; i < world.length; i++) {
        positions.push(...world[i])
        const [nx, ny, nz] = faceNormals[i]
        const len = Math.hypot(nx, ny, nz) || 1
        normals.push(nx / len, ny / len, nz / len)
      }
      vertOffset += world.length
      triOffset += obj.triangles.length
    }
    for (const comp of obj.components) {
      emit(comp.objectId, composeMat(transform, comp.transform), depth + 1)
    }
  }

  for (const item of items) emit(item.objectId, item.transform, 0)

  if (triOffset === 0) throw new Error('3MF: 三角形データが見つからない（空または非対応の内容）')

  const posArr = new Float32Array(positions)
  const nrmArr = new Float32Array(normals)
  const idxArr = new Uint32Array(indices)

  let min = [Infinity, Infinity, Infinity]
  let max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < posArr.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = posArr[i + a]
      if (v < min[a]) min[a] = v
      if (v > max[a]) max[a] = v
    }
  }
  if (!Number.isFinite(min[0])) {
    min = [0, 0, 0]
    max = [0, 0, 0]
  }

  const desc = (dtype: 'float32' | 'uint32', count: number) => ({
    offset: 0,
    byteLength: count * 4,
    count,
    dtype,
    itemSize: 1,
  })

  const meshPack: MeshPack = {
    header: {
      buffers: {
        'p0:positions': desc('float32', posArr.length),
        'p0:normals': desc('float32', nrmArr.length),
        'p0:indices': desc('uint32', idxArr.length),
        'p0:edges': desc('float32', 0),
        'p0:vertices': desc('float32', 0),
      },
      parts: [
        {
          id: 0,
          name,
          color: null,
          faceRanges: [] as { faceId: number; triStart: number; triCount: number }[],
          edgeRanges: [] as { edgeId: number; segStart: number; segCount: number }[],
        },
      ],
      tree: { name, partId: 0 },
    },
    buffers: {
      'p0:positions': posArr,
      'p0:normals': nrmArr,
      'p0:indices': idxArr,
      'p0:edges': new Float32Array(0),
      'p0:vertices': new Float32Array(0),
    },
  } as unknown as MeshPack

  const model: Loaded3mf = {
    id,
    name,
    bbox: { min, max },
    triangleCount: triOffset,
    vertexCount: vertOffset,
    meshPack,
  }
  _models.set(id, model)
  evictOthers(id)
  return metaOf(model)
}

function evictOthers(keepId: string): void {
  for (const id of _models.keys()) {
    if (id !== keepId) _models.delete(id)
  }
}

export async function meshPackOf3mf(id: string): Promise<MeshPack> {
  const model = _models.get(id)
  if (!model) throw new Error(`unknown model id: ${id}`)
  return model.meshPack
}
