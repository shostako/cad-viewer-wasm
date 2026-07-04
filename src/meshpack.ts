/**
 * Parser for the backend binary mesh protocol (see backend/app/meshpack.py).
 * Layout: [uint32 headerLen][header JSON][buffer bytes...]
 */

export interface BufferDesc {
  offset: number
  byteLength: number
  count: number
  dtype: 'float32' | 'uint32'
  itemSize: number
}

export interface MeshPackHeader {
  buffers: Record<string, BufferDesc>
  // Phase 1+: groups (faceRanges), edges, etc. arrive here
  [key: string]: unknown
}

export interface MeshPack {
  header: MeshPackHeader
  buffers: Record<string, Float32Array | Uint32Array>
}

export function parseMeshPack(data: ArrayBuffer): MeshPack {
  const view = new DataView(data)
  const headerLen = view.getUint32(0, true)
  const headerText = new TextDecoder().decode(new Uint8Array(data, 4, headerLen))
  const header = JSON.parse(headerText) as MeshPackHeader
  const base = 4 + headerLen

  const buffers: MeshPack['buffers'] = {}
  for (const [name, desc] of Object.entries(header.buffers)) {
    const start = base + desc.offset
    if (desc.dtype === 'float32') {
      buffers[name] = new Float32Array(data.slice(start, start + desc.byteLength))
    } else {
      buffers[name] = new Uint32Array(data.slice(start, start + desc.byteLength))
    }
  }
  return { header, buffers }
}
