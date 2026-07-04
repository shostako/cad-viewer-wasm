/**
 * OCCT-WASM エンジン（backend/app/tessellation.py + measure.py のブラウザ移植・スパイク版）。
 *
 * 設計原則は本家と同一 —「メッシュは表示用の嘘、計測はB-repの真実」。
 * テッセレーションした三角形には由来する faceId を付け、計測は必ず元の
 * B-rep（TopoDS_Face）に対して BRepExtrema / GProp で真値を出す。
 *
 * スパイク範囲: STEPControl_Reader（非XCAF・単一シェイプ）。面のみ。
 * アセンブリ展開・色・名前・エッジ/頂点スナップ・IGES は本移植で追加する。
 * このビルドに TopTools_IndexedMapOfShape が無いため、面インデックスは
 * TopExp_Explorer の走査順で JS 側に自前保持する（テッセレーションと計測解決で
 * 同一配列を使うので faceId は一貫する）。
 */
// パッケージの index.js は `import wasm from './...wasm'` という bare import を持ち、
// Vite の組み込み wasm ハンドラがそれを ESM 実体化しようとして import "a" 解決に失敗する。
// そこで index.js を経由せず、emscripten ファクトリを直接読み、wasm は `?url` で
// URL 文字列として受けて locateFile に渡す（Node でやったのと同じ構図のブラウザ版）。
import ocFactory from 'opencascade.js/dist/opencascade.wasm.js'
import wasmUrl from 'opencascade.js/dist/opencascade.wasm.wasm?url'
import type { MeshPack } from './meshpack'
import type { ModelMeta, EntityRef, DistanceResult, FaceInfoResult, EdgeInfoResult } from './api'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OC = any

let _oc: OC | null = null
let _initPromise: Promise<OC> | null = null

/** OCCT WASM を一度だけ初期化（数百MBのヒープを確保するので初回は重い）。 */
export function initOcct(): Promise<OC> {
  if (_oc) return Promise.resolve(_oc)
  if (!_initPromise) {
    _initPromise = ocFactory({ locateFile: () => wasmUrl as string }).then((oc: OC) => {
      _oc = oc
      return oc
    })
  }
  return _initPromise as Promise<OC>
}

interface LoadedModel {
  id: string
  name: string
  shape: OC // TopoDS_Shape
  faces: OC[] // index i (0-based) => faceId i+1 の TopoDS_Face
  bbox: { min: number[]; max: number[] }
  triangleCount: number
  vertexCount: number
  meshPack: MeshPack // load時に構築してキャッシュ
}

const _models = new Map<string, LoadedModel>()
let _idSeq = 0

function extToRoute(name: string): 'brep' | 'unsupported' {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return ext === 'step' || ext === 'stp' ? 'brep' : 'unsupported'
}

