/**
 * OCCT-WASM エンジン（backend/app/tessellation.py + measure.py のブラウザ移植）。
 *
 * 設計原則は本家と同一 —「メッシュは表示用の嘘、計測はB-repの真実」。
 * テッセレーションした三角形には由来する faceId を付け、計測は必ず元の
 * B-rep（TopoDS_Face）に対して BRepExtrema / GProp で真値を出す。
 *
 * 対応形式:
 *   - STEP: XCAF（STEPCAFControl_Reader）でアセンブリ・名前・形状を読む。読めなければ
 *     （非XCAF STEPファイル、パース失敗等）STEPControl_Reader（単一シェイプ・面のみ）
 *     にフォールバックする。どちらも1パート以上の `LoadedModel.parts` に正規化する。
 *   - IGES: IGESControl_Reader（非XCAF・単一シェイプ、面のみ）。
 *   - STL: StlAPI_Reader。パラメトリック面を持たないため format は 'mesh' 扱いとし、
 *     本家 backend（trimesh 経由・B-rep計測なし）と挙動を揃えて計測を無効化する。
 *     3MF/OBJ/PLY は OCCT に読込手段が無く（本家も trimesh 任せで OCCT を通さない）、
 *     別途 JS 側パーサが必要 — 本ビルドは未対応。
 *
 * XCAF（アセンブリ展開・名前・形状、対応済み）: 詳細は README「XCAF」節参照。
 * 色は現状 XCAFDoc_ColorTool.GetColor が STEP 往復後のテスト実データで色を
 * 検出できていない（原因未特定）ため、常に null（フォールバック表示色）。
 * 未対応: エッジ/頂点スナップの一部形式、2D図面。
 * このビルドに TopTools_IndexedMapOfShape が無いため、面インデックスは
 * TopExp_Explorer の走査順で JS 側に自前保持する（テッセレーションと計測解決で
 * 同一配列を使うので faceId はパート内で一貫する）。
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

/** アセンブリツリーのノード（model.ts の TreeNodeData と同じ形。ここでは疎結合に自前定義）。 */
interface TreeNode {
  name: string
  partId?: number
  children?: TreeNode[]
}

/** 1パート＝1つの独立した形状（XCAFの部品、または非アセンブリ時は全体で1個）。 */
interface ModelPart {
  id: number
  name: string
  color: [number, number, number] | null
  shape: OC // TopoDS_Shape（アセンブリ内の配置変換済み）
  faces: OC[] // index i (0-based) => faceId i+1 の TopoDS_Face（パート内で一貫）
  edges: OC[] // index i (0-based) => edgeId i+1 の TopoDS_Edge
  vertices: OC[] // index i (0-based) => vertexId i+1 の TopoDS_Vertex
}

interface LoadedModel {
  id: string
  name: string
  format: 'brep' | 'mesh'
  parts: ModelPart[]
  tree: TreeNode
  bbox: { min: number[]; max: number[] }
  triangleCount: number
  vertexCount: number
  meshPack: MeshPack // load時に構築してキャッシュ
  // Codexレビュー指摘(P2、7巡目)を受けた恒久対策: このidを最後に「claim」した
  // api.ts側の呼び出しのgen（api.tsの_uploadGen、uploadModel呼び出しごとに採番、
  // フォーマット跨ぎで単調増加）。新規コミット時・cache-hit時の両方でこの値を
  // max()更新することで、「誰が最後にこのidを見たか」を id 単位で追跡する。
  // disposeByIdはこの値と呼び出し側の主張するgenが一致する時だけ実際に破棄する
  // （＝自分より新しい誰かが既にこのidを見ていたら、たとえ自分がstaleでも
  // 手を出さない）。詳細は disposeById のコメント参照。
  claimGen: number
  // XCAF(アセンブリ)経由で読んだ場合のみ設定。readXcafParts のコメント参照 —
  // 抽出済みのパート形状がこのdocの内部データを参照しているため、モデルの
  // 全パートを破棄し終えるまで生かしておく必要がある。
  xcafDoc?: OC
}

const _models = new Map<string, LoadedModel>()
// Codexレビュー指摘(P2): loadModelは複数箇所でawaitするため、2つのアップロードが
// 重なると後発(より小さい/速い)の読込が先に完了してUIの「現在のモデル」になった
// 後、先発(遅い)の読込がその後で完了しevictOthers(id)を呼ぶと、UIが現在と
// 思っているモデルまで_modelsから消してしまい、以降のfetchMesh/計測が
// unknown model idで失敗する。世代カウンタで「自分の開始後により新しい読込が
// 始まっていたら、evict/コミットを行わず自分のリソースだけ破棄する」よう
// 直列化する。
let _loadGen = 0

