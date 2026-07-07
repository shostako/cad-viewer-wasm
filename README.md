# cad-viewer-wasm

[cad-viewer](https://github.com/shostako/cad-viewer) の**配布方式フォークA**。
backend を消し、OpenCASCADE を WASM（[opencascade.js](https://github.com/donalffons/opencascade.js)）で
**ブラウザ内で直接動かす**純静的サイト版。

- **配布**: URL を渡すだけ。インストール 0・OS 問わず・サーバ不要
- **機密性**: CAD ファイルがユーザーの PC から出ない（アップロード先が無い）
- 姉妹フォーク: `cad-viewer-cloud`（B: ホスト型 Web）, `cad-viewer-desktop`（C: デスクトップ）

## 設計

```
[ブラウザ]  Three.js/TS (描画・ピック・UI)  ──呼び出し──>  occt.ts (WASM OCCT)
            ↑ cad-viewer から無改造で流用         ↑ backend の tessellation.py + measure.py 相当
```

設計原則は本家と同一 — **メッシュは表示用の嘘、計測は B-rep の真実**。
計測は必ず WASM 内の OCCT で `BRepExtrema` / `GProp` の真値を出す。

**継ぎ目(seam)は `src/api.ts` 一枚**。本家では fetch で FastAPI backend を叩いていた
データ層を、同じシグネチャのまま `src/occt.ts`（opencascade.js ラッパ）へ委譲する。
`main.ts` / `viewer.ts` / `picking.ts` / `measure.ts` はデータ源が Python サーバか
WASM かを知らずに動く。計測の永続化(サイドカー)は localStorage。

## 状態: スパイク（成立実証済み）+ ファイル形式拡張済み

実ブラウザ(Playwright/headless chromium)で **STEP読込 → Three.js描画 → 面ピック →
BRepExtrema 真値距離** を確認済み（`spike_verify.py`、VERDICT: PASS、面間距離が
箱の実寸法とピタリ一致）。

対応形式: **STEP/IGES**（`occt.ts`、XSControl_Reader系・真値計測あり。STEPは
XCAFアセンブリ展開対応）、**STL**（`occt.ts`、StlAPI_Reader・format='mesh'で
計測無効）、**3MF**（`threemf.ts`、OCCTを経由しない純JSのZIP+XMLメッシュ経路・
format='mesh'）。いずれも実ブラウザで読込・描画・dedupを確認済み。

### 未実装（本移植の残）
- カスタムビルドで wasm 63MB → 一桁 MB 台
- XCAFの色（`XCAFDoc_ColorTool.GetColor`が実データで色を検出できていない、
  詳細は下記）
- （新規判明）StlAPI_Reader は三角形1枚ごとに独立 Face を作る設計のため、
  58万三角形級の大きい STL（`five_spoke_wheel.stl` 等）は実用にならない速度で
  固まる。Worker化はしたので少なくともUIは固まらないが、読込自体は依然重い。
  大規模STLの扱い（レイヤ分割読込 or メッシュ経路への切替）を別途検討する必要あり

### XCAF（アセンブリ展開・名前・形状、対応済み）

STEPは`STEPCAFControl_Reader`でXCAF文書として読み、アセンブリ構造・名前・
配置変換済みの形状を`LoadedModel.parts[]`（1パート＝1つの独立したTopoDS_Shape）
として取り出す。失敗（非XCAF STEP、パース失敗、アセンブリ構造なし等）した場合は
`STEPControl_Reader`による従来の単一シェイプ読込にフォールバックする。非XCAF
STEP・IGES・STL・3MFはすべて「1パートのモデル」として同じ`parts[]`契約に
正規化されるため、フロントエンド（`picking.ts`/`viewer.ts`/`measure.ts`/
`tree.ts`、いずれも本家cad-viewerから無改造）は元々マルチパート前提の設計
のまま、追加改修なしでXCAFアセンブリを描画・ピック・計測できた。

**2026-07-06時点の調査では「ブロック中」と判断していたが、実際には両ブロッカーとも
回避できることが再調査で判明した**（別角度・実ブラウザでの1つずつの実測により）:

1. `XCAFDoc_ShapeTool.GetFreeShapes()`/`GetComponents()`が要求する
   `NCollection_Sequence<TDF_Label>`（`TDF_LabelSequence`）は依然未バインドで
   使えない。代わりに`shapeTool.BaseLabel()`から`NbChildren()`/`FindChild(i)`で
   手動再帰走査し、`XCAFDoc_ShapeTool.IsFree`（静的、単一ラベルを取るので
   バインドされている）で「他から参照されない真にトップレベルなラベル」だけに
   絞り込むことで代替できる（絞り込み無しで全子を歩くと、アセンブリの
   コンポーネントとして正しく配置済みのパートに加えて、参照元シェイプ定義
   そのもの（未配置のまま）まで重複して拾ってしまう、実機で7パートに化ける
   事故を実測）。
2. `Handle_TDF_Attribute`（汎用）→`Handle_TDataStd_Name`/`Handle_TNaming_NamedShape`
   （具象型）への安全なダウンキャストは、実は**`outAttr.get()`を呼ぶだけで
   正しい具象型のインスタンスが返ってくる**（embindの型解決が実行時の実体型を
   見ているためと推測、`Handle_TDataStd_Name_2/3`等の明示コンストラクタ経由の
   ダウンキャストは型不一致で機能しないが、そもそも不要だった）。前回投稿時に
   「ダウンキャスト探索中に1回クラッシュ」としていたのは、実際には別の操作
   （下記3）が原因で、ダウンキャストそのものは無害と判明。
3. 名前の文字列抽出で使っていた`TCollection_ExtendedString.Value(i)`
   （1文字ずつ読む素朴な方法）がこのopencascade.jsビルドで**内容に関わらず
   ネイティブクラッシュする**（XCAF固有ではなく単独のExtendedStringでも再現、
   原因未特定のバインディング不具合）。回避策: `new TCollection_AsciiString_13
   (extStr, defaultChar)`でAsciiStringへ変換してから`.Value(i)`を使う
   （AsciiStringは素のcharを保持するため安全に動く）。

**罠（実測でヒープ破損/ハングを確認済み・恒久対策）**: アセンブリのコンポーネントは
同じ形状定義ラベル（同一のTopoDS_TShape）を複数回参照し得る（例:
mini_mold.stepのcore_pinが2箇所に異なる配置で使われる）。
1. 各コンポーネントの配置済み形状に対して個別に`BRepMesh_IncrementalMesh`を
   実行すると、同一の下地形状データへ複数回メッシングをかけることになり、
   2回目の呼び出しが完了せずハングする（`isInParallel`フラグの真偽に関係無く
   再現、並列化起因ではなく重複メッシング自体が問題）。対策:
   `labelEntry()`（ラベルのタグパスを文字列化した安定識別子）で重複排除し、
   1つの形状定義につき1回だけメッシングしてから、パートごとに`Located()`で
   配置変換を適用する。
2. テッセレーション結果を読んだ後に`BRep_Tool.Triangulation`が返す
   `Poly_Triangulation`（`tri`）を明示的に`delete`していたが、これは下地の
   TopoDS_TShapeが所有する共有データであり、単一シェイプモデルでは各Faceが
   1回しか読まれないため実害が無かった。XCAFアセンブリで同じ形状定義を複数
   パートが参照する場合、片方のパートの読込後に`tri`を明示deleteすると、
   もう片方のパートが後で同じ面を読んだ時には既にデータが破棄されており、
   `NbNodes`/`NbTriangles`がゴミ値（巨大値・負値）を返すヒープ破損として
   顕在化する（実測: 2個目のcore_pinで`nNodes`が負の巨大値になり
   `Float32Array`のlengthが不正になってクラッシュ）。対策: `tri`は明示的に
   delete しない（Faceが破棄される際のライフサイクルに委ねる）。
3. 抽出した`TopoDS_Shape`（`TNaming_NamedShape`属性経由）は、XCAF文書
   （`TDocStd_Document`）がラベル経由で内部所有する形状データを参照している。
   読込直後に文書を`delete`すると、`Located()`で配置変換した「コピー」で
   あっても元データが解放されヒープ破損する（3パート目以降で顕在化する
   use-after-free）。文書はモデル全体（全パートの破棄）と寿命を共にする
   必要があるため、`LoadedModel.xcafDoc`として持ち回し、`disposeModel`で
   他のパート形状を破棄した後に破棄する。

上記いずれも、実ブラウザで「STL読込→(同一ページで)mini_mold.step読込」
という逐次シナリオで再現・修正確認済み（クラッシュ/ハングの再現条件が
単発読込では現れず、複数モデルの読込を跨いだ場合にだけ顕在化した）。

色（`XCAFDoc_ColorTool`）は`GetColor_1`〜`GetColor_8`が静的メソッドとして
バインドされており、同じ「出力引数パターン」で取れる想定だったが、
`ct.SetColor(label, color, XCAFDoc_ColorType.XCAFDoc_ColorSurf)`で色を
設定したテストファイル（mini_mold.step）に対して`IsColor(label)`が`false`を
返し、shape-definitionラベル・コンポーネントラベルのいずれでも色を検出
できなかった（原因未特定 — STEP往復時の色の実際の格納場所が想定と異なる
可能性がある）。現状は常に`color: null`（フロントのデフォルト表示色）で
妥協しており、今後の調査課題として残す。

### embind オブジェクトの寿命管理（対応済み）

`del(objs...)` ヘルパーで一括破棄する方針に統一。実ブラウザで「派生オブジェクトを
取り出した後に元オブジェクトを delete」しても派生側は生き続けることを検証した
（reader/box/triHandle/loc/tri.Node()の一時点/cyl・axis等）。**唯一の例外**:
`TopExp_Explorer.Current()` の戻り値は、`TopoDS.Face_1()` 等でキャストした後に
delete すると WASM ヒープごと破壊される（実測でクラッシュ確認、
`wasmTable.get(...) is not a function` で無関係な後続呼び出しが落ちる）。
Explorer 自体はループを抜けたら delete して良い。

対応済み: `readXsShape`/`readStlShape` の reader、`computeBBox` の box/corner、
`loadModel` の mesher/explorer、`buildMeshPack` の面ごと・頂点ごと・三角形ごとの
一時オブジェクト（最大の漏れ源だった `tri.Node(i)` の生点、頂点数スケール）、
`resolveShape`/`distance`/`faceInfo` の計測ホットパス（owned/borrowed契約で
point参照の一時Vertexのみ破棄し、model.faces の永続Faceは保護）。

### エッジ・頂点スナップ（対応済み）

STEP/IGES（`format='brep'`）で `picking.ts`（本家と無改造で共有）のエッジ/頂点
スナップが有効。`loadModel` で面と同じ手法（`TopExp_Explorer`走査）で edges/vertices
配列も構築し（STLは対象外 — 下記）、`buildMeshPack` が `p0:vertices`（B-rep頂点の
真値座標）と `p0:edges`（線分ペア、`edgeRanges`付き）を埋める。`resolveShape`/
`edgeInfo` も edge/vertex 参照に対応（長さ・円形エッジの半径/中心/軸）。

**罠(実測でクラッシュ確認済み・設計変更の理由)**: 当初は backend の
`_edge_polyline` と同じ手法（隣接面のテッセレーションから
`BRep_Tool.PolygonOnTriangulation` でメッシュ一致の離散化を取る）を試みたが、
このWASMビルドでは特定の面/エッジの組み合わせで `PolygonOnTriangulation` が
不正なノードインデックス（範囲外の巨大な値）を返しWASMヒープを破壊した
（面のTriangulationをテッセレーション用とエッジ抽出用で二重にfetch/deleteした
のが原因かと最初疑い、面ごと1回のfetch/deleteに直しても再現 — バインディング
自体が一部ケースで信頼できない）。**代わりに `BRepAdaptor_Curve` +
`GCPnts_QuasiUniformDeflection` でエッジ自身のパラメトリック曲線を独立に
サンプリングする方式に変更**（面のテッセレーションに一切触れない）。面メッシュの
分割点と厳密には一致しないが、エッジはピッキングの画面上スナップ候補判定にしか
使わず、実測値は常に edgeInfo/distance が B-rep 実体から真値計算するため
正確性には影響しない。実ブラウザで全エッジ・複数モデル・反復読込を検証しクラッシュ0件。

STLは `StlAPI_Reader` が三角形ごとに独立Faceを作る設計（既知の性能問題）で
edges/vertices を作ると三角形数スケールになり実用にならないため対象外
（`format='mesh'`で計測自体も無効なので実害なし）。

### 肉厚チェック（対応済み）

backend の `thickness.py`（trimesh + embree、レイ法＋ローリングボール法）と同じ
アルゴリズムを `src/thickness.ts` で `three-mesh-bvh` により再実装。**B-repではなく
表示メッシュ（MeshPack の positions/normals/indices）だけを見る**ため、STEP/IGES
（brep）・STL/3MF（mesh）のいずれでも同じ経路で動く。フロントエンド（`main.ts`
の肉厚GUI・`viewer.ts` のヒートマップ描画）は本家から無改造で流用済みで、
`api.ts` の `fetchThickness` スタブを実装に差し替えるだけで繋がった。

- **ray法**: 頂点の内向き法線方向にレイを飛ばし最初のヒットまでの距離
- **ball法**: 内向き法線上の中心を持つ球が固体内部に収まる最大半径を二分探索
  （中心から表面への最近傍距離 >= 半径 が「収まる」条件、ray法の結果を探索上限に使う）
- 許容誤差(eps/tol)はモデルのbbox対角から算出し固定値にしない
  （エッジサンプリングのdeflectionで踏んだ罠と同じ教訓）

**罠（実測で確認）**: `MeshBVH.raycastFirst(ray)` は `materialOrSide` 引数を
省略するとデフォルトでバックフェースカリングされ、レイの飛んでいく先の面が
レイと同じ向き（反対側の内壁）だと何もヒットしない（全頂点が「データなし」
になる）。`THREE.DoubleSide` を明示的に渡す必要がある。

**罠（Codexレビュー指摘、実測で確認・修正済み）**: `new MeshBVH(geometry)` は
既定でビルド高速化のため `geometry.index` をその場で並べ替える。この index は
viewer/picker と共有している MeshPack 由来の Uint32Array そのものなので、
`{ indirect: true }`（picking.tsが同じ理由で使っているのと同じオプション）を
付けないと肉厚計算後にピック/計測が誤ったB-rep面を指すようになる。

**罠（Codexレビュー指摘、実測で確認・修正済み）**: `buildMeshPack` の法線は
三角形分割(`BRep_Tool.Triangulation`)の巻き順から計算しているが、この巻き順は
面の下地サーフェス基準で固定されており、`TopAbs_REVERSED` な面（STEP/IGESの
ブーリアン演算後には普通に存在する — mini_mold.step でも実測で隣接面が
FORWARD/REVERSED混在していることを確認）では実際の外向き法線が逆になる。
`face.Orientation_1().value`（`TopAbs_Orientation` enum、他の enum 比較と同じ
`.value` 参照パターン）で判定し、REVERSEDな面は三角形のb/c頂点を入れ替えて
巻き順ごと外向きに揃える（法線だけ反転して巻き順を放置すると描画・ピック側の
表裏判定と食い違う）。この修正で ball法 の最大値が 14.999→1.58 に変化（修正前は
向きを誤ったレイが遠くの無関係な面まで飛んで生じた見せかけの値だった）。

この機能（`thickness.ts`）自体は既に抽出済みの表示メッシュのtyped array上で
完結する純JS計算（three.js / three-mesh-bvh のみ）で、OCCT WASMオブジェクトには
一切触れないため、embind の delete順序問題（エッジ・頂点スナップで踏んだ罠）は
原理的に発生しない（法線の向き修正自体は `occt.ts` 側の既存バグ）。

実ブラウザで STEP(mini_mold.step)・STL(ribbed_plate.stl) 双方、モデル切替の
繰り返し・method切替(ray⇄ball)の反復でクラッシュ0件・厚み値が正の有限値である
ことを確認済み。

### 2D図面（DXF、対応済み）

backend の `drawing.py`（ezdxf でDXFを読みSVG化＋スナップ点抽出）と同じ出力契約
（SVG文字列 + bbox2d + snapPoints）を `src/dxf.ts` で再現。パーサは純JSの
`dxf-parser`（依存はloglevelのみ）、SVGレンダリングとスナップ点抽出・INSERT
（ブロック参照）のワールド座標への平坦化は自前実装（backendのezdxf.addons.drawing
やvirtual_entities()相当のライブラリ機能がJS側に無いため）。フロントエンド
（`main.ts`の2D図面ロード分岐・`drawing2d.ts`のpan/zoom/スナップ計測UI）は本家から
無改造で流用済みで、`api.ts` の `fetchDrawingSvg` スタブと `uploadModel` の
`.dxf`分岐を実装するだけで繋がった。

対応エンティティ: LINE, CIRCLE, ARC, LWPOLYLINE/POLYLINE（bulgeによる円弧
セグメント含む）, POINT, INSERT（ネスト展開、深さ4まで）。非一様スケール
（xScale≠yScale）のINSERT配下では円/弧が理論上は楕円になるため、その場合のみ
点列（`ellipsePoly`）にサンプリングして近似する（3MFのミラー変換対応と同じ
「まず判定してから経路を分ける」設計）。DWGは対象外（ODA File Converterが
非再配布ネイティブバイナリでWASM化不可、README冒頭の既知の欠落）。

座標系はbackendのezdxf正規化（viewBoxをmax=1e6にスケール）とは異なる独自の
1:1スケール（`to_svg(x,y) = [x-xmin, ymax-y]`）だが、SnapPointの契約
（svg座標とdxf座標を両方持つ）が同じなので `drawing2d.ts` は無改造で動く。

**罠（実測で確認・回避）**: LWPOLYLINE/POLYLINEのbulge（`tan(内角/4)`）から
円弧の中心を求める式は、素朴に符号を詰めると弦の逆側に中心が出る典型的な
実装ミスを踏んだ（quarter-circle等の既知形状で解析的に検算して発覚）。
弦に垂直な単位ベクトルへの掛け算に余計な`-1`が混入していたのが原因。

**罠（Codexレビュー指摘、実測で確認・修正済み、計3件）**:
1. bboxがbulge付きセグメントの頂点だけを見ており、円弧が弦の外側に膨らむ
   分（半円なら弦中点から半径ぶん）を取りこぼしていた。ARC単体と同じ
   `arcExtrema`で弧の実際の極値を計算するよう修正。
2. 負のbulge（時計回りの弧）で `endDeg-startDeg` を「常に正になるまで360足す」
   処理をすると劣弧が逆側の優弧（270度の大回り）になっていた。実際の掃引角の
   大きさはbulge自体（`4*atan(bulge)`）から直接わかるので、符号付きのまま使う
   設計に変更。sweep-flagは「start→mid→end」3点の外積符号から機械的に決める
   方式に変更し、DXF側のCCW/CW・鏡映変換の向きに関する場合分けを排除した
   （この手の場合分けで一度符号を誤ったため、変換に依存しない頑健な方式にした）。
3. ARCの0/360またぎ判定で、90度刻みの候補角に+360した版が不足しており
   （例: 350°→170°は530°まで伸びるが90°自体はその範囲外）、一部の象限点を
   取りこぼしていた。候補を0〜720まで広げて解消。
   さらにこの過程で、dxf-parserの `startAngle`/`endAngle` が度ではなく
   **ラジアン**で返ることが実測で判明（度だと誤解すると全く違う角度になる）。
   `angleLength` も信用せず、度に変換した上で自前でCCW正規化して使うよう修正。

**罠（Codexレビュー指摘、実測で確認・修正済み、2巡目 計3件）**:
1. INSERTの変換合成（`composeXform`）が「回転角+軸ごとスケール」への
   分解・再構成を都度行っており、鏡映(xScale<0等)を経由すると「回転にすでに
   折り込まれた反転」と「符号付きスケールの反転」を二重適用してしまう
   ケースがあった。分解・再構成を経由しない標準的な2x3アフィン行列
   （線形部a,b,c,d＋平行移動dx,dy）に設計変更し、合成を単純な行列積にした
   （回転・スケール・鏡映の合成を都度再分解する設計そのものが曖昧さの
   温床だったため、表現形式ごと変えて原理的に解消した）。
2. 非一様スケール（xScale≠yScale）のINSERT配下にbulge付きLWPOLYLINE/
   POLYLINEがあると、局所座標系での円弧（bulge）が変換後は楕円になるにも
   関わらず頂点だけ変換してbulge値をそのまま残していた。CIRCLE/ARCの
   `ellipsePoly`フォールバックと同じ考え方で、局所座標系でセグメントごとに
   直線/円弧を密にサンプリングしてから点ごとに変換する方式に修正。
   （鏡映のみ・一様スケールの場合はbulgeの符号を反転するだけで正しく
   表現できるため、そちらは従来通り厳密なまま。）
3. スナップ点のsvg座標を0.1単位に丸めていたため、モデル単位が小さい図面や
   ズームインした状態でクリックがスナップに乗らないことがあった。描画
   ジオメトリと同じ精度（丸めなし）で保持するよう修正。

**罠（Codexレビュー指摘、実測で確認・修正済み、3巡目 計2件）**:
1. 可視性フラグ(グループコード60、`visible === false`)を無視して非表示の
   補助線等まで描画・スナップ対象にしていた。フラット化ループの先頭で
   スキップするよう修正。
2. 非一様スケールのINSERT配下でCIRCLE/ARCを`ellipsePoly`（点列近似）に
   落とすと、`collectSnaps`に対応するケースが無く中心スナップが消えていた
   （穴/シンボルをスケール付きブロックで表現する図面で計測モードが使えなく
   なる）。`ellipsePoly`に変換後のワールド座標での中心を持たせ、center
   スナップを復元。

実ブラウザで、非表示エンティティが実際にbbox/スナップから除外されること、
非一様スケール配下のCIRCLEの中心スナップが復元されていることを個別に確認。

**罠（Codexレビュー指摘、実測で確認・修正済み、4巡目 計2件）**:
1. 非表示判定がエンティティ個体の可視性フラグ(グループコード60)だけを見て
   おり、レイヤー自体のOFF/FROZEN状態（実務ではこちらの方が一般的な非表示
   運用）は見ていなかった。`dxf.tables.layer.layers`を受け取り、エンティティ
   の所属レイヤーがOFF(`visible===false`)またはFROZENなら併せてスキップする
   よう修正。
2. 非一様スケール配下のARCを`ellipsePoly`に変換した際、centerスナップは
   1件目の修正で復元したが、弧の端点(start/end)スナップが無いままだった。
   サンプリング済み点列の先頭/末尾（変換後の弧の端点そのもの）を`end`
   スナップとして追加（CIRCLE由来の場合は先頭≒末尾で同一点が重複登録
   されるだけで実害なし）。

実ブラウザで、レイヤーOFF/FROZENの線が実際にbboxから除外されることを
個別のDXF（可視レイヤー・OFFレイヤー・FROZENレイヤーの3本の線）で確認。

**罠（Codexレビュー指摘、実測で確認・修正済み、5巡目）**: MINSERT
（`columnCount`/`rowCount`による配列配置）の行/列間隔(`columnSpacing`/
`rowSpacing`)は「挿入基点間の距離」であり、DXF仕様上ブロックの
xScale/yScaleは掛からず回転だけが影響する。以前の実装はoffset（平行移動
のみ）をスケール込みの合成変換の内側に合成していたため、spacingにまで
xScale/yScaleが誤って掛かっていた。回転のみのXformでoffsetを変換してから
INSERTのposition(平行移動)に加算する設計に変更し、スケールの影響を
受けずに回転だけ反映させるよう修正。

実ブラウザで、xScale=2・columnSpacing=10・columnCount=3のMINSERTを検証し、
配置間隔がスケールされず10のまま(bbox: 3個目の中心x=20、修正前なら
スケールされてx=40相当になっていたはず)であることを確認。

実ブラウザで、既存のplate_drawing.dxf（矩形+穴2個+中心線）と、ARC単体・
bulge付きLWPOLYLINE（角丸長方形）・ブロック参照2箇所（1つは回転+スケール付き）・
単独POINTを含むrich_drawing.dxfの両方でロード→SVG生成→エンティティ数の一致
（想定通りのpath/line/circle数）を確認。さらに実際のUI操作（計測モードで穴の
中心をクリック）で2つの穴（既知距離100mm）の距離計測が正確に「100.000」と
出ることを確認し、スナップ計測が実使用フローで動くことを実証済み。合成
ジオメトリ（正負bulgeの半円、0/360をまたぐ270度ARC、非一様スケール配下の
bulge半円）でbbox・弧の膨らむ向き・楕円近似の大きさが解析的な期待値と一致
することも個別に検証済み。

### OCCTのWeb Worker化（対応済み）

OCCT-WASM（`occt.ts`、数百MBのヒープを確保する重いエンジン）を
`occt.worker.ts` に隔離し、[Comlink](https://github.com/GoogleChromeLabs/comlink)
経由のRPCで呼ぶよう変更。`api.ts` が唯一の呼び出し元で、
`Comlink.wrap(new Worker(new URL('./occt.worker.ts', import.meta.url), {type:'module'}))`
経由で `loadModel`/`meshPackOf`/`distance`/`faceInfo`/`edgeInfo`/`disposeAll`
を呼ぶ。3MF(`threemf.ts`)・DXF(`dxf.ts`)は軽量な純JSなのでメインスレッドのまま
（Worker化の目的は「重いWASM計算でUIスレッドをブロックしないこと」であり、
これらはそもそも重くないので対象外）。

occt.ts自体のロジック・delete順序等の罠コメントは無改造でそのまま流用 —
opencascade.jsのWASM初期化やembindの挙動は実行コンテキスト（メインスレッド
かWorkerか）で変わらないことを、まず最小のスパイク（Worker内でinitOcct()を
呼ぶだけの使い捨てファイル）で確認してから本移植した。

Vite設定(`vite.config.ts`)には既に `worker: { format: 'es' }` があり、
`new Worker(url, {type:'module'})` パターンがビルド・devサーバ双方でそのまま
動くことを確認済み（`npm run build` で `occt.worker-*.js` が独立チャンクとして
出力され、メインの `index-*.js` はサイズが縮小する）。

**検証（実測、本来の目的そのものを確認）**: モデルロード中にメインスレッドの
`requestAnimationFrame` カウンタが刻み続けるか（=UIスレッドがブロックされて
いないか）を実ブラウザで確認。Worker化前は同期的な重いWASM呼び出しの間
メインスレッドが止まっていたはずだが、Worker化後はロード中もフレームが
単調に進み続けることを確認した。加えて、STEP/STLの計測・肉厚チェック・
ピック・DXFのスナップ計測など既存機能一式が開発サーバ・本番ビルド
（`npm run build` → `npm run preview`）の両方で回帰なく動作することも確認済み。

**罠（Codexレビュー指摘、実測で確認・修正済み）**: `loadModel` は
`initOcct()`/`contentHash()` 等で複数回awaitするため、2つのアップロードが
重なると後発（より小さい/速い）の読込が先に完了してUIの「現在のモデル」に
なった後、先発（遅い）の読込がその後で完了して `evictOthers(id)` を呼ぶと、
UIが現在と思っているモデルまで `_models` から巻き込んで消してしまい、
以降の `fetchMesh`/計測が `unknown model id` で失敗する。世代カウンタ
（`_loadGen`）を導入し、「自分の開始後により新しい読込が完了していたら
evict/コミット時のevictをスキップする」よう修正（例外は投げない —
`main.ts` のエラーハンドラはstale判定なしに表示中HUDを上書きするため、
ここで失敗させると現在正常に表示されているモデルの上にエラーメッセージが
出てしまうため）。

実ブラウザで、意図的なテストフック（`__stallNextLoad`、gen採番後に人為的な
遅延を入れる）を使い、先発の読込が後発より遅く完了する状況を決定的に再現。
修正前は後発モデルの`fetchMesh`が`unknown model id`で失敗することを確認し、
修正後は失敗しなくなることを確認した。

**罠（Codexレビュー指摘、実測で確認・修正済み、2件）**:
1. 上記の世代ガードは「supersededされた読込のevictをスキップする」だけで、
   その読込自身が作った新しいモデル（shape/faces/meshPack等のembind
   オブジェクト）は`_models`に入れたまま放置していた。UIには一生表示されない
   のに、後で何かの読込がevictOthersするまでWASMヒープに残り続ける
   （数百MBのOCCTヒープを切り離す狙いと逆行する）。supersededな場合は
   `_models`に入れずその場でdisposeするよう修正。
2. `api.ts`の`uploadModel`がDXF/3MFへ切り替える際、`occtWorker.disposeAll()`
   を`await`していたため、OCCT Workerが大きいSTEP/STLの重いパースで
   詰まっている間はそのRPCがキューの後ろで待たされ、既にパース完了している
   DXF/3MFの表示までブロックされていた（Worker化でUIスレッドは守れても、
   Worker自体がビジーだと「切替」操作が巻き込まれる）。破棄はメモリ解放が
   目的で戻り値のmetaに影響しないため、await せず投げっぱなしにするよう修正。

実ブラウザで、supersededされたモデルが`_models`に残らずdisposeされること
（`fetchMesh`が期待通り失敗すること）、OCCT側を人為的に遅延させても
DXFへの切替が待たされず完了することを確認した。

**罠（Codexレビュー指摘、実測で確認・修正済み、P1×2）**: `occt.ts`内の
`_loadGen`は「同じローダー内」のレース（STEP同士等）しか見ておらず、
フォーマットを跨いだ切替（3MF→STEP、STEP→3MF等）のstale完了には無防備
だった。例: 3MFアップロードが後発のSTEPアップロードにsupersededされても、
staleな3MF側の`uploadModel`は`load3mf`完了後にレジュームして
`occtWorker.disposeAll()`を呼んでしまい、既に表示されている新しいSTEP
モデルをWorker側から消してしまう（逆方向＝staleなSTEPが
`disposeAllThreeMf()`を呼んで現在の3MFを消すケースも同様）。`main.ts`の
`loadGen`と同じ考え方で、`api.ts`側にも独自の世代カウンタ（`_uploadGen`）
を持たせ、「自分より新しい`uploadModel`呼び出しが完了していたら他
フォーマットの破棄をスキップする」よう修正。

実ブラウザで、意図的なテストフック（`__stallNextUpload`、gen採番後に人為的な
遅延を入れる — occt.tsの`__stallNextLoad`と同じ流儀）を使い、3MF→STEP・
STEP→3MFの両方向で「先発が後発より遅く完了する」状況を決定的に再現。
修正前は両方向とも現在のモデルが巻き込まれて`unknown model id`で失敗する
ことを確認し、修正後は両方向とも失敗しなくなることを確認した。

**罠（Codexレビュー指摘、実測で確認・修正済み）**: 上記の`_uploadGen`ガードは
「STEP/IGES/STLがsupersededされた側」の破棄呼び出し（`disposeAllThreeMf`/
`disposeAllDxf`）はスキップするが、そのSTEP自身が作った新しいモデルの扱いは
考慮していなかった。`occt.ts`内の`_loadGen`は「同じOCCTローダー内」の
レースしか見ないため、STEP読込が`initOcct()`/`contentHash()`でawait中に
3MF/DXFへの切替が起きてsupersededされても、他にOCCT読込が無ければ
`gen === _loadGen`が成立してしまい、このSTEPモデルは普通に`_models`へ
コミットされてしまう。UIには一生表示されないのに、`disposeAll()`が呼ばれる
まで（他の何らかのOCCT読込がevictOthersするまで）WASMヒープに残り続ける。
`disposeAll()`で一括破棄すると、その後に本当に始まった正当な新しいOCCT
読込まで巻き込みかねないため、`occt.ts`に`disposeById(id)`を追加し、
`api.ts`側が「このIDだけ」を指定して確実に破棄するよう修正。

実ブラウザで、`__stallNextLoad`（occt.ts側の遅延フック）でSTEP読込を
occt.ts内部で足止めしている間にDXFへ切替、STEP読込が再開してもその
モデルが`disposeById`で破棄され`fetchMesh`が期待通り失敗すること
（修正前はコミットされたまま残り`fetchMesh`が成功してしまうこと）を確認した。

**罠（Codexレビュー指摘、実測で確認・修正済み、6巡目）**: 上記の
`disposeById`は「このアップロード呼び出しが`loadModel`内で新規にパース・
コミットしたモデル」だけを対象にすべきだったが、`occt.ts`の`loadModel`は
`contentHash`が既存モデルとヒットした場合（同一ファイルの再アップロード等）
は新規パース・コミットを一切せず既存モデルをそのまま返す（cache-hit）。
このcache-hit応答も同じ`meta.id`を持つため、supersededな呼び出しが
cache-hitで戻ってきた場合、それが指すidは「自分専用の孤児」ではなく
「他の呼び出し（現在表示中かもしれない）と共有中のモデル」であり得る。
修正前のコードはこの区別をせず無条件に`disposeById(meta.id)`していた
ため、同一ファイルをほぼ同時に2回アップロードすると、後発（速い）が
新規コミットして「現在」になった直後に、先発（遅い、supersededされた）が
cache-hitで同じidを返し、現在表示中のモデルをdisposeByIdで消してしまう
事故が起きた。`ModelMeta`に`cached`フラグを追加し（`occt.ts`の
`metaOf(model, cached)`がcache-hit時は`true`を返す）、`api.ts`側は
`meta.cached`が真の時は`disposeById`をスキップするよう修正。

実ブラウザで、同一STEPファイルを`__stallNextLoad`で先発だけ遅延させつつ
ほぼ同時に2回アップロードし、後発（無遅延）が先にコミットして「現在」に
なった後、先発がcache-hitで同じidを返す状況を決定的に再現。修正前は
現在表示中のモデルが消え`fetchMesh`が`unknown model id`で失敗すること
（cached判定自体もこの回で初めて`ModelMeta`に実装されるまで存在せず、
常に`undefined`だった）を確認し、修正後は`meta.cached===true`のケースで
disposeをスキップして表示中モデルが生き残り`fetchMesh`が成功し続ける
ことを確認した。

**罠（Codexレビュー指摘、実測で確認・恒久対策済み、7巡目）**: 6巡目の
「`meta.cached`ならdisposeByIdをスキップ」は逆方向のケースを見落として
いた。同一ファイルのほぼ同時アップロードで、先発（無遅延）がWorker内で
先に処理され新規コミット（`cached:false`）した直後に、後発が
occt.ts側では先発の後に処理されてcache-hitし、同じidを引き継いで
「現在」になる。先発は自分がresolveした時点で「後発が始まっているので
自分はstale」と気づくが、6巡目の判定基準（`cached:false`＝新規コミットの
張本人）だけでは「自分専用の孤児」と誤解し、無条件にdisposeByIdして
しまう。実際にはそのidを後発がcache-hitで引き継ぎ現在表示中にしている
ため、後発が依拠するモデルが消えてしまう。

個別のシナリオを都度パッチするのは同じ根本原因（複数のsupersededされ得る
呼び出しが同じidを共有し得る）のvariantを追いかけ続けるだけなので、
恒久対策として`LoadedModel`に`claimGen`（このidを最後に見た呼び出しの
`api.ts`側`_uploadGen`値、新規コミット時・cache-hit時の両方で`max()`更新）
を持たせ、`disposeById(id, gen)`は「呼び出し時点でも`claimGen`が渡された
genのままである場合だけ」実際に破棄するよう変更。安全性の判断をid単位の
claimGen比較に一本化したことで、`api.ts`側は`meta.cached`を見ずに常に
自分のgenを渡してdisposeByIdを呼べばよくなった（cache-hit/新規コミット
いずれの場合も安全）。

実ブラウザで、同一STEPファイルを無遅延でほぼ同時に2回アップロードし、
先発が新規コミットした直後に後発がcache-hitで引き継ぐ状況を再現。
6巡目時点のコードでは現在モデルが消え`fetchMesh`が`unknown model id`で
失敗すること、claimGen導入後は生き残ることを確認した。既存の全レース
テスト（4〜6巡目分）も回帰無く通ることを再確認した。

**罠（Claude(GitHub Action)レビュー指摘、実測で確認・修正済み）**: `main.ts`の
`loadFile()`は`try`内の全returnポイントで`gen !== loadGen`のstale判定を
律儀に行っていたが、`catch`節だけこの判定が抜けていた。壊れたファイル・
未対応形式などで`uploadModel`が正当にthrowするケースで、先発（遅い）の
読込が後発（速い、正常）の読込にsupersededされた後にthrowすると、`catch`が
無条件にHUDへエラーメッセージを書き込み、既に正しく表示されている後発
モデルのHUDを上書きしてしまう（3Dシーン自体は後発のままなので、表示と
HUDが矛盾する）。`catch`の先頭に`if (gen !== loadGen) return`を追加。

実ブラウザで、未対応拡張子ファイル（先発、`__cadStallLoad`で遅延）と正規の
STEPファイル（後発、無遅延）をほぼ同時にdropし、後発が先に成功表示された
直後に先発がthrowする状況を再現。修正前はHUDが先発のエラーメッセージで
上書きされること、修正後は後発の成功表示のまま保たれることを確認した。

## 開発

```bash
npm install
npm run dev            # http://localhost:5173
npx tsc --noEmit       # 型チェック

# 実ブラウザでのスパイク検証（要 playwright + chromium）
npm run dev &          # 別ターミナルで
python3 spike_verify.py
```

## WASM 移植の罠（実測メモ）

opencascade.js **1.1.1**（単一 63MB バンドル）で踏んだブラウザ固有の落とし穴。
Node では顕在化しない。

1. **Vite の `.wasm` 組み込みハンドラに食われる** — パッケージ `index.js` の
   bare wasm import を Vite が ESM 実体化しようとして失敗。回避: `index.js` を使わず
   `opencascade.js/dist/opencascade.wasm.js`（ファクトリ）を直読み + wasm を `?url` で
   受けて `locateFile` に渡す。`vite.config.ts` で `optimizeDeps.exclude`。
2. **`FS.createDataFile` の `canOwn=true` 厳禁** — ブラウザ由来 `Uint8Array` の
   バッファ所有権を emscripten が奪い、OCCT 読込時にデータ化けで `ReadFile` が
   `RetError`。`FS.writeFile`（コピーする）を使う。
3. **仮想パスのベース名が長いと `ReadFile` が 0 roots** — `/model.step` は失敗、
   `/m.step` は成功。FS 内容は byte 一致でも名前長で挙動が変わる（embind/OCCT の
   ファイル名マーシャリングのバグ）。短い固定名を使う。
