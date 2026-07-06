/**
 * OCCT-WASM エンジン（backend/app/tessellation.py + measure.py のブラウザ移植）。
 *
 * 設計原則は本家と同一 —「メッシュは表示用の嘘、計測はB-repの真実」。
 * テッセレーションした三角形には由来する faceId を付け、計測は必ず元の
 * B-rep（TopoDS_Face）に対して BRepExtrema / GProp で真値を出す。
 *
 * 対応形式:
 *   - STEP/IGES: STEPControl_Reader / IGESControl_Reader（非XCAF・単一シェイプ、面のみ）。
 *     どちらも XSControl_Reader 系の同一インターフェース
 *     （ReadFile → NbRootsForTransfer → TransferRoots → OneShape）を共有する。
 *   - STL: StlAPI_Reader。パラメトリック面を持たないため format は 'mesh' 扱いとし、
 *     本家 backend（trimesh 経由・B-rep計測なし）と挙動を揃えて計測を無効化する。
 *     3MF/OBJ/PLY は OCCT に読込手段が無く（本家も trimesh 任せで OCCT を通さない）、
 *     別途 JS 側パーサが必要 — 本ビルドは未対応。
 *
 * 未対応: アセンブリ展開・色・名前、エッジ/頂点スナップ、2D図面。
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
  format: 'brep' | 'mesh'
  shape: OC // TopoDS_Shape
  faces: OC[] // index i (0-based) => faceId i+1 の TopoDS_Face
  edges: OC[] // index i (0-based) => edgeId i+1 の TopoDS_Edge
  vertices: OC[] // index i (0-based) => vertexId i+1 の TopoDS_Vertex
  bbox: { min: number[]; max: number[] }
  triangleCount: number
  vertexCount: number
  meshPack: MeshPack // load時に構築してキャッシュ
}

const _models = new Map<string, LoadedModel>()

type Kind = 'step' | 'iges' | 'stl' | 'unsupported'

function classify(name: string): Kind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'step' || ext === 'stp') return 'step'
  if (ext === 'iges' || ext === 'igs') return 'iges'
  if (ext === 'stl') return 'stl'
  return 'unsupported'
}

const SUPPORTED_HINT = 'このビルドの対応形式: STEP(.step/.stp) / IGES(.iges/.igs) / STL(.stl)'

/** ファイル内容の SHA-256 先頭16バイトを hex で返す（モデルID＝サイドカーキーの安定化）。 */
async function contentHash(bytes: Uint8Array): Promise<string> {
  // subtle.digest は元バッファのビューでなく独立コピーを要求するので slice で渡す
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  const arr = new Uint8Array(digest).subarray(0, 16)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

function metaOf(model: LoadedModel): ModelMeta {
  return {
    id: model.id,
    name: model.name,
    format: model.format,
    vertexCount: model.vertexCount,
    triangleCount: model.triangleCount,
    partCount: 1,
    bbox: model.bbox,
  }
}

/** 現在ロード中以外の全モデルを破棄し WASM/JS メモリを解放する（OCCTヒープ枯渇の防止）。 */
function evictOthers(keepId: string): void {
  for (const [id, m] of _models) {
    if (id === keepId) continue
    disposeModel(m)
    _models.delete(id)
  }
}

/**
 * 全モデルを破棄する。3MF等 OCCT を経由しない他形式ローダーへ切り替わった際に
 * api.ts から呼ばれる（Codexレビュー指摘: 切替を跨いで前の形式の WASM 形状が
 * 破棄されず残り続けるとヒープを圧迫する）。embind オブジェクトは GC されない
 * ため、Mapをクリアするだけでは漏れる — disposeModel を必ず経由する。
 */
export function disposeAll(): void {
  for (const m of _models.values()) disposeModel(m)
  _models.clear()
}

/**
 * embind オブジェクトの一括破棄。GC されないため計測・テッセレーションの
 * ホットパスで必ず使う。実ブラウザで安全性を検証済み（下記の唯一の例外を除き、
 * 「派生オブジェクトを取り出した後に元オブジェクトを delete」しても派生側は
 * 生き続ける）:
 *   - reader.delete() は OneShape() で取り出した shape に影響しない
 *   - box.delete() は CornerMin/CornerMax の戻り値に影響しない
 *   - triHandle.delete() は .get() の戻り値(tri)に影響しない
 *   - loc.delete() は .Transformation() の戻り値(trsf)に影響しない
 *   - tri.Node(i) の戻り値は .Transformed(trsf) の戻り値を取った後に delete して良い
 *   - tri.Triangle(i) の戻り値は Value() を読んだ後に delete して良い
 *   - cyl/axis (Cylinder/Axis) は Location()/Direction() を取った後に delete して良い
 *   - 既存の永続 Face を再キャストした一時オブジェクトを delete しても、
 *     永続側（model.faces の元エントリ）は壊れない
 * 唯一の例外（実測でクラッシュ確認済み・delete 禁止）:
 *   - TopExp_Explorer.Current() の戻り値。TopoDS.Face_1() 等でキャストした「後」に
 *     Current() 側を delete すると、キャスト結果ごと WASM ヒープが破壊される
 *     （wasmTable.get(...) is not a function で無関係な後続呼び出しがクラッシュする）。
 *     Explorer 自体（ループを回し終えた後の exp）は delete して問題ない。
 */
function del(...objs: Array<OC | null | undefined>): void {
  for (const o of objs) {
    try {
      o?.delete?.()
    } catch {
      /* 破棄失敗は致命ではない */
    }
  }
}

function disposeModel(m: LoadedModel): void {
  // embind オブジェクトは GC されない。明示 delete で WASM ヒープを返す。
  try {
    m.shape?.delete?.()
    for (const f of m.faces) f?.delete?.()
    for (const e of m.edges) e?.delete?.()
    for (const v of m.vertices) v?.delete?.()
  } catch {
    /* 破棄失敗は致命ではない */
  }
}

// 仮想FSパスの罠: 「ベース名が長い」と STEPControl_Reader/IGESControl_Reader の
// ReadFile が 0 roots を返す。実測(同一バイト)では:
//   /b /x /a /m .step (1文字) → 成功 / /model /input /model2 .step → 失敗
// FS 内容は byte 一致で検証済みなのに名前長で挙動が変わる。embind/OCCT の
// ファイル名マーシャリングに fixed-size バッファ overflow 系のバグがある。
// 短いベース名なら確実に回避できるので拡張子ごとに固定パスを使う。
const VPATH: Record<'step' | 'iges' | 'stl', string> = {
  step: '/m.step',
  iges: '/m.igs',
  stl: '/m.stl',
}

/** STEP/IGES を XSControl_Reader 系の共通インターフェースで読み、shapeを返す。 */
function readXsShape(oc: OC, kind: 'step' | 'iges', bytes: Uint8Array): OC {
  const virtualPath = VPATH[kind]
  try {
    oc.FS.unlink(virtualPath)
  } catch {
    /* 初回は存在しない */
  }
  // 罠: createDataFile の canOwn=true は使うな。ブラウザ由来の Uint8Array の
  // バッファ所有権を emscripten が奪い、OCCT が読む時点でデータが化けて
  // ReadFile が RetError になる（Node では顕在化しない）。FS.writeFile は必ず
  // コピーするので安全。
  oc.FS.writeFile(virtualPath, bytes)
  const reader = kind === 'step' ? new oc.STEPControl_Reader_1() : new oc.IGESControl_Reader_1()
  try {
    reader.ReadFile(virtualPath)
    const nRoots = reader.NbRootsForTransfer()
    oc.FS.unlink(virtualPath)
    // ReadFile が返す IFSelect_ReturnStatus 列挙は embind 上で値比較が当てにならない
    // （RetDone との一致が取れない）。成否は「転送可能ルート数」で判定する。
    if (nRoots < 1) {
      throw new Error(`${kind.toUpperCase()}読込失敗（ファイル破損・非対応、または転送ルート無し）`)
    }
    reader.TransferRoots()
    const shape = reader.OneShape()
    if (shape.IsNull()) throw new Error(`${kind.toUpperCase()}: 形状が空`)
    return shape
  } finally {
    // reader 自体（WS/Model等の内部状態）は shape 抽出後は不要。del()で安全に破棄
    // できることを実測済み（shape 側には影響しない）。
    del(reader)
  }
}

/** STL を StlAPI_Reader で読む。パラメトリック面を持たないテッセレーション済み形状。 */
function readStlShape(oc: OC, bytes: Uint8Array): OC {
  const virtualPath = VPATH.stl
  try {
    oc.FS.unlink(virtualPath)
  } catch {
    /* 初回は存在しない */
  }
  oc.FS.writeFile(virtualPath, bytes)
  const shape = new oc.TopoDS_Shape()
  const reader = new oc.StlAPI_Reader()
  try {
    const ok = reader.Read(shape, virtualPath)
    oc.FS.unlink(virtualPath)
    if (!ok || shape.IsNull()) throw new Error('STL読込失敗（ファイル破損・非対応）')
    return shape
  } finally {
    del(reader)
  }
}

/** モデルファイルを読み、shape と面配列を格納して ModelMeta を返す。 */
export async function loadModel(bytes: Uint8Array, name: string): Promise<ModelMeta> {
  const oc = await initOcct()
  const kind = classify(name)
  if (kind === 'unsupported') {
    throw new Error(`未対応の形式です: ${name}\n${SUPPORTED_HINT}`)
  }

  // モデルID＝ファイル内容ハッシュ。アップロード順ではなくファイルに紐付くので
  // サイドカー(localStorage)キーが安定し、同一ファイル再アップロードで
  // 保存済み計測を取り違えない（backend の content_hash と同趣旨）。
  const id = `m${await contentHash(bytes)}`
  // 同一内容が既にロード済みなら再パースせず再利用（backend のハッシュ dedup 相当）
  const cached = _models.get(id)
  if (cached) {
    evictOthers(id)
    return metaOf(cached)
  }
  // 注意: eviction は「新モデルのパース成功後」に行う（下部）。パース前に消すと、
  // 壊れた入力で読込失敗した際に表示中の旧モデルまで _models から消え、
  // 画面に残った旧ジオメトリへのピック/計測が unknown model id で死ぬ。

  const shape =
    kind === 'stl' ? readStlShape(oc, bytes) : readXsShape(oc, kind, bytes)

  // テッセレーション（線形/角度たわみ）。
  // 罠: StlAPI_Reader は「三角形1枚ごとに独立した平面 TopoDS_Face」を作るだけで、
  // Poly_Triangulation は付与しない（テッセレーション済みではない）。STL でも
  // IncrementalMesh を走らせないと BRep_Tool.Triangulation が null になり
  // 面情報ゼロで描画が空になる。各面は元々平面なので、たわみを掛けても
  // 三角形は増えず入力ジオメトリを素直に再現する。
  const bbox = computeBBox(oc, shape)
  const diag = Math.hypot(
    bbox.max[0] - bbox.min[0],
    bbox.max[1] - bbox.min[1],
    bbox.max[2] - bbox.min[2],
  )
  const linDefl = Math.max(diag * 1e-3, 1e-6)
  const mesher = new oc.BRepMesh_IncrementalMesh_2(shape, linDefl, false, 0.35, true)
  del(mesher) // アルゴリズムオブジェクト自体は shape へ書き込み済みで用済み（実測済み）

  // 面を走査順に配列化（faceId = index+1）。
  // 罠: exp.Current() の戻り値は delete 禁止（キャストした Face 側ごと壊れる。
  // 実測でクラッシュ確認済み）。Explorer 自体はループを抜けたら delete して良い。
  const faces: OC[] = []
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  )
  for (; exp.More(); exp.Next()) {
    faces.push(oc.TopoDS.Face_1(exp.Current()))
  }
  del(exp)

  // エッジ/頂点も同じ手法で走査順に配列化（edgeId/vertexId = index+1）。
  // ピック（picking.ts の snapVertex/snapEdge）と計測（resolveShape）が同じ
  // 配列を参照するので ID の一貫性が保たれる。
  //
  // STL(kind==='stl')は対象外: StlAPI_Reader は三角形1枚ごとに独立した平面
  // Face を作る設計（README既知の性能問題）で、580k三角形級のファイルだと
  // 頂点・エッジ数がそのまま三角形数スケールになり実用にならない。STL は
  // format='mesh' で真値計測自体が無効（backend の trimesh 経路と同じ扱い）
  // なので、そもそもエッジ/頂点スナップの対象にする意味が無い。
  const edges: OC[] = []
  const vertices: OC[] = []
  if (kind !== 'stl') {
    const eexp = new oc.TopExp_Explorer_2(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    )
    for (; eexp.More(); eexp.Next()) {
      edges.push(oc.TopoDS.Edge_1(eexp.Current()))
    }
    del(eexp)

    const vexp = new oc.TopExp_Explorer_2(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_VERTEX,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    )
    for (; vexp.More(); vexp.Next()) {
      vertices.push(oc.TopoDS.Vertex_1(vexp.Current()))
    }
    del(vexp)
  }

  const model: LoadedModel = {
    id,
    name,
    // STL はパラメトリック面を持たず真値計測（BRepExtrema/GProp）が成立しないため、
    // 本家 backend の mesh 経路（trimesh・計測無効）と挙動を揃える。
    format: kind === 'stl' ? 'mesh' : 'brep',
    shape,
    faces,
    edges,
    vertices,
    bbox,
    triangleCount: 0,
    vertexCount: 0,
    meshPack: undefined as unknown as MeshPack,
  }
  // メッシュを即構築してキャッシュ（三角形/頂点数を meta に載せるため）。
  // エッジのサンプリング許容誤差(deflection)は面メッシュと同じ linDefl を使う
  // （Codexレビュー指摘: 固定値0.1だとメートル単位の小さい円弧・穴がほぼ潰れ、
  // 見た目上は曲線があるのにスナップ/計測できなくなるモデルスケール依存バグ）。
  model.meshPack = buildMeshPack(oc, model, linDefl)
  _models.set(id, model)
  // パース成功が確定してから旧モデルを破棄する（読込失敗時に表示中モデルを
  // 巻き込まないため）。瞬間的に旧+新が同居するが、正しさをメモリ最小化より優先。
  evictOthers(id)

  return metaOf(model)
}

