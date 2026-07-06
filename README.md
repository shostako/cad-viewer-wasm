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
- エッジ・頂点スナップ（現状は面ピックのみ）
- **アセンブリ展開・色・名前（XCAF）—調査の結果ブロック中**（詳細は下記）
- 肉厚チェック（three-mesh-bvh でレイ法を移植予定）
- 2D 図面（DXF は JS パーサ、DWG は WASM 化不可で脱落）
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