// test-only: 次のloadModel呼び出しについて、gen採番の直後・重いパース処理の
// 前に人為的な遅延を入れる。上記のレース（先発の遅い読込が後発より遅く
// 完了する状況）を実ブラウザで決定的に再現するためのフック。
let _stallNextLoadMs = 0
export function __stallNextLoad(ms: number): void {
  _stallNextLoadMs = ms
}

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

// Codexレビュー指摘(P2、6巡目): api.ts側のdisposeById(stale-cleanup)は「このアップ
// ロード呼び出しがloadModel内で新規にパース・コミットしたモデル」だけを対象に
// すべきで、「たまたま同じcontentHashで既存の共有モデルを再利用しただけ」の
// cache-hit応答を消してはいけない。例: 現在表示中のSTEPと同じファイルを
// 再アップロードした呼びが、その最中に完了した別アップロードにsupersededされる
// と、cache-hit分岐は現在表示中のモデルと同じidを返す。ここでdisposeByIdする
// と表示中のモデルごと消えてしまう。呼び出し元がstale時に破棄して良いかを
// 判断できるよう、cache-hitかどうかをmetaに載せて伝える。
function metaOf(model: LoadedModel, cached = false): ModelMeta {
  return {
    id: model.id,
    name: model.name,
    format: model.format,
    vertexCount: model.vertexCount,
    triangleCount: model.triangleCount,
    partCount: model.parts.length,
    bbox: model.bbox,
    cached,
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
 * 特定のIDのモデルだけを破棄する。
 *
 * Codexレビュー指摘(P2): _loadGenは「同じOCCTローダー内」のレースしか見て
 * いないため、STEP読込がinitOcct()/contentHash()でawait中に3MF/DXFへの
 * 切替(api.ts側の_uploadGen)が発生してsupersededされても、他にOCCT読込が
 * 無ければ「gen === _loadGen」が成立してしまい、そのSTEPモデルは普通に
 * _modelsへコミットされてしまう。UIには一生表示されないのに、disposeAll()
 * が呼ばれるまでWASMヒープに残り続ける。disposeAll()で一括破棄すると、
 * その後に本当に始まった正当な新しいOCCT読込まで巻き込みかねないため、
 * api.ts側が「このIDだけ」を指定して確実に破棄できる手段を用意する。
 *
 * Codexレビュー指摘(P2、7巡目、恒久対策): 上記のdisposeByIdは呼び出し元が
 * stale判定した時点で無条件に(あるいはcache-hitかどうかだけで)破棄していたが、
 * それでも「破棄しようとしているid」を、自分より新しい別の呼び出しが既に
 * cache-hitで参照・依拠している可能性を見落とす（例: 同一ファイルへの
 * ほぼ同時アップロードで、先発が新規コミット(cached:false)した直後に後発が
 * cache-hitでそのidを引き継ぎ「現在」になったのに、先発が自分をstaleと気付き
 * 無条件にdisposeByIdしてしまうと、後発が今まさに使っているモデルを消して
 * しまう）。id単位で「最後にこのidを見た呼び出しのgen」(claimGen、api.ts
 * 側の_uploadGenを渡してもらう)をLoadedModelに持たせ、disposeByIdは
 * 「呼び出し時点でもclaimGenが自分のgenのままである(＝自分より新しい誰も
 * このidに触れていない)」場合だけ実際に破棄する。呼び出し元は自分のgenを
 * 渡すだけでよく、cache-hitかどうかを気にする必要が無くなる（安全性は
 * このid単位のclaimGen比較だけで担保される）。
 */
export function disposeById(id: string, gen: number): void {
  const m = _models.get(id)
  if (!m) return
  if (m.claimGen !== gen) return // 自分より新しい誰かが既にこのidを見ている
  disposeModel(m)
  _models.delete(id)
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
    for (const part of m.parts) {
      part.shape?.delete?.()
      for (const f of part.faces) f?.delete?.()
      for (const e of part.edges) e?.delete?.()
      for (const v of part.vertices) v?.delete?.()
    }
    // xcafDoc(TDocStd_Document)はパート形状が内部データを参照している
    // （readXcafParts のコメント参照）ため、パート側を全て破棄した後に破棄する。
    m.xcafDoc?.delete?.()
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

// ---------------------------------------------------------------- XCAF (アセンブリ)

interface XcafPartShape {
  name: string
  shape: OC // 配置変換(TopLoc_Location)適用済みのTopoDS_Shape
}

interface XcafResult {
  parts: XcafPartShape[]
  tree: TreeNode
  // 罠(実測でクラッシュ確認済み): 抽出したTopoDS_Shape(TNaming_NamedShape属性
  // 経由で取得)は、XCAFの文書(TDocStd_Document)がラベル経由で内部所有する
  // 形状データを共有・参照している。読込直後にdocをdeleteすると、Located()で
  // 配置変換した「コピー」であっても元データが解放されヒープ破損する（3パート目
  // 以降のBRepMesh_IncrementalMesh/TopExp_Explorerで不定挙動として顕在化する
  // use-after-free、実ブラウザで`Invalid typed array length`のクラッシュとして
  // 確認済み）。docはモデル全体（全パートのテッセレーション完了）と寿命を
  // 共にする必要があるため、ここでは破棄せず呼び出し元へ持ち回す。
  doc: OC
}

/**
 * ラベルからName属性(TDataStd_Name)の文字列を読む。
 *
 * 罠(実測でクラッシュ確認済み): `TCollection_ExtendedString.Value(i)`（1文字ずつ
 * 読み出す素朴な方法）はこのopencascade.jsビルドで文字列の中身に関わらず
 * ネイティブクラッシュする（XCAF固有ではなく単独のExtendedStringでも再現。
 * 原因未特定のバインディング不具合）。回避策: `new TCollection_AsciiString_13
 * (extStr, defaultChar)` でAsciiStringへ変換してから`.Value(i)`を使う
 * （AsciiStringは素のcharを保持するためこちらは安全に動く）。
 *
 * 罠(実測で確認・前回投稿の記録訂正): 以前の調査では「Handle_TDF_Attribute
 * (汎用)からHandle_TDataStd_Name(具象型)への安全なダウンキャスト手段が
 * 見つからない」としていたが、実際には`outAttr.get()`（Handle_TDF_Attribute
 * に対する素の`.get()`）を呼ぶだけで正しい具象型（この場合TDataStd_Name）の
 * インスタンスが返ってくる。embindの型解決がHandleの静的型ではなく実行時の
 * 実体型を見ているためと推測される。`Handle_TDataStd_Name_2/3`コンストラクタ
 * 経由の明示ダウンキャストは（型不一致で）機能しないが、そもそも不要だった。
 */
function readLabelName(oc: OC, label: OC): string | null {
  const guid = oc.TDataStd_Name.GetID()
  const outAttr = new oc.Handle_TDF_Attribute_1()
  const found = label.FindAttribute_1(guid, outAttr)
  if (!found) return null
  const extStrVal = outAttr.get().Get()
  const ascii = new oc.TCollection_AsciiString_13(extStrVal, 63) // 63='?'（非ASCII文字の置換用）
  const len = ascii.Length()
  let s = ''
  for (let k = 1; k <= len; k++) s += String.fromCharCode(ascii.Value(k))
  return s
}

/** ラベルのTNaming_NamedShape属性から形状を取り出す（無ければnull）。 */
function shapeFromLabel(oc: OC, label: OC): OC | null {
  const guid = oc.TNaming_NamedShape.GetID()
  const outAttr = new oc.Handle_TDF_Attribute_1()
  const found = label.FindAttribute_1(guid, outAttr)
  if (!found) return null
  const shape = outAttr.get().Get()
  return shape.IsNull() ? null : shape
}

/**
 * ラベルの「タグパス」（例: "0:2:1"、Father()を辿ってTag()を連結）を安定な
 * 識別子として返す。同一ドキュメント内で同じラベルを指す別々のJSラッパー
 * オブジェクト（GetReferredShapeで都度new TDF_Label()して受けるため、同じ
 * ラベルでもJS上の===比較は常にfalseになる）を、値で同一視するために使う。
 * アセンブリのコンポーネントが同じ形状定義ラベルを複数回参照するケース
 * （例: mini_mold.stepのcore_pinが2箇所に配置される）の重複メッシング検出に使う。
 */
function labelEntry(label: OC): string {
  const tags: number[] = []
  let cur = label
  for (let i = 0; i < 64; i++) {
    // 深さの上限は異常なラベルツリー（循環等）でのハング防止の安全弁
    tags.unshift(cur.Tag())
    const father = cur.Father()
    if (father.IsNull()) break
    cur = father
  }
  return tags.join(':')
}

/**
 * STEPCAFControl_ReaderでXCAF(アセンブリ・名前・色)を読み、平坦化されたパート
 * リスト＋ツリーを返す。非XCAFファイル・パース失敗・アセンブリ構造なしの場合は
 * nullを返し、呼び出し元(loadModel)が非XCAFの単一シェイプ読込にフォールバックする。
 *
 * 実装は実ブラウザで1つずつ実測確認した手順のみで構成する（README「XCAF」節に
 * 詳細）:
 *   1. TDocStd_Document + STEPCAFControl_Reader.Transfer で文書を構築
 *   2. shapeTool.BaseLabel().FindChild(i) でトップレベルの「自由な形状」を列挙
 *      （TDF_LabelSequenceを要求するGetFreeShapes/GetComponentsは未バインドの
 *      ため使わず、NbChildren/FindChildによる手動走査で代替する）
 *   3. XCAFDoc_ShapeTool.IsAssembly(label)（静的メソッド）でアセンブリか判定し、
 *      アセンブリなら子(コンポーネント参照)を再帰的に辿る。各コンポーネントは
 *      XCAFDoc_ShapeTool.GetReferredShape(静的)で参照先の実体形状定義ラベルへ、
 *      GetLocation(静的)で配置(TopLoc_Location)を得て、TopLoc_Location.Multiplied
 *      で親からの累積変換と合成する（ネスト未検証だが標準的なOCCTの合成規則）
 *   4. リーフ(非アセンブリ)ラベルはTNaming_NamedShape属性から形状を取り出し、
 *      shape.Located(累積location)で配置変換を適用してパートとして確定する
 */
function readXcafParts(oc: OC, bytes: Uint8Array): XcafResult | null {
  const path = '/xcaf.step'
  let doc: OC | null = null
  // 注意: 通常の del() ヘルパー経由の一括破棄はしない。成功時は doc を
  // XcafResult 経由でモデルの寿命まで持ち回す必要がある（下記コメント参照）ため、
  // 「何も返さず終わる」パス（!ok / nbFree<1 / parts.length===0 / 例外）でだけ
  // 個別に破棄する。
  try {
    try {
      oc.FS.unlink(path)
    } catch {
      /* 初回は存在しない */
    }
    oc.FS.writeFile(path, bytes)

    const extStr = new oc.TCollection_ExtendedString_2('XmlXCAF', true)
    doc = new oc.TDocStd_Document(extStr)
    const hDoc = new oc.Handle_TDocStd_Document_2(doc)
    const reader = new oc.STEPCAFControl_Reader_1()
    reader.SetColorMode(true)
    reader.SetNameMode(true)
    let ok = false
    try {
      reader.ReadFile(path)
      ok = reader.Transfer_1(hDoc)
    } finally {
      del(reader)
      try {
        oc.FS.unlink(path)
      } catch {
        /* ignore */
      }
    }
    if (!ok) {
      del(doc)
      return null
    }

    const mainLabel = doc.Main()
    const hShapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(mainLabel)
    const shapeTool = hShapeTool.get()
    const baseLabel = shapeTool.BaseLabel()
    const nbFree = baseLabel.NbChildren()
    if (nbFree < 1) {
      del(doc)
      return null
    }

    // 罠(実測でハング確認済み・恒久対策): アセンブリのコンポーネントは同じ
    // 形状定義ラベル（同一のTopoDS_TShape、実体データ）を複数回参照し得る
    // （例: mini_mold.stepのcore_pinが2箇所に異なる配置で使われる）。walk()が
    // その都度 shapeFromLabel() で取り出した形状に対して個別に
    // BRepMesh_IncrementalMesh を実行すると、同一の下地形状データへ複数回
    // メッシングをかけることになり、このWASMビルドでは2回目以降が完了せず
    // ハングする（`Invalid typed array length`のクラッシュを経て特定。
    // isInParallelフラグに関係無く再現するため並列化起因ではなく、同一
    // TShapeへの重複メッシング自体が問題）。そのため、ここではまず全リーフの
    // 「ラベル＋累積配置」だけを集め（メッシングは一切しない）、モデル全体の
    // bboxからlinDeflを決めた後、重複するラベル（labelEntry()で同定）は
    // 1回だけメッシングしてから、最後に配置変換済みの最終形状を組み立てる。
    interface Leaf {
      name: string
      label: OC
      loc: OC | null
    }
    const leaves: Leaf[] = []
    let nextPartId = 0

    // アセンブリでない単純な形状か判定するには、まずTNaming_NamedShapeが直接
    // 付いているかを見る（付いていればリーフ）。IsAssembly静的判定と併用し、
    // どちらでも「子を持たない」ケースを取りこぼさないよう両方確認する。
    const walk = (label: OC, accLoc: OC | null): TreeNode | null => {
      const isAssembly: boolean = oc.XCAFDoc_ShapeTool.IsAssembly(label)
      const nbChildren: number = label.NbChildren()
      if (!isAssembly || nbChildren === 0) {
        const rawShape = shapeFromLabel(oc, label)
        if (!rawShape) return null
        const name = readLabelName(oc, label) ?? `part${nextPartId + 1}`
        const partId = nextPartId++
        leaves.push({ name, label, loc: accLoc })
        return { name, partId }
      }

      const children: TreeNode[] = []
      for (let i = 1; i <= nbChildren; i++) {
        const compLabel = label.FindChild(i, false)
        const outRef = new oc.TDF_Label()
        const isRef: boolean = oc.XCAFDoc_ShapeTool.GetReferredShape(compLabel, outRef)
        const targetLabel = isRef ? outRef : compLabel
        const compLoc = oc.XCAFDoc_ShapeTool.GetLocation(compLabel)
        const combinedLoc = accLoc ? accLoc.Multiplied(compLoc) : compLoc
        const node = walk(targetLabel, combinedLoc)
        if (node) children.push(node)
      }
      if (children.length === 0) return null
      const name = readLabelName(oc, label) ?? 'assembly'
      return { name, children }
    }

    // 罠(実測で確認): baseLabel(ShapesLabel)の子は「トップレベルの自由形状」
    // （組立のルート等）と「他から参照されるだけの共有シェイプ定義」の両方が
    // 並んで入っている。GetFreeShapes()相当の絞り込み無しに全子を歩くと、
    // アセンブリのコンポーネントとして正しく配置済みのパートに加えて、
    // 参照元シェイプ定義そのもの（原点に置かれたまま、コンポーネントの数だけ
    // 重複）まで独立パートとして拾ってしまう（実機のmini_mold.stepで7パート
    // に化けることを確認）。XCAFDoc_ShapeTool.IsFree(静的)で「他から参照
    // されていない、真にトップレベルなラベル」だけに絞り込む
    // （GetFreeShapes()自体はNCollection_Sequence<TDF_Label>を要求し未バインド
    // だが、IsFreeは単一ラベルを取る静的メソッドでありバインドされている）。
    const roots: TreeNode[] = []
    for (let i = 1; i <= nbFree; i++) {
      const freeLabel = baseLabel.FindChild(i, false)
      if (!oc.XCAFDoc_ShapeTool.IsFree(freeLabel)) continue
      const node = walk(freeLabel, null)
      if (node) roots.push(node)
    }
    if (leaves.length === 0) {
      del(doc)
      return null
    }

    // 配置変換込みのbboxからlinDeflを決める（loadModel側の非XCAF経路と同じ
    // 計算式）。メッシングより前に必要（メッシング精度の基準のため）だが、
    // ここではまだ配置済みシェイプを保持していないので、bbox算出用に一時的に
    // Located()するだけで済ませる（メッシュ済みでなくてもbboxは取れる）。
    const placedForBbox = leaves.map((l) => {
      const raw = shapeFromLabel(oc, l.label)
      return l.loc ? raw.Located(l.loc) : raw
    })
    const bboxTmp = computeBBoxUnion(oc, placedForBbox)
    const diagTmp = Math.hypot(
      bboxTmp.max[0] - bboxTmp.min[0],
      bboxTmp.max[1] - bboxTmp.min[1],
      bboxTmp.max[2] - bboxTmp.min[2],
    )
    const linDefl = Math.max(diagTmp * 1e-3, 1e-6)

    // ラベル単位で重複排除して1回だけメッシングする（同一形状定義を複数回
    // 参照するコンポーネントがあっても、下地のTopoDS_TShapeは1回だけ処理する）。
    const meshedEntries = new Set<string>()
    for (const l of leaves) {
      const entry = labelEntry(l.label)
      if (meshedEntries.has(entry)) continue
      meshedEntries.add(entry)
      const raw = shapeFromLabel(oc, l.label)
      if (!raw) continue
      const mesher = new oc.BRepMesh_IncrementalMesh_2(raw, linDefl, false, 0.35, false)
      del(mesher)
    }

    // メッシング済みの下地形状に、リーフごとの配置変換を適用して最終形状を組む。
    const parts: XcafPartShape[] = leaves.map((l) => {
      const raw = shapeFromLabel(oc, l.label)
      const placed = l.loc ? raw.Located(l.loc) : raw
      return { name: l.name, shape: placed }
    })

    const tree: TreeNode = roots.length === 1 ? roots[0] : { name: 'model', children: roots }
    // 成功: docは呼び出し元(loadModel)がモデルの寿命まで保持し、disposeModelで
    // 他のパート形状と一緒に破棄する（早期に破棄すると抽出済みTopoDS_Shapeが
    // 参照する内部データが解放されるため — 上記コメント参照）。
    return { parts, tree, doc }
  } catch (e) {
    // XCAF読込はベストエフォート。失敗しても呼び出し元が非XCAF単一シェイプ
    // 読込にフォールバックできるよう、例外を外へ投げずnullを返す。
    console.warn('[occt] XCAF読込に失敗、非XCAF単一シェイプ読込にフォールバックします', e)
    del(doc)
    return null
  }
}

/**
 * モデルファイルを読み、shape と面配列を格納して ModelMeta を返す。
 *
 * @param apiGen api.ts側の_uploadGen（uploadModel呼び出しごとに採番、フォーマット
 *   跨ぎで単調増加する値）。disposeByIdのid単位claimGen追跡に使うためだけの値で、
 *   occt.ts自身の同一ローダー内レース制御（_loadGen、下記gen）とは独立。
 *   呼び出し元(api.ts)は自分がstaleと分かった時、この同じ値をdisposeByIdへ
 *   渡すことで「自分が最後にこのidを見た張本人の場合だけ」安全に破棄できる。
 */
export async function loadModel(bytes: Uint8Array, name: string, apiGen: number): Promise<ModelMeta> {
  const gen = ++_loadGen
  if (_stallNextLoadMs > 0) {
    const ms = _stallNextLoadMs
    _stallNextLoadMs = 0
    await new Promise((r) => setTimeout(r, ms))
  }
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
    // 自分の開始後により新しい読込が始まっていたら、evictを行わない
    // （現在のモデルを巻き込んで消す事故を防ぐ）。
    if (gen === _loadGen) evictOthers(id)
    // claimGenは「このidを最後に見た呼び出し」を単調増加のapiGenで記録する。
    // cache-hitの自分がstaleな古い呼び出しである可能性もあるため、
    // 常に更新するのではなく「自分の方が新しい場合だけ」更新する
    // （古いcache-hitが新しいclaimGenを巻き戻して壊すと、後から来る本当の
    // 新しい呼び出しのdisposeById安全判定が誤って通ってしまう）。
    if (apiGen > cached.claimGen) cached.claimGen = apiGen
    return metaOf(cached, true)
  }
  // 注意: eviction は「新モデルのパース成功後」に行う（下部）。パース前に消すと、
  // 壊れた入力で読込失敗した際に表示中の旧モデルまで _models から消え、
  // 画面に残った旧ジオメトリへのピック/計測が unknown model id で死ぬ。

  // STEPはまずXCAF(アセンブリ・名前)経由を試み、失敗したら非XCAFの単一シェイプ
  // 読込にフォールバックする。IGES/STLは非XCAF単一シェイプのみ対応。
  const xcaf = kind === 'step' ? readXcafParts(oc, bytes) : null
  const rawParts: { name: string; shape: OC }[] = xcaf
    ? xcaf.parts
    : [{ name, shape: kind === 'stl' ? readStlShape(oc, bytes) : readXsShape(oc, kind, bytes) }]
  const tree: TreeNode = xcaf ? xcaf.tree : { name, partId: 0 }

  // 全パート形状からモデル全体のbboxを算出（テッセレーション許容誤差の基準に使う）。
  const bbox = computeBBoxUnion(oc, rawParts.map((p) => p.shape))
  const diag = Math.hypot(
    bbox.max[0] - bbox.min[0],
    bbox.max[1] - bbox.min[1],
    bbox.max[2] - bbox.min[2],
  )
  const linDefl = Math.max(diag * 1e-3, 1e-6)

  const parts: ModelPart[] = rawParts.map((rp, idx) => {
    // テッセレーション（線形/角度たわみ）。
    // 罠: StlAPI_Reader は「三角形1枚ごとに独立した平面 TopoDS_Face」を作るだけで、
    // Poly_Triangulation は付与しない（テッセレーション済みではない）。STL でも
    // IncrementalMesh を走らせないと BRep_Tool.Triangulation が null になり
    // 面情報ゼロで描画が空になる。各面は元々平面なので、たわみを掛けても
    // 三角形は増えず入力ジオメトリを素直に再現する。
    //
    // XCAF経路はreadXcafParts内で既にラベル単位の重複排除付きメッシングを
    // 済ませている（同一形状定義を複数コンポーネントが参照する場合、下地の
    // TopoDS_TShapeへ複数回メッシングをかけるとこのWASMビルドではハングする
    // ため — readXcafParts内のコメント参照）。ここで再度メッシングすると
    // 同じ問題を再現してしまうため、XCAF経路では実行しない。
    if (!xcaf) {
      const mesher = new oc.BRepMesh_IncrementalMesh_2(rp.shape, linDefl, false, 0.35, false)
      del(mesher) // アルゴリズムオブジェクト自体は shape へ書き込み済みで用済み（実測済み）
    }

    // 面を走査順に配列化（faceId = index+1、パート内で一貫）。
    // 罠: exp.Current() の戻り値は delete 禁止（キャストした Face 側ごと壊れる。
    // 実測でクラッシュ確認済み）。Explorer 自体はループを抜けたら delete して良い。
    const faces: OC[] = []
    const exp = new oc.TopExp_Explorer_2(
      rp.shape,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    )
    for (; exp.More(); exp.Next()) {
      faces.push(oc.TopoDS.Face_1(exp.Current()))
    }
    del(exp)

    // エッジ/頂点も同じ手法で走査順に配列化。ピック（picking.ts の snapVertex/
    // snapEdge）と計測（resolveShape）が同じ配列を参照するのでIDの一貫性が保たれる。
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
        rp.shape,
        oc.TopAbs_ShapeEnum.TopAbs_EDGE,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      )
      for (; eexp.More(); eexp.Next()) {
        edges.push(oc.TopoDS.Edge_1(eexp.Current()))
      }
      del(eexp)

      const vexp = new oc.TopExp_Explorer_2(
        rp.shape,
        oc.TopAbs_ShapeEnum.TopAbs_VERTEX,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      )
      for (; vexp.More(); vexp.Next()) {
        vertices.push(oc.TopoDS.Vertex_1(vexp.Current()))
      }
      del(vexp)
    }

    return {
      id: idx,
      name: rp.name,
      // XCAFDoc_ColorTool.GetColorが実データで色を検出できていない(README参照)ため
      // 常にnull。フロントは色nullをデフォルト表示色として扱う（既存の3MF/STL経路
      // と同じ契約）。
      color: null,
      shape: rp.shape,
      faces,
      edges,
      vertices,
    }
  })

  const model: LoadedModel = {
    id,
    name,
    // STL はパラメトリック面を持たず真値計測（BRepExtrema/GProp）が成立しないため、
    // 本家 backend の mesh 経路（trimesh・計測無効）と挙動を揃える。
    format: kind === 'stl' ? 'mesh' : 'brep',
    parts,
    tree,
    bbox,
    triangleCount: 0,
    vertexCount: 0,
    meshPack: undefined as unknown as MeshPack,
    claimGen: apiGen,
    xcafDoc: xcaf?.doc,
  }
  // メッシュを即構築してキャッシュ（三角形/頂点数を meta に載せるため）。
  // エッジのサンプリング許容誤差(deflection)は面メッシュと同じ linDefl を使う
  // （Codexレビュー指摘: 固定値0.1だとメートル単位の小さい円弧・穴がほぼ潰れ、
  // 見た目上は曲線があるのにスナップ/計測できなくなるモデルスケール依存バグ）。
  model.meshPack = buildMeshPack(oc, model, linDefl)
  // Codexレビュー指摘: 自分の開始後により新しい読込が既に完了していた場合、
  // このモデルはUIに表示されることが無い（main.ts側のloadGenでも同じ理由で
  // 無視される）。_modelsに残したままevictだけスキップすると、以降どこかの
  // 読込がevictOthersするまで、表示されないshape/faces/meshPack(embind
  // オブジェクト)がWASMヒープに残り続けてしまう（数百MBのOCCTヒープを
  // 切り離す狙いと逆行する）。その場でdisposeして_modelsにも残さない
  // （例外は投げない — main.tsのエラーハンドラはstale判定なしに表示中HUDを
  // 上書きするため、ここで失敗させると現在正常に表示されているモデルの上に
  // エラーメッセージが出てしまう）。
  if (gen === _loadGen) {
    _models.set(id, model)
    // パース成功が確定してから旧モデルを破棄する（読込失敗時に表示中モデルを
    // 巻き込まないため）。瞬間的に旧+新が同居するが、正しさをメモリ最小化より優先。
    evictOthers(id)
  } else {
    disposeModel(model)
  }

  return metaOf(model)
}

