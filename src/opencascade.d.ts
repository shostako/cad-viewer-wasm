// opencascade.js 1.1.1 は型を同梱しないため最小のアンビエント宣言を置く。
// OCCT の巨大な API 面を厳密型付けする実益は薄く、occt.ts 側で any 運用する。

// emscripten ファクトリ本体（index.js を経由せず直接読む）
declare module 'opencascade.js/dist/opencascade.wasm.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory: (opts: { locateFile?: (path: string) => string }) => Promise<any>
  export default factory
}

// Vite の ?url サフィックス: wasm を URL 文字列として受ける
declare module '*.wasm?url' {
  const url: string
  export default url
}