function computeBBox(oc: OC, shape: OC): { min: number[]; max: number[] } {
  const box = new oc.Bnd_Box_1()
  try {
    oc.BRepBndLib.Add(shape, box, false)
    if (box.IsVoid()) return { min: [0, 0, 0], max: [0, 0, 0] }
    const lo = box.CornerMin()
    const hi = box.CornerMax()
    try {
      return { min: [lo.X(), lo.Y(), lo.Z()], max: [hi.X(), hi.Y(), hi.Z()] }
    } finally {
      del(lo, hi)
    }
  } finally {
    del(box)
  }
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
function buildMeshPack(oc: OC, model: LoadedModel, linDefl: number): MeshPack {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const faceRanges: { faceId: number; triStart: number; triCount: number }[] = []
  let vertOffset = 0
  let triOffset = 0

  for (let fi = 0; fi < model.faces.length; fi++) {
    const face = model.faces[fi]
    // Codexレビュー指摘(P1): 三角形分割(BRep_Tool.Triangulation)は面の下地
    // サーフェスに対して固定の巻き順で格納されており、TopAbs_REVERSED な面
    // （STEP/IGESのブーリアン演算後には普通に存在する）では実際の外向き法線が
    // 巻き順から計算した法線と逆になる。実ブラウザ確認(mini_mold.step)で
    // 隣接面がFORWARD/REVERSED混在している実例を確認済み（.value: 0=FORWARD,
    // 1=REVERSED、他の enum 比較と同じ .value パターン）。
    const reversed = face.Orientation_1().value === oc.TopAbs_Orientation.TopAbs_REVERSED.value
    const loc = new oc.TopLoc_Location_1()
    const triHandle = oc.BRep_Tool.Triangulation(face, loc)
    if (triHandle.IsNull()) {
      del(triHandle, loc)
      continue
    }
    const tri = triHandle.get()
    del(triHandle) // .get()の戻り値とは独立（実測済み）。ハンドル自体は用済み
    const nNodes: number = tri.NbNodes()
    const nTris: number = tri.NbTriangles()
    if (nTris === 0) {
      del(tri, loc)
      continue
    }

    const trsf = loc.Transformation()
    del(loc) // Transformation()の戻り値とは独立（実測済み）

    // ノード座標（ロケーション変換適用）。tri.Node(i)の生の点は変換後の点を
    // 取り出した直後に破棄する（実測済み: 変換元の破棄は変換後オブジェクトに
    // 影響しない）。頂点数スケールで最大の漏れ源だったため必ず破棄する。
    const nodeXYZ = new Float32Array(nNodes * 3)
    for (let i = 1; i <= nNodes; i++) {
      const raw = tri.Node(i)
      const p = raw.Transformed(trsf)
      del(raw)
      nodeXYZ[(i - 1) * 3] = p.X()
      nodeXYZ[(i - 1) * 3 + 1] = p.Y()
      nodeXYZ[(i - 1) * 3 + 2] = p.Z()
      del(p)
    }
    del(trsf)

    // 三角形 → インデックス（1-based → 0-based）。巻き順から法線を積算。
    const nodeNormals = new Float32Array(nNodes * 3)
    const faceTris: [number, number, number][] = []
    for (let i = 1; i <= nTris; i++) {
      const t = tri.Triangle(i)
      const a = t.Value(1) - 1
      // TopAbs_REVERSED な面は三角形分割の巻き順を下地サーフェス基準のまま
      // 保持しているため、b/cを入れ替えて実際の外向き（ソリッド外側）の
      // 巻き順に揃える。法線もこの巻き順から計算するので自動的に正しい
      // 向きになる（法線だけ反転して巻き順を放置すると、描画・ピック側で
      // 参照する三角形の表裏と法線の向きが食い違ったままになる）。
      const b = reversed ? t.Value(3) - 1 : t.Value(2) - 1
      const c = reversed ? t.Value(2) - 1 : t.Value(3) - 1
      del(t)
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
    del(tri)
  }

  model.triangleCount = triOffset
  model.vertexCount = vertOffset

  const posArr = new Float32Array(positions)
  const nrmArr = new Float32Array(normals)
  const idxArr = new Uint32Array(indices)
  const { edgeArr, edgeRanges } = buildEdges(oc, model, linDefl)
  const vertArr = buildVertices(oc, model)

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
        edgeRanges,
      },
    ],
    tree: { name: model.name, partId: 0 },
  }
  return { header, buffers } as unknown as MeshPack
}