function computeBBoxUnion(oc: OC, shapes: OC[]): { min: number[]; max: number[] } {
  const box = new oc.Bnd_Box_1()
  try {
    for (const shape of shapes) {
      oc.BRepBndLib.Add(shape, box, false)
    }
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
 * 1パート分の面をテッセレーションし、頂点・法線・インデックス・faceRangesを返す。
 * 法線は三角形の巻き順から自前計算（このビルドに法線ヘルパーが無いため）。
 * shape は BRepMesh_IncrementalMesh 済みが前提（loadModel 内で実行済み）。
 */
function tessellatePartFaces(
  oc: OC,
  faces: OC[],
): {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  faceRanges: { faceId: number; triStart: number; triCount: number }[]
  triCount: number
  vertCount: number
} {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const faceRanges: { faceId: number; triStart: number; triCount: number }[] = []
  let vertOffset = 0
  let triOffset = 0

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi]
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
      del(loc)
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
    // 罠(実測でヒープ破損を確認済み・恒久対策): 以前は del(tri) していたが、
    // triはBRep_Tool.Triangulationが返すPoly_Triangulationの参照(triHandle.get())
    // であり、下地のTopoDS_TShapeが所有する共有データを指している。単一シェイプ
    // モデルでは各Faceが1回しか読まれないため実害が無かったが、XCAFアセンブリで
    // 同じ形状定義を複数コンポーネントが参照するケース（例: mini_mold.stepの
    // core_pinが2箇所に配置される）では、片方のパートの読込後にtriを明示delete
    // すると、もう片方のパートが後で同じ面を読んだ時にはtriangulationデータが
    // 既に破棄されており、NbNodes/NbTrianglesがゴミ値（巨大値・負値）を返す
    // ヒープ破損として顕在化する（実測: 2個目のcore_pinでnNodesが負の巨大値に
    // なりFloat32Arrayのlengthが不正になってクラッシュ）。tri自体は明示的に
    // delete せず、Faceが破棄される際（disposeModelでのpart.faces破棄）に
    // 任せる。
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    faceRanges,
    triCount: triOffset,
    vertCount: vertOffset,
  }
}

