# cad-viewer-wasm

ブラウザだけで動く CAD ビューア。OpenCASCADE（OCCT）を WASM（[opencascade.js](https://github.com/donalffons/opencascade.js)）でブラウザ内に読み込み、STEP などの 3D モデルの表示と計測を行う。

公開ページ: https://shostako.github.io/cad-viewer-wasm/

- サーバを持たない純静的サイト。インストールは要らず、URL を開くだけで使える
- 読み込んだファイルはブラウザの中で処理され、PC の外へ送られない（アップロード先が無い）
- 非公開の cad-viewer（Python の backend を持つ版）から分かれた静的配信版。画面側のコードは共通で、データ層だけを WASM 版に差し替えている

## できること

| 形式 | 読込 | 計測 |
|---|---|---|
| STEP（.step / .stp） | OCCT。アセンブリは部品ごとに展開し、部品名をツリーに出す | B-rep から真値（面・エッジ・頂点のスナップ、距離、円エッジの半径と中心） |
| IGES（.iges / .igs） | OCCT | 同上 |
| STL（.stl） | OCCT | 不可（メッシュ形式のため） |
| 3MF（.3mf） | 自前の JS 実装（ZIP + XML） | 不可（メッシュ形式のため） |
| DXF（.dxf） | 自前の JS 実装（dxf-parser + SVG 描画） | 2D 図面上のスナップ計測（端点・中心など） |

表示はメッシュ、計測は B-rep という分担にしている。画面のメッシュは近似なので、STEP / IGES の寸法はクリックした面やエッジを OCCT に問い合わせて、元の形状から計算する。

ほかの機能:

- 断面表示（X / Y / Z 軸、切り口を塞ぐキャップ付き）
- 肉厚のヒートマップ（レイ法 / 内接球法。表示メッシュで計算するので STL / 3MF でも使える）
- 注記（クリックした位置にメモを置く）
- 計測と注記はブラウザの localStorage に保存され、同じファイルを開き直すと戻る
- OCCT は Web Worker で動くので、重いファイルの読込中も画面は固まらない

## 既知の制限

- 初回の読み込みが重い。opencascade.js 1.1.1 の標準ビルド（wasm 約 63MB）をそのまま使っている
- STEP の色は読めない（部品は既定色で表示する）
- 大きな STL（数十万三角形以上）は読込が非常に遅い。OCCT の STL 読込が三角形ごとに面を作るため
- DXF の HATCH は境界線だけ描き、塗りは描かない。境界が楕円弧・スプラインの HATCH は描かない
- DWG、OBJ、PLY は読めない（ファイル選択には出るが、読込時にエラーで知らせる）

## 使い方（ローカル）

Node.js は 20 系なら 20.19 以上、22 系以降なら 22.12 以上（Vite 8 の要件。21 系は使えない）。

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/ に静的ファイルを出力
npm run preview    # ビルド結果の確認
```

ファイルは画面右上の「操作」パネルにある「ファイルを開く」か、画面へのドラッグ＆ドロップで読み込む。`testdata/` に試せるファイルがある（`mini_mold.step` はアセンブリ、`plate_drawing.dxf` は 2D 図面）。

型チェックは `npx tsc --noEmit`。実ブラウザでの通し確認は `spike_verify.py`（Playwright と Chromium が要る。開発サーバを起動した状態で `python3 spike_verify.py`）。

master への push で GitHub Actions がビルドし、GitHub Pages へ配信する。

## 構成

```
src/
  api.ts          データ層の入口。形式ごとに下のローダーへ振り分ける
  occt.ts         opencascade.js のラッパ（STEP / IGES / STL、計測）
  occt.worker.ts  occt.ts を Web Worker で動かす入口（Comlink）
  threemf.ts      3MF ローダー
  dxf.ts          DXF → SVG とスナップ点
  viewer.ts       Three.js の描画
  picking.ts      面・エッジ・頂点のピック
  measure.ts      計測
  section.ts      断面
  thickness.ts    肉厚（three-mesh-bvh）
  drawing2d.ts    2D 図面パネル
  tree.ts         アセンブリツリー
testdata/         試験用ファイルと生成スクリプト
```

移植の設計と、opencascade.js をブラウザで使うときに踏んだ不具合の記録は [docs/porting-notes.md](docs/porting-notes.md) にある。