/** vertexId 順に B-rep 頂点の真値座標を書き出す（picking.ts の snapVertex が参照）。 */
function buildVertices(oc: OC, model: LoadedModel): Float32Array {
  const out = new Float32Array(model.vertices.length * 3)
  for (let i = 0; i < model.vertices.length; i++) {
    const p = oc.BRep_Tool.Pnt(model.vertices[i])
    out[i * 3] = p.X()
    out[i * 3 + 1] = p.Y()
    out[i * 3 + 2] = p.Z()
    del(p)
  }
  return out
}

/**
 * エッジごとに独立に離散化してポリライン（線分ペア）を作る。
 *
 * 罠(実測でクラッシュ確認済み): backend の _edge_polyline は隣接面の
 * テッセレーションから PolygonOnTriangulation で「メッシュと一致する」離散化を
 * 取り出す方式だが、このWASMビルドではその手法が特定の面/エッジの組み合わせで
 * 不正なノードインデックス（範囲外の巨大な値）を返しWASMヒープを破壊する
 * （面のTriangulationをテッセレーション用とエッジ抽出用の二重に fetch/delete
 * したのが原因かと最初疑ったが、面ごとに1回のfetch/deleteへ直しても再現した —
 * PolygonOnTriangulationバインディング自体が一部ケースで信頼できない）。
 *
 * 代わりに BRepAdaptor_Curve + GCPnts_QuasiUniformDeflection でエッジ自身の
 * パラメトリック曲線を独立にサンプリングする（面のテッセレーションに一切触れない）。
 * 面メッシュの分割点と厳密に一致しない見た目上の差はあるが、エッジは
 * ピッキングの画面上スナップ候補判定にしか使わず、実測値は常に edgeInfo/distance
 * が B-rep 実体（TopoDS_Edge）から真値計算するので正確性には影響しない。
 * 60エッジ全数・全面で実ブラウザ検証しクラッシュ0件を確認済み。
 *
 * 罠(Codexレビュー指摘): サンプリング許容誤差(deflection)は固定値でなく
 * linDefl（loadModel が bbox 対角から算出、面メッシュと同じ値）を使う。
 * 固定値0.1だとメートル単位の小さい円弧・穴径の円形エッジがほぼ潰れ
 * （両端点だけ、あるいはほぼ長さ0のセグメントになる）、見た目には曲線が
 * あるのに snapEdge がそれを候補として拾えなくなる。
 */