/** STEP バイト列を読み、shape と面配列を格納して ModelMeta を返す。 */
export async function loadStep(bytes: Uint8Array, name: string): Promise<ModelMeta> {
  const oc = await initOcct()
  if (extToRoute(name) !== 'brep') {
    throw new Error(`スパイクは STEP のみ対応（.step/.stp）: ${name}`)
  }

  // emscripten 仮想FSへ書き込み → STEP読込。
  //
  // 罠その1: createDataFile の canOwn=true は使うな。ブラウザ由来の Uint8Array の
  //   バッファ所有権を emscripten が奪い、OCCT が読む時点でデータが化けて
  //   ReadFile が RetError になる（Node では顕在化しない）。FS.writeFile は必ず
  //   コピーするので安全。
  // 罠その2: 仮想パスの「ベース名が長い」と STEPControl_Reader.ReadFile が
  //   0 roots を返す。実測(同一バイト)では:
  //     /b /x /a /m .step (1文字) → 成功 / /model /input /model2 .step → 失敗
  //   FS 内容は byte 一致で検証済みなのに名前長で挙動が変わる。embind/OCCT の
  //   ファイル名マーシャリングに fixed-size バッファ overflow 系のバグがある。
  //   短いベース名なら確実に回避できるので固定で '/m.step' を使う。
  const virtualPath = '/m.step'
  try {
    oc.FS.unlink(virtualPath)
  } catch {
    /* 初回は存在しない */
  }
  oc.FS.writeFile(virtualPath, bytes)
  const reader = new oc.STEPControl_Reader_1()
  reader.ReadFile(virtualPath)
  const nRoots = reader.NbRootsForTransfer()
  oc.FS.unlink(virtualPath)
  // ReadFile が返す IFSelect_ReturnStatus 列挙は embind 上で値比較が当てにならない
  // （RetDone との一致が取れない）。成否は「転送可能ルート数」で判定する。
  if (nRoots < 1) {
    throw new Error('STEP読込失敗（ファイル破損・非対応、または転送ルート無し）')
  }
  reader.TransferRoots()
  const shape = reader.OneShape()
  if (shape.IsNull()) throw new Error('STEP: 形状が空')

  // テッセレーション（線形/角度たわみ）。bbox対角の相対値で線形たわみを決める。
  const bbox = computeBBox(oc, shape)
  const diag = Math.hypot(
    bbox.max[0] - bbox.min[0],
    bbox.max[1] - bbox.min[1],
    bbox.max[2] - bbox.min[2],
  )
  const linDefl = Math.max(diag * 1e-3, 1e-6)
  new oc.BRepMesh_IncrementalMesh_2(shape, linDefl, false, 0.35, true)

  // 面を走査順に配列化（faceId = index+1）
  const faces: OC[] = []
  for (
    const exp = new oc.TopExp_Explorer_2(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    exp.More();
    exp.Next()
  ) {
    faces.push(oc.TopoDS.Face_1(exp.Current()))
  }

  const id = `m${_idSeq++}`
  const model: LoadedModel = {
    id,
    name,
    shape,
    faces,
    bbox,
    triangleCount: 0,
    vertexCount: 0,
    meshPack: undefined as unknown as MeshPack,
  }
  // メッシュを即構築してキャッシュ（三角形/頂点数を meta に載せるため）
  model.meshPack = buildMeshPack(oc, model)
  _models.set(id, model)

  return {
    id,
    name,
    format: 'brep',
    vertexCount: model.vertexCount,
    triangleCount: model.triangleCount,
    partCount: 1,
    bbox,
  }
}

function computeBBox(oc: OC, shape: OC): { min: number[]; max: number[] } {
  const box = new oc.Bnd_Box_1()
  oc.BRepBndLib.Add(shape, box, false)
  if (box.IsVoid()) return { min: [0, 0, 0], max: [0, 0, 0] }
  const lo = box.CornerMin()
  const hi = box.CornerMax()
  return { min: [lo.X(), lo.Y(), lo.Z()], max: [hi.X(), hi.Y(), hi.Z()] }
}

/** load時に構築済みの MeshPack を返す。 */
export async function meshPackOf(id: string): Promise<MeshPack> {
  const model = _models.get(id)
  if (!model) throw new Error(`unknown model id: ${id}`)
  return model.meshPack
}

/**
 * テッセレーション結果を MeshPack 形状のオブジェクトとして直接組む
 * （backend のバイナリ往復は不要。parseMeshPack と同じ {header, buffers}）。
 * 単一パート（id=0）。positions/normals は面ごとに頂点複製、indices は面ごと連続。
 * 法線は三角形の巻き順から自前計算（このビルドに法線ヘルパーが無いため）。
 * shape は BRepMesh_IncrementalMesh 済みが前提（loadStep 内で実行済み）。
 */
function buildMeshPack(oc: OC, model: LoadedModel): MeshPack {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const faceRanges: { faceId: number; triStart: number; triCount: number }[] = []
  let vertOffset = 0
  let triOffset = 0

  for (let fi = 0; fi < model.faces.length; fi++) {
    const face = model.faces[fi]
    const loc = new oc.TopLoc_Location_1()
    const triHandle = oc.BRep_Tool.Triangulation(face, loc)
    if (triHandle.IsNull()) continue
    const tri = triHandle.get()
    const nNodes: number = tri.NbNodes()
    const nTris: number = tri.NbTriangles()
    if (nTris === 0) continue

    const trsf = loc.Transformation()

    // ノード座標（ロケーション変換適用）
    const nodeXYZ = new Float32Array(nNodes * 3)
    for (let i = 1; i <= nNodes; i++) {
      const p = tri.Node(i).Transformed(trsf)
      nodeXYZ[(i - 1) * 3] = p.X()
      nodeXYZ[(i - 1) * 3 + 1] = p.Y()
      nodeXYZ[(i - 1) * 3 + 2] = p.Z()
    }

    // 三角形 → インデックス（1-based → 0-based）。巻き順から法線を積算。
    const nodeNormals = new Float32Array(nNodes * 3)
    const faceTris: [number, number, number][] = []
    for (let i = 1; i <= nTris; i++) {
      const t = tri.Triangle(i)
      const a = t.Value(1) - 1
      const b = t.Value(2) - 1
      const c = t.Value(3) - 1
      faceTris.push([a, b, c])
      // 面法線（外積）を3頂点に加算（面内スムーズ法線）
      const ax = nodeXYZ[a * 3], ay = nodeXYZ[a * 3 + 1], az = nodeXYZ[a * 3 + 2]
      const bx = nodeXYZ[b * 3], by = nodeXYZ[b * 3 + 1], bz = nodeXYZ[b * 3 + 2]
      const cx = nodeXYZ[c * 3], cy = nodeXYZ[c * 3 + 1], cz = nodeXYZ[c * 3 + 2]
      const ux = bx - ax, uy = by - ay, uz = bz - az
      const vx = cx - ax, vy = cy - ay, vz = cz - az
      const nx = uy * vz - uz * vy
      const ny = uz * vx - ux * vz
      const nz = ux * vy - uy * vx
      for (const vi of [a, b, c]) {
        nodeNormals[vi * 3] += nx
        nodeNormals[vi * 3 + 1] += ny
        nodeNormals[vi * 3 + 2] += nz
      }
    }
    // 正規化
    for (let i = 0; i < nNodes; i++) {
      const nx = nodeNormals[i * 3], ny = nodeNormals[i * 3 + 1], nz = nodeNormals[i * 3 + 2]
      const len = Math.hypot(nx, ny, nz) || 1
      nodeNormals[i * 3] = nx / len
      nodeNormals[i * 3 + 1] = ny / len
      nodeNormals[i * 3 + 2] = nz / len
    }

    for (let i = 0; i < nNodes * 3; i++) {
      positions.push(nodeXYZ[i])
      normals.push(nodeNormals[i])
    }
    for (const [a, b, c] of faceTris) {
      indices.push(a + vertOffset, b + vertOffset, c + vertOffset)
    }
    faceRanges.push({ faceId: fi + 1, triStart: triOffset, triCount: nTris })
    vertOffset += nNodes
    triOffset += nTris
  }

  model.triangleCount = triOffset
  model.vertexCount = vertOffset

  const posArr = new Float32Array(positions)
  const nrmArr = new Float32Array(normals)
  const idxArr = new Uint32Array(indices)
  const edgeArr = new Float32Array(0) // スパイク: エッジ線は後回し
  const vertArr = new Float32Array(0) // スパイク: 頂点スナップは後回し

  // parseMeshPack が返すのと同じ形。BufferDesc の offset/byteLength は本経路では
  // 未使用（buffers を直接 typed array で持つ）だが型を満たすため埋める。
  const buffers: Record<string, Float32Array | Uint32Array> = {
    'p0:positions': posArr,
    'p0:normals': nrmArr,
    'p0:indices': idxArr,
    'p0:edges': edgeArr,
    'p0:vertices': vertArr,
  }
  const header = {
    buffers: {
      'p0:positions': desc('float32', posArr.length),
      'p0:normals': desc('float32', nrmArr.length),
      'p0:indices': desc('uint32', idxArr.length),
      'p0:edges': desc('float32', edgeArr.length),
      'p0:vertices': desc('float32', vertArr.length),
    },
    parts: [
      {
        id: 0,
        name: model.name,
        color: null,
        faceRanges,
        edgeRanges: [] as { edgeId: number; segStart: number; segCount: number }[],
      },
    ],
    tree: { name: model.name, partId: 0 },
  }
  return { header, buffers } as unknown as MeshPack
}

function desc(dtype: 'float32' | 'uint32', count: number) {
  return {
    offset: 0,
    byteLength: count * (dtype === 'float32' ? 4 : 4),
    count,
    dtype,
    itemSize: 1,
  }
}

// -------------------------------------------------------------- 計測（真値）

function resolveShape(oc: OC, model: LoadedModel, ref: EntityRef): OC {
  if (ref.kind === 'point' && ref.xyz) {
    return new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt_3(ref.xyz[0], ref.xyz[1], ref.xyz[2])).Vertex()
  }
  if (ref.kind === 'face' && ref.id) {
    const f = model.faces[ref.id - 1]
    if (!f) throw new Error(`face id ${ref.id} out of range`)
    return f
  }
  // エッジ/頂点はスパイク未対応（picking も現状 face のみ返す）
  throw new Error(`スパイク未対応の参照種別: ${ref.kind}`)
}