/**
 * テッセレーション結果を MeshPack 形状のオブジェクトとして直接組む
 * （backend のバイナリ往復は不要。parseMeshPack と同じ {header, buffers}）。
 * パートごとに独立したバッファ（`p{id}:positions`等）を持つ（フロントの
 * model.ts の toModelData が期待する契約）。
 */
function buildMeshPack(oc: OC, model: LoadedModel, linDefl: number): MeshPack {
  const buffers: Record<string, Float32Array | Uint32Array> = {}
  const headerBuffers: Record<string, ReturnType<typeof desc>> = {}
  const partsHeader: {
    id: number
    name: string
    color: [number, number, number] | null
    faceRanges: { faceId: number; triStart: number; triCount: number }[]
    edgeRanges: { edgeId: number; segStart: number; segCount: number }[]
  }[] = []
  let totalTri = 0
  let totalVert = 0

  for (const part of model.parts) {
    const { positions, normals, indices, faceRanges, triCount, vertCount } = tessellatePartFaces(oc, part.faces)
    const { edgeArr, edgeRanges } = buildEdges(oc, part.edges, linDefl)
    const vertArr = buildVertices(oc, part.vertices)

    buffers[`p${part.id}:positions`] = positions
    buffers[`p${part.id}:normals`] = normals
    buffers[`p${part.id}:indices`] = indices
    buffers[`p${part.id}:edges`] = edgeArr
    buffers[`p${part.id}:vertices`] = vertArr
    headerBuffers[`p${part.id}:positions`] = desc('float32', positions.length)
    headerBuffers[`p${part.id}:normals`] = desc('float32', normals.length)
    headerBuffers[`p${part.id}:indices`] = desc('uint32', indices.length)
    headerBuffers[`p${part.id}:edges`] = desc('float32', edgeArr.length)
    headerBuffers[`p${part.id}:vertices`] = desc('float32', vertArr.length)

    partsHeader.push({ id: part.id, name: part.name, color: part.color, faceRanges, edgeRanges })
    totalTri += triCount
    totalVert += vertCount
  }

  model.triangleCount = totalTri
  model.vertexCount = totalVert

  // parseMeshPack が返すのと同じ形。BufferDesc の offset/byteLength は本経路では
  // 未使用（buffers を直接 typed array で持つ）だが型を満たすため埋める。
  const header = {
    buffers: headerBuffers,
    parts: partsHeader,
    tree: model.tree,
  }
  return { header, buffers } as unknown as MeshPack
}

