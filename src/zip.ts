/**
 * 最小限の ZIP リーダー（3MF はただの ZIP コンテナ）。
 * 依存ライブラリを増やさず、ブラウザ標準の DecompressionStream('deflate-raw') で
 * method=8(deflate) を展開する。method=0(store) は無圧縮のためそのままコピー。
 *
 * 対応外: ZIP64（4GB超）、暗号化。3MF はどちらも実質使わないため割り切る。
 * 中央ディレクトリを正として読む（ローカルヘッダのサイズはstreaming-write時に
 * 0埋めされることがあるため信用しない。データ開始位置の算出にのみ使う）。
 */

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50

export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // EOCD をファイル末尾から後方探索（コメント欄があるため固定オフセットでは読めない）。
  const maxScan = Math.min(bytes.length, 65536 + 22)
  let eocdOffset = -1
  for (let i = bytes.length - 22; i >= bytes.length - maxScan; i--) {
    if (i < 0) break
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) throw new Error('ZIP: End Of Central Directory が見つからない（壊れたファイル）')

  const cdEntryCount = view.getUint16(eocdOffset + 10, true)
  const cdOffset = view.getUint32(eocdOffset + 16, true)

  const result = new Map<string, Uint8Array>()
  let p = cdOffset
  for (let i = 0; i < cdEntryCount; i++) {
    if (view.getUint32(p, true) !== CD_SIG) {
      throw new Error('ZIP: central directory が破損している')
    }
    const method = view.getUint16(p + 10, true)
    const compSize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localHeaderOffset = view.getUint32(p + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen

    // ローカルヘッダの name/extra 長は中央ディレクトリと異なりうるので、
    // データ開始位置はローカルヘッダ側から算出する。
    const lfhNameLen = view.getUint16(localHeaderOffset + 26, true)
    const lfhExtraLen = view.getUint16(localHeaderOffset + 28, true)
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen
    const raw = bytes.subarray(dataStart, dataStart + compSize)

    if (name.endsWith('/')) continue // ディレクトリエントリ

    let data: Uint8Array
    if (method === 0) {
      data = raw.slice()
    } else if (method === 8) {
      data = await inflateRaw(raw)
    } else {
      throw new Error(`ZIP: 未対応の圧縮方式(method=${method}): ${name}`)
    }
    result.set(name, data)
  }
  return result
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(
    new DecompressionStream('deflate-raw'),
  )
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}
