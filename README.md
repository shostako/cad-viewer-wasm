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

対応形式: **STEP/IGES**（`occt.ts`、XSControl_Reader系・真値計測あり）、
**STL**（`occt.ts`、StlAPI_Reader・format='mesh'で計測無効）、
**3MF**（`threemf.ts`、OCCTを経由しない純JSのZIP+XMLメッシュ経路・format='mesh'）。
いずれも実ブラウザで読込・描画・dedupを確認済み。

### 未実装（本移植の残）
- **アセンブリ展開・色・名前（XCAF）—調査の結果ブロック中**（詳細は下記）
- OCCT を Web Worker に逃がす（400MB+ ヒープで UI スレッドをブロックしないため）
- カスタムビルドで wasm 63MB → 一桁 MB 台
- （新規判明）StlAPI_Reader は三角形1枚ごとに独立 Face を作る設計のため、
  58万三角形級の大きい STL（`five_spoke_wheel.stl` 等）は実用にならない速度で
  固まる。Web Worker 化やアセンブリ対応と合わせて、大規模STLの扱い（レイヤ分割
  読込 or メッシュ経路への切替）を別途検討する必要あり

### XCAF（アセンブリ展開・色・名前）調査メモ（2026-07-06）

STEPCAFControl_Reader + TDocStd_Document(Handleラップ必須) での読込自体は成功し、
TDF_Label のツリー構造（`NbChildren()`/`FindChild()`）も正しく取れる（実ファイルで
子持ちラベル＝アセンブリ、子無し＝単純パーツという構造を確認済み）。

**ブロッカー**: 以下2点が現行の `opencascade.js` 1.1.1（`builds/opencascade.full.yml`
——公式提供される唯一かつ最も広いプリセット）で欠落している。
1. `TDF_LabelSequence`（`NCollection_Sequence<TDF_Label>`）が未バインド。
   `XCAFDoc_ShapeTool.GetFreeShapes()`/`GetComponents()` の標準入口が使えない
2. `Handle_TDF_Attribute`（汎用）から `Handle_TDataStd_Name`/`Handle_TNaming_NamedShape`
   （具象型）への安全なダウンキャスト手段が見つからない。属性の**存在確認**はできるが
   **値の読み出し**ができない。`DownCast`探索中に1回ネイティブクラッシュを実測
   （`Handle_X` コンストラクタへ汎用Handleを渡す組み合わせの一部が未定義動作）

バインディングは手動列挙でなく libclang による OCCT ヘッダの自動スキャン生成
（`src/generateBindings.py` の `templateTypedefGenerator` 等）。`TDF_LabelSequence`
の typedef 自体は OCCT 側に存在するため、理論上は自動検出されるはずだが、この
ジェネレータのどこかで弾かれている（未特定）。カスタムビルドで直すには Docker
（要起動）+ ジェネレータのソース調査 + 数時間のOCCTコンパイルが必要で、成功保証は
無い。2026-07-06時点でユーザー判断により保留、優先度の低い項目として次回以降に
再検討する。

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

実ブラウザで、既存のplate_drawing.dxf（矩形+穴2個+中心線）と、ARC単体・
bulge付きLWPOLYLINE（角丸長方形）・ブロック参照2箇所（1つは回転+スケール付き）・
単独POINTを含むrich_drawing.dxfの両方でロード→SVG生成→エンティティ数の一致
（想定通りのpath/line/circle数）を確認。さらに実際のUI操作（計測モードで穴の
中心をクリック）で2つの穴（既知距離100mm）の距離計測が正確に「100.000」と
出ることを確認し、スナップ計測が実使用フローで動くことを実証済み。合成
ジオメトリ（正負bulgeの半円、0/360をまたぐ270度ARC、非一様スケール配下の
bulge半円）でbbox・弧の膨らむ向き・楕円近似の大きさが解析的な期待値と一致
することも個別に検証済み。

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