/** vertexId 順に B-rep 頂点の真値座標を書き出す（picking.ts の snapVertex が参照）。 */
function buildVertices(oc: OC, vertices: OC[]): Float32Array {
  const out = new Float32Array(vertices.length * 3)
  for (let i = 0; i < vertices.length; i++) {
    const p = oc.BRep_Tool.Pnt(vertices[i])
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
  edges: OC[],
  linDefl: number,
): { edgeArr: Float32Array; edgeRanges: { edgeId: number; segStart: number; segCount: number }[] } {
  const segs: number[] = []
  const edgeRanges: { edgeId: number; segStart: number; segCount: number }[] = []
  let segOffset = 0

  for (let ei = 0; ei < edges.length; ei++) {
    const edge = edges[ei]
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
 * model.parts[].faces 等から借用した永続オブジェクトで、delete 禁止（今後の
 * 計測でも使い回すため）。この区別を怠ると point 参照が漏れ続けるか、face
 * 参照を誤って破棄して以後の計測が壊れるかのどちらかになる。
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
  const partId = ref.partId ?? 0
  const part = model.parts[partId]
  if (!part) throw new Error(`part id ${partId} out of range`)
  if (ref.kind === 'face' && ref.id) {
    const f = part.faces[ref.id - 1]
    if (!f) throw new Error(`face id ${ref.id} out of range`)
    return { shape: f, owned: false }
  }
  if (ref.kind === 'edge' && ref.id) {
    const e = part.edges[ref.id - 1]
    if (!e) throw new Error(`edge id ${ref.id} out of range`)
    return { shape: e, owned: false }
  }
  if (ref.kind === 'vertex' && ref.id) {
    const v = part.vertices[ref.id - 1]
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
    // face は resolved.shape (part.faces の永続 Face、または point参照の一時
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
    // edge は resolved.shape (part.edges の永続 Edge) を再キャストしたもの。
    // 再キャスト結果を破棄しても永続側は壊れない（faceInfo と同様に実測済みの
    // パターン）。owned な一時オブジェクトは resolved 側も破棄する。
    if (resolved.owned) del(resolved.shape)
  }
}