function buildEdges(
  oc: OC,
  model: LoadedModel,
  linDefl: number,
): { edgeArr: Float32Array; edgeRanges: { edgeId: number; segStart: number; segCount: number }[] } {
  const segs: number[] = []
  const edgeRanges: { edgeId: number; segStart: number; segCount: number }[] = []
  let segOffset = 0

  for (let ei = 0; ei < model.edges.length; ei++) {
    const edge = model.edges[ei]
    const curve = new oc.BRepAdaptor_Curve_2(edge)
    // 第3引数は Continuity()（曲線の連続性）。QuasiUniformDeflectionの3引数
    // オーバーロードはこの並びを要求する（実測済み）。
    const sampler = new oc.GCPnts_QuasiUniformDeflection_2(curve, linDefl, curve.Continuity())
    if (sampler.IsDone()) {
      const n: number = sampler.NbPoints()
      if (n >= 2) {
        const pts: number[][] = []
        for (let i = 1; i <= n; i++) {
          const p = sampler.Value(i)
          pts.push([p.X(), p.Y(), p.Z()])
          del(p)
        }
        const nSegs = n - 1
        for (let i = 0; i < nSegs; i++) {
          segs.push(pts[i][0], pts[i][1], pts[i][2])
          segs.push(pts[i + 1][0], pts[i + 1][1], pts[i + 1][2])
        }
        edgeRanges.push({ edgeId: ei + 1, segStart: segOffset, segCount: nSegs })
        segOffset += nSegs
      }
    }
    del(sampler, curve)
  }

  return { edgeArr: new Float32Array(segs), edgeRanges }
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

/**
 * 参照先の shape。owned=true は呼び出し側が使用後に del() する責務を持つ
 * 一時オブジェクト（point 参照で毎回新規に作る Vertex）。owned=false は
 * model.faces から借用した永続オブジェクトで、delete 禁止（今後の計測でも
 * 使い回すため）。この区別を怠ると point 参照が漏れ続けるか、face 参照を
 * 誤って破棄して以後の計測が壊れるかのどちらかになる。
 */
interface ResolvedShape {
  shape: OC
  owned: boolean
}

function resolveShape(oc: OC, model: LoadedModel, ref: EntityRef): ResolvedShape {
  if (ref.kind === 'point' && ref.xyz) {
    const pnt = new oc.gp_Pnt_3(ref.xyz[0], ref.xyz[1], ref.xyz[2])
    const maker = new oc.BRepBuilderAPI_MakeVertex(pnt)
    const vertex = maker.Vertex()
    del(pnt, maker) // Vertex()の戻り値とは独立（実測済み）
    return { shape: vertex, owned: true }
  }
  if (ref.kind === 'face' && ref.id) {
    const f = model.faces[ref.id - 1]
    if (!f) throw new Error(`face id ${ref.id} out of range`)
    return { shape: f, owned: false }
  }
  if (ref.kind === 'edge' && ref.id) {
    const e = model.edges[ref.id - 1]
    if (!e) throw new Error(`edge id ${ref.id} out of range`)
    return { shape: e, owned: false }
  }
  if (ref.kind === 'vertex' && ref.id) {
    const v = model.vertices[ref.id - 1]
    if (!v) throw new Error(`vertex id ${ref.id} out of range`)
    return { shape: v, owned: false }
  }
  throw new Error(`未対応の参照種別: ${ref.kind}`)
}

/** 2エンティティ間の最短距離（BRepExtrema、真値）。 */
export async function distance(id: string, a: EntityRef, b: EntityRef): Promise<DistanceResult> {
  const oc = await initOcct()
  const model = _models.get(id)
  if (!model) throw new Error(`unknown model id: ${id}`)
  const ra = resolveShape(oc, model, a)
  const rb = resolveShape(oc, model, b)
  // BRepExtrema wrapper は WASM ヒープ上の embind オブジェクト。GC されないので
  // 数値を JS 側へ写し取った後、必ず delete して解放する（計測は繰り返される）。
  const ext = new oc.BRepExtrema_DistShapeShape_2(
    ra.shape,
    rb.shape,
    oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
    oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
  )
  try {
    if (!ext.IsDone() || ext.NbSolution() < 1) throw new Error('距離計算に失敗')
    const pa = ext.PointOnShape1(1)
    const pb = ext.PointOnShape2(1)
    try {
      return {
        type: 'distance',
        value: ext.Value(),
        pointA: [pa.X(), pa.Y(), pa.Z()],
        pointB: [pb.X(), pb.Y(), pb.Z()],
      }
    } finally {
      del(pa, pb)
    }
  } finally {
    del(ext)
    if (ra.owned) del(ra.shape)
    if (rb.owned) del(rb.shape)
  }
}

/** 面情報: 面積 + 円筒(穴/ボス)半径・軸 or 平面法線。 */
export async function faceInfo(id: string, ref: EntityRef): Promise<FaceInfoResult> {
  const oc = await initOcct()
  const model = _models.get(id)
  if (!model) throw new Error(`unknown model id: ${id}`)
  const resolved = resolveShape(oc, model, ref)
  const face = oc.TopoDS.Face_1(resolved.shape)

  // props / surf は embind オブジェクト。数値を写し取ったら delete して解放する。
  const props = new oc.GProp_GProps_1()
  const surf = new oc.BRepAdaptor_Surface_2(face, true)
  try {
    oc.BRepGProp.SurfaceProperties_1(face, props, false, false)
    const out: FaceInfoResult = { type: 'face', area: props.Mass(), surface: 'unknown' }

    const stype = surf.GetType().value // 列挙は singleton だが value 比較で確実に
    if (stype === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) {
      const cyl = surf.Cylinder()
      const c = cyl.Location()
      const axis = cyl.Axis()
      const ax = axis.Direction()
      out.surface = 'cylinder'
      out.radius = cyl.Radius()
      out.diameter = 2 * cyl.Radius()
      out.center = [c.X(), c.Y(), c.Z()]
      out.axis = [ax.X(), ax.Y(), ax.Z()]
      del(cyl, axis, c, ax) // Location()/Direction()の戻り値は独立（実測済み）
    } else if (stype === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value) {
      const pln = surf.Plane()
      const axis = pln.Axis()
      const n = axis.Direction()
      out.surface = 'plane'
      out.normal = [n.X(), n.Y(), n.Z()]
      del(pln, axis, n)
    }
    return out
  } finally {
    del(props, surf, face)
    // face は resolved.shape (model.faces の永続 Face、または point参照の一時
    // Vertex) を再キャストしたもの。再キャスト結果を破棄しても永続側は壊れない
    // ことを実測済み。owned な一時オブジェクトは resolved 側も破棄する。
    if (resolved.owned) del(resolved.shape)
  }
}

// OCCT の GeomAbs_CurveType 列挙順（安定・OCCT全バージョン共通）。backend の
// `GeomAbs_CurveType(...).name.removeprefix("GeomAbs_").lower()` と同じ表記に揃える。
const CURVE_TYPE_NAMES = [
  'line',
  'circle',
  'ellipse',
  'hyperbola',
  'parabola',
  'beziercurve',
  'bsplinecurve',
  'offsetcurve',
  'othercurve',
]

/** エッジ情報: 長さ + 円形(穴のフィレット/ボス外周等)半径・中心・軸。 */
export async function edgeInfo(id: string, ref: EntityRef): Promise<EdgeInfoResult> {
  const oc = await initOcct()
  const model = _models.get(id)
  if (!model) throw new Error(`unknown model id: ${id}`)
  const resolved = resolveShape(oc, model, ref)
  const edge = oc.TopoDS.Edge_1(resolved.shape)

  const props = new oc.GProp_GProps_1()
  try {
    oc.BRepGProp.LinearProperties(edge, props, false, false)
    const out: EdgeInfoResult = { type: 'edge', length: props.Mass(), curve: 'unknown' }

    const curve = new oc.BRepAdaptor_Curve_2(edge)
    try {
      const ctype: number = curve.GetType().value
      if (ctype === oc.GeomAbs_CurveType.GeomAbs_Circle.value) {
        const circ = curve.Circle()
        const c = circ.Location()
        const axis = circ.Axis()
        const ax = axis.Direction()
        out.curve = 'circle'
        out.radius = circ.Radius()
        out.diameter = 2 * circ.Radius()
        out.center = [c.X(), c.Y(), c.Z()]
        out.axis = [ax.X(), ax.Y(), ax.Z()]
        del(circ, axis, c, ax)
      } else {
        out.curve = CURVE_TYPE_NAMES[ctype] ?? 'unknown'
      }
    } finally {
      del(curve)
    }
    return out
  } finally {
    del(props, edge)
    // edge は resolved.shape (model.edges の永続 Edge) を再キャストしたもの。
    // 再キャスト結果を破棄しても永続側は壊れない（faceInfo と同様に実測済みの
    // パターン）。owned な一時オブジェクトは resolved 側も破棄する。
    if (resolved.owned) del(resolved.shape)
  }
}
