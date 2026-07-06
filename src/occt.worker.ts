/**
 * OCCT-WASM を Web Worker 上で動かすためのエントリポイント。
 *
 * occt.ts（opencascade.js ラッパー、数百MBのヒープを確保する）をそのまま
 * Worker側に閉じ込め、Comlink経由でRPC公開する。狙いは README記載の通り
 * 「400MB+のヒープでUIスレッドをブロックしないため」— STEP読込・
 * テッセレーション・距離計測などの重い同期WASM呼び出しをメインスレッドから
 * 追い出す。
 *
 * api.ts はこのファイルを `new Worker(new URL('./occt.worker.ts', ...), {type:'module'})`
 * + `Comlink.wrap(worker)` で呼び出す。occt.ts自体のロジック・罠コメントは
 * 無改造でそのまま流用（実行コンテキストがメインスレッドかWorkerかで
 * opencascade.jsのWASM初期化やembindの挙動は変わらないことを実測確認済み
 * — スパイク検証でWorker内からinitOcct()が問題なく動くことを確認してから
 * この移植を行った）。
 */
import * as Comlink from 'comlink'
import { loadModel, meshPackOf, distance, faceInfo, edgeInfo, disposeAll, disposeById, __stallNextLoad } from './occt'

const api = { loadModel, meshPackOf, distance, faceInfo, edgeInfo, disposeAll, disposeById, __stallNextLoad }

export type OcctWorkerApi = typeof api

Comlink.expose(api)
