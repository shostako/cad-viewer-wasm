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
- アセンブリ展開・色・名前（XCAF）
- 肉厚チェック（three-mesh-bvh でレイ法を移植予定）
- 2D 図面（DXF は JS パーサ、DWG は WASM 化不可で脱落）
- OCCT を Web Worker に逃がす（400MB+ ヒープで UI スレッドをブロックしないため）
- **embind オブジェクトの体系的な寿命管理**: opencascade.js の全 `new oc.X()` は GC
  されず明示 `.delete()` が要る。計測ホットパス(distance/faceInfo)と保持モデル
  (evictOthers)は対応済みだが、`loadStep` の面ごとの一時オブジェクト
  (`TopLoc_Location` / triangulation handle / `gp_Pnt`)はロード毎に漏れる。
  Worker 化とセットで scoped-delete ヘルパーか worker 再生成で一括処理する予定
- カスタムビルドで wasm 63MB → 一桁 MB 台

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