/** 2エンティティ間の最短距離（BRepExtrema、真値）。 */
export async function distance(id: string, a: EntityRef, b: EntityRef): Promise<DistanceResult> {
  const oc = await initOcct()
  const model = _models.get(id)
  if (!model) throw new Error(`unknown model id: ${id}`)
  const sa = resolveShape(oc, model, a)
  const sb = resolveShape(oc, model, b)
  const ext = new oc.BRepExtrema_DistShapeShape_2(
    sa,
    sb,
    oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
    oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
  )
  if (!ext.IsDone() || ext.NbSolution() < 1) throw new Error('距離計算に失敗')
  const pa = ext.PointOnShape1(1)
  const pb = ext.PointOnShape2(1)
  return {
    type: 'distance',
    value: ext.Value(),
    pointA: [pa.X(), pa.Y(), pa.Z()],
    pointB: [pb.X(), pb.Y(), pb.Z()],
  }
}

/** 面情報: 面積 + 円筒(穴/ボス)半径・軸 or 平面法線。 */
export async function faceInfo(id: string, ref: EntityRef): Promise<FaceInfoResult> {
  const oc = await initOcct()
  const model = _models.get(id)
  if (!model) throw new Error(`unknown model id: ${id}`)
  const face = oc.TopoDS.Face_1(resolveShape(oc, model, ref))

  const props = new oc.GProp_GProps_1()
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false)
  const out: FaceInfoResult = { type: 'face', area: props.Mass(), surface: 'unknown' }

  const surf = new oc.BRepAdaptor_Surface_2(face, true)
  const stype = surf.GetType().value // 列挙は singleton だが value 比較で確実に
  if (stype === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) {
    const cyl = surf.Cylinder()
    const c = cyl.Location()
    const ax = cyl.Axis().Direction()
    out.surface = 'cylinder'
    out.radius = cyl.Radius()
    out.diameter = 2 * cyl.Radius()
    out.center = [c.X(), c.Y(), c.Z()]
    out.axis = [ax.X(), ax.Y(), ax.Z()]
  } else if (stype === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value) {
    const pln = surf.Plane()
    const n = pln.Axis().Direction()
    out.surface = 'plane'
    out.normal = [n.X(), n.Y(), n.Z()]
  }
  return out
}

/** エッジ情報: スパイクでは picking がエッジを返さないため未使用。契約維持のため実装。 */
export async function edgeInfo(_id: string, _ref: EntityRef): Promise<EdgeInfoResult> {
  throw new Error('エッジ計測はスパイク未対応')
}
