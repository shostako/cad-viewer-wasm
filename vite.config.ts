import { defineConfig } from 'vite'

// cad-viewer-wasm: backend レス。opencascade.js(WASM OCCT)をブラウザで直接動かす。
export default defineConfig({
  // GitHub Pages 等サブパス配信でも動くよう相対パスにする（絶対パス '/' 決め打ちだと
  // https://user.github.io/repo/ のようなサブディレクトリ配信で assets が 404 する）。
  base: './',
  // opencascade.js の index.js は `import wasm from './...wasm'` で wasm を URL として
  // 受け取り locateFile に渡す。Vite に .wasm をアセットURLとして扱わせる
  // （既定の WebAssembly.instantiate 経路に載せない）。
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    // 63MB の wasm を esbuild で pre-bundle させると壊れる/遅い。除外して素通し。
    exclude: ['opencascade.js'],
  },
  build: {
    // top-level await / 大きな wasm を許容
    target: 'esnext',
  },
  worker: {
    format: 'es',
  },
})
