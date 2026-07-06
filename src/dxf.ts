/**
 * DXF(2D図面)ローダー（OCCTを経由しない純JS経路）。
 *
 * backend の `drawing.py`（ezdxf でDXF/DWGを読みSVG化＋スナップ点抽出）と同じ
 * 出力契約（SVG文字列 + bbox2d + snapPoints）を、ブラウザ内で完結するJSで再現する。
 * DWGはWASM化不可（ODA File Converterはネイティブバイナリ、再配布不可）のため
 * 対象外（README記載の既知の欠落）。
 *
 * パーサは `dxf-parser`（純JS、依存はloglevelのみ）。SVGレンダリングと
 * スナップ点抽出は自前実装（backendのezdxf.addons.drawingやvirtual_entities()
 * に相当する処理を持たないため）。
 *
 * 対応エンティティ: LINE, CIRCLE, ARC, LWPOLYLINE/POLYLINE(bulgeによる円弧
 * セグメント含む), POINT, INSERT(ブロック参照、ネスト展開)。
 * 座標系: SVGは `0 0 W H`（W,H=bboxの幅高さ、DXF単位そのまま1:1）、
 * to_svg(x,y) = [x-xmin, ymax-y]（y反転）。backendのezdxfビューポート正規化
 * （viewBoxをmax=1e6にスケール）とは異なる独自スケールだが、契約
 * （svg座標とdxf座標を両方持つSnapPoint）は同じなので drawing2d.ts は無改造で動く。
 */
import type { ModelMeta } from './api'
import DxfParser from 'dxf-parser'
import type {
  IDxf,
  IEntity,
  IBlock,
  ILineEntity,
  ICircleEntity,
  IArcEntity,
  ILwpolylineEntity,
  IPolylineEntity,
  IPointEntity,
  IInsertEntity,
} from 'dxf-parser'

export interface SnapPointOut {
  dxf: [number, number]
  svg: [number, number]
  kind: string
}

interface LoadedDrawing {
  id: string
  name: string
  svg: string
  bbox2d: { min: [number, number]; max: [number, number] }
  snapPoints: SnapPointOut[]
}

const _drawings = new Map<string, LoadedDrawing>()
const MAX_SNAP_POINTS = 50000
const MAX_INSERT_DEPTH = 4

async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  const arr = new Uint8Array(digest).subarray(0, 16)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

function metaOf(d: LoadedDrawing): ModelMeta {
  return {
    id: d.id,
    name: d.name,
    format: 'drawing',
    vertexCount: 0,
    triangleCount: 0,
    partCount: 1,
    bbox: {
      min: [d.bbox2d.min[0], d.bbox2d.min[1], 0],
      max: [d.bbox2d.max[0], d.bbox2d.max[1], 0],
    },
    bbox2d: d.bbox2d,
    snapPoints: d.snapPoints,
  }
}

// --- ワールド座標へ平坦化したエンティティ（INSERT展開後） -------------------

type FlatEntity =
  | { type: 'line'; a: [number, number]; b: [number, number] }
  | { type: 'circle'; c: [number, number]; r: number }
  | { type: 'arc'; c: [number, number]; r: number; startDeg: number; endDeg: number }
  | { type: 'polyline'; pts: [number, number][]; bulges: number[]; closed: boolean }
  | { type: 'point'; p: [number, number] }
  | { type: 'ellipsePoly'; pts: [number, number][] } // 非一様スケールで円/弧が楕円になる場合の近似

interface Xform {
  // v' = R * S * v + T （回転はdeg、スケールは軸ごと、その後平行移動）
  dx: number
  dy: number
  rotDeg: number
  sx: number
  sy: number
}

const IDENTITY: Xform = { dx: 0, dy: 0, rotDeg: 0, sx: 1, sy: 1 }

function applyXform(x: Xform, p: [number, number]): [number, number] {
  const rad = (x.rotDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const sx = p[0] * x.sx
  const sy = p[1] * x.sy
  return [sx * cos - sy * sin + x.dx, sx * sin + sy * cos + x.dy]
}

/** 2つの変換の合成（内側→外側の順で適用、insertの入れ子で使う）。 */
function composeXform(outer: Xform, inner: Xform): Xform {
  // outer(inner(v)) を単一Xformで表す。非一様スケール+回転の合成は一般には
  // 単純な{dx,dy,rotDeg,sx,sy}で厳密には表現できない（せん断が生じ得る）が、
  // 実務のDXF（ネストしたINSERTの回転+一様スケールが大半）では十分な近似。
  // 一様スケール(sx===sy)同士の合成は厳密。
  const origin = applyXform(outer, applyXform(inner, [0, 0]))
  const ex = applyXform(outer, applyXform(inner, [1, 0]))
  const ey = applyXform(outer, applyXform(inner, [0, 1]))
  const dx = origin[0]
  const dy = origin[1]
  const sx = Math.hypot(ex[0] - dx, ex[1] - dy)
  const sy = Math.hypot(ey[0] - dx, ey[1] - dy)
  const rotDeg = (Math.atan2(ex[1] - dy, ex[0] - dx) * 180) / Math.PI
  return { dx, dy, rotDeg, sx: sx * Math.sign(inner.sx * outer.sx) || sx, sy: sy * Math.sign(inner.sy * outer.sy) || sy }
}

function isUniform(x: Xform): boolean {
  return Math.abs(Math.abs(x.sx) - Math.abs(x.sy)) < 1e-9
}

const SEGMENTS_PER_CIRCLE = 64

function sampleEllipse(c: [number, number], r: number, x: Xform, startDeg: number, endDeg: number): [number, number][] {
  const pts: [number, number][] = []
  let sweep = endDeg - startDeg
  while (sweep <= 0) sweep += 360
  const n = Math.max(8, Math.round((SEGMENTS_PER_CIRCLE * sweep) / 360))
  for (let i = 0; i <= n; i++) {
    const a = ((startDeg + (sweep * i) / n) * Math.PI) / 180
    const local: [number, number] = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]
    pts.push(applyXform(x, local))
  }
  return pts
}

function flattenEntities(entities: IEntity[], blocks: Record<string, IBlock>, x: Xform, depth: number, out: FlatEntity[]): void {
  for (const e of entities) {
    try {
      flattenOne(e, blocks, x, depth, out)
    } catch {
      // 壊れた/未対応のエンティティはスキップ（backendのezdxf側と同じ方針）
    }
  }
}

function flattenOne(e: IEntity, blocks: Record<string, IBlock>, x: Xform, depth: number, out: FlatEntity[]): void {
  const t = (e as { type?: string }).type
  switch (t) {
    case 'LINE': {
      const le = e as ILineEntity
      const [a, b] = le.vertices
      if (!a || !b) return
      out.push({ type: 'line', a: applyXform(x, [a.x, a.y]), b: applyXform(x, [b.x, b.y]) })
      return
    }
    case 'CIRCLE': {
      const ce = e as ICircleEntity
      if (isUniform(x)) {
        out.push({ type: 'circle', c: applyXform(x, [ce.center.x, ce.center.y]), r: ce.radius * Math.abs(x.sx) })
      } else {
        out.push({ type: 'ellipsePoly', pts: sampleEllipse([ce.center.x, ce.center.y], ce.radius, x, 0, 360) })
      }
      return
    }
    case 'ARC': {
      const ae = e as IArcEntity
      if (isUniform(x)) {
        // 反転(sx*sy<0)は弧の走行方向を逆転させる
        const flip = x.sx * x.sy < 0
        const start = flip ? -ae.endAngle : ae.startAngle
        const end = flip ? -ae.startAngle : ae.endAngle
        out.push({
          type: 'arc',
          c: applyXform(x, [ae.center.x, ae.center.y]),
          r: ae.radius * Math.abs(x.sx),
          startDeg: start + x.rotDeg,
          endDeg: end + x.rotDeg,
        })
      } else {
        out.push({ type: 'ellipsePoly', pts: sampleEllipse([ae.center.x, ae.center.y], ae.radius, x, ae.startAngle, ae.endAngle) })
      }
      return
    }
    case 'LWPOLYLINE': {
      const pe = e as ILwpolylineEntity
      const pts = pe.vertices.map((v): [number, number] => applyXform(x, [v.x, v.y]))
      const bulges = pe.vertices.map((v) => v.bulge || 0)
      out.push({ type: 'polyline', pts, bulges, closed: !!pe.shape })
      return
    }
    case 'POLYLINE': {
      const pe = e as IPolylineEntity
      const pts = pe.vertices.map((v): [number, number] => applyXform(x, [v.x, v.y]))
      const bulges = pe.vertices.map((v) => v.bulge || 0)
      out.push({ type: 'polyline', pts, bulges, closed: !!pe.shape })
      return
    }
    case 'POINT': {
      const pe = e as IPointEntity
      out.push({ type: 'point', p: applyXform(x, [pe.position.x, pe.position.y]) })
      return
    }
    case 'INSERT': {
      if (depth >= MAX_INSERT_DEPTH) return
      const ie = e as IInsertEntity
      const block = blocks[ie.name]
      if (!block) return
      const bx = block.position ? block.position.x : 0
      const by = block.position ? block.position.y : 0
      // ブロック定義自体の基点(position)を原点に戻してから配置変換をかける
      const local: Xform = { dx: -bx, dy: -by, rotDeg: 0, sx: 1, sy: 1 }
      const placement: Xform = {
        dx: ie.position.x,
        dy: ie.position.y,
        rotDeg: ie.rotation || 0,
        sx: ie.xScale ?? 1,
        sy: ie.yScale ?? 1,
      }
      const inner = composeXform(placement, local)
      const combined = composeXform(x, inner)
      const cols = Math.max(1, ie.columnCount || 1)
      const rows = Math.max(1, ie.rowCount || 1)
      const colSp = ie.columnSpacing || 0
      const rowSp = ie.rowSpacing || 0
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const arrayOffset: Xform = { dx: col * colSp, dy: row * rowSp, rotDeg: 0, sx: 1, sy: 1 }
          const withArray = composeXform(combined, arrayOffset)
          flattenEntities(block.entities ?? [], blocks, withArray, depth + 1, out)
        }
      }
      return
    }
    default:
      return // 未対応エンティティ(TEXT/DIMENSION/HATCH等)は描画対象外
  }
}

// --- bulge付きポリライン → 直線/円弧セグメント列 ----------------------------

interface PolySeg {
  a: [number, number]
  b: [number, number]
  bulge: number // 0=直線, !=0 の場合は円弧（tan(内角/4)）
}

function polySegments(pts: [number, number][], bulges: number[], closed: boolean): PolySeg[] {
  const segs: PolySeg[] = []
  const n = pts.length
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    segs.push({ a, b, bulge: bulges[i] || 0 })
  }
  return segs
}

/** bulge(tan(内角/4)) → 円弧の中心・半径・開始/終了角(deg)。直線ならnull。 */
function bulgeArc(a: [number, number], b: [number, number], bulge: number): { c: [number, number]; r: number; startDeg: number; endDeg: number } | null {
  if (Math.abs(bulge) < 1e-12) return null
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const chord = Math.hypot(dx, dy)
  if (chord < 1e-12) return null
  const theta = 4 * Math.atan(bulge) // 内角（符号付き、+=CCW）
  const r = chord / (2 * Math.sin(theta / 2))
  const mx = (a[0] + b[0]) / 2
  const my = (a[1] + b[1]) / 2
  // 弦中点から中心までの符号付き距離（r自体がbulgeの符号で反転するので
  // sqrt(r^2 - (chord/2)^2) は常に非負 → sign(bulge)で弧のふくらむ向きを復元）
  const h = Math.sqrt(Math.max(r * r - (chord / 2) * (chord / 2), 0)) * Math.sign(bulge)
  // 弦に垂直な単位ベクトル（弦方向を90度回転、a→b→中心が左手系になる向き）
  const ux = -dy / chord
  const uy = dx / chord
  const cx = mx + ux * h
  const cy = my + uy * h
  const startDeg = (Math.atan2(a[1] - cy, a[0] - cx) * 180) / Math.PI
  const endDeg = (Math.atan2(b[1] - cy, b[0] - cx) * 180) / Math.PI
  return { c: [cx, cy], r: Math.abs(r), startDeg, endDeg }
}

// --- bbox --------------------------------------------------------------

function extendBbox(bb: { min: [number, number]; max: [number, number] }, p: [number, number]): void {
  if (p[0] < bb.min[0]) bb.min[0] = p[0]
  if (p[1] < bb.min[1]) bb.min[1] = p[1]
  if (p[0] > bb.max[0]) bb.max[0] = p[0]
  if (p[1] > bb.max[1]) bb.max[1] = p[1]
}

function arcExtrema(c: [number, number], r: number, startDeg: number, endDeg: number): [number, number][] {
  const pts: [number, number][] = []
  const norm = (d: number) => ((d % 360) + 360) % 360
  const s = norm(startDeg)
  let e = norm(endDeg)
  if (e <= s) e += 360
  pts.push([c[0] + r * Math.cos((s * Math.PI) / 180), c[1] + r * Math.sin((s * Math.PI) / 180)])
  pts.push([c[0] + r * Math.cos((e * Math.PI) / 180), c[1] + r * Math.sin((e * Math.PI) / 180)])
  for (const cardinal of [0, 90, 180, 270, 360]) {
    if (cardinal >= s && cardinal <= e) {
      const a = (cardinal * Math.PI) / 180
      pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)])
    }
  }
  return pts
}

function computeBbox(flat: FlatEntity[]): { min: [number, number]; max: [number, number] } {
  const bb = { min: [Infinity, Infinity] as [number, number], max: [-Infinity, -Infinity] as [number, number] }
  for (const e of flat) {
    if (e.type === 'line') {
      extendBbox(bb, e.a)
      extendBbox(bb, e.b)
    } else if (e.type === 'circle') {
      extendBbox(bb, [e.c[0] - e.r, e.c[1] - e.r])
      extendBbox(bb, [e.c[0] + e.r, e.c[1] + e.r])
    } else if (e.type === 'arc') {
      for (const p of arcExtrema(e.c, e.r, e.startDeg, e.endDeg)) extendBbox(bb, p)
    } else if (e.type === 'polyline' || e.type === 'ellipsePoly') {
      for (const p of e.pts) extendBbox(bb, p)
    } else if (e.type === 'point') {
      extendBbox(bb, e.p)
    }
  }
  return bb
}

// --- SVG生成 -------------------------------------------------------------

function arcPathD(to: (p: [number, number]) => [number, number], c: [number, number], r: number, startDeg: number, endDeg: number): string {
  let sweep = endDeg - startDeg
  while (sweep <= 0) sweep += 360
  while (sweep > 360) sweep -= 360
  const p0 = to([c[0] + r * Math.cos((startDeg * Math.PI) / 180), c[1] + r * Math.sin((startDeg * Math.PI) / 180)])
  const p1 = to([c[0] + r * Math.cos(((startDeg + sweep) * Math.PI) / 180), c[1] + r * Math.sin(((startDeg + sweep) * Math.PI) / 180)])
  const largeArc = sweep > 180 ? 1 : 0
  // to()はy反転を行うため、DXF空間でCCW(数学的正)の弧はSVG空間ではCW(sweep-flag=1)になる
  if (sweep >= 359.999) {
    // ほぼ全周: 1本のarcコマンドでは始点=終点になり描画されないため2分割する
    const mid = to([c[0] + r * Math.cos(((startDeg + sweep / 2) * Math.PI) / 180), c[1] + r * Math.sin(((startDeg + sweep / 2) * Math.PI) / 180)])
    return `M ${p0[0]} ${p0[1]} A ${r} ${r} 0 0 1 ${mid[0]} ${mid[1]} A ${r} ${r} 0 0 1 ${p1[0]} ${p1[1]}`
  }
  return `M ${p0[0]} ${p0[1]} A ${r} ${r} 0 ${largeArc} 1 ${p1[0]} ${p1[1]}`
}

function polylinePathD(to: (p: [number, number]) => [number, number], segs: PolySeg[]): string {
  if (segs.length === 0) return ''
  const parts: string[] = []
  const start = to(segs[0].a)
  parts.push(`M ${start[0]} ${start[1]}`)
  for (const seg of segs) {
    const arc = bulgeArc(seg.a, seg.b, seg.bulge)
    const pb = to(seg.b)
    if (arc) {
      let sweep = arc.endDeg - arc.startDeg
      while (sweep <= 0) sweep += 360
      while (sweep > 360) sweep -= 360
      const largeArc = sweep > 180 ? 1 : 0
      parts.push(`A ${arc.r} ${arc.r} 0 ${largeArc} 1 ${pb[0]} ${pb[1]}`)
    } else {
      parts.push(`L ${pb[0]} ${pb[1]}`)
    }
  }
  return parts.join(' ')
}

function buildSvg(flat: FlatEntity[], bb: { min: [number, number]; max: [number, number] }): string {
  const w = Math.max(bb.max[0] - bb.min[0], 1e-6)
  const h = Math.max(bb.max[1] - bb.min[1], 1e-6)
  const to = (p: [number, number]): [number, number] => [p[0] - bb.min[0], bb.max[1] - p[1]]
  const STROKE = '#e8e8e8'
  const lines: string[] = []
  for (const e of flat) {
    if (e.type === 'line') {
      const a = to(e.a)
      const b = to(e.b)
      lines.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" />`)
    } else if (e.type === 'circle') {
      const c = to(e.c)
      lines.push(`<circle cx="${c[0]}" cy="${c[1]}" r="${e.r}" />`)
    } else if (e.type === 'arc') {
      lines.push(`<path d="${arcPathD(to, e.c, e.r, e.startDeg, e.endDeg)}" />`)
    } else if (e.type === 'polyline') {
      const segs = polySegments(e.pts, e.bulges, e.closed)
      lines.push(`<path d="${polylinePathD(to, segs)}" />`)
    } else if (e.type === 'ellipsePoly') {
      const d = e.pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${to(p)[0]} ${to(p)[1]}`).join(' ')
      lines.push(`<path d="${d}" />`)
    } else if (e.type === 'point') {
      const p = to(e.p)
      const s = Math.max(w, h) * 0.004
      lines.push(`<line x1="${p[0] - s}" y1="${p[1]}" x2="${p[0] + s}" y2="${p[1]}" />`)
      lines.push(`<line x1="${p[0]}" y1="${p[1] - s}" x2="${p[0]}" y2="${p[1] + s}" />`)
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" ` +
    `fill="none" stroke="${STROKE}" stroke-width="${Math.max(w, h) * 0.0015}">` +
    `${lines.join('')}</svg>`
  )
}

// --- スナップ点 ------------------------------------------------------------

function collectSnaps(flat: FlatEntity[], bb: { min: [number, number]; max: [number, number] }): SnapPointOut[] {
  const out: SnapPointOut[] = []
  const toSvg = (p: [number, number]): [number, number] => [
    Math.round((p[0] - bb.min[0]) * 10) / 10,
    Math.round((bb.max[1] - p[1]) * 10) / 10,
  ]
  const add = (p: [number, number], kind: string) => {
    if (out.length < MAX_SNAP_POINTS) {
      out.push({ dxf: [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6], svg: toSvg(p), kind })
    }
  }
  for (const e of flat) {
    if (out.length >= MAX_SNAP_POINTS) break
    if (e.type === 'line') {
      add(e.a, 'end')
      add(e.b, 'end')
    } else if (e.type === 'circle') {
      add(e.c, 'center')
      add([e.c[0] + e.r, e.c[1]], 'quadrant')
      add([e.c[0] - e.r, e.c[1]], 'quadrant')
      add([e.c[0], e.c[1] + e.r], 'quadrant')
      add([e.c[0], e.c[1] - e.r], 'quadrant')
    } else if (e.type === 'arc') {
      add(e.c, 'center')
      const rad0 = (e.startDeg * Math.PI) / 180
      const rad1 = (e.endDeg * Math.PI) / 180
      add([e.c[0] + e.r * Math.cos(rad0), e.c[1] + e.r * Math.sin(rad0)], 'end')
      add([e.c[0] + e.r * Math.cos(rad1), e.c[1] + e.r * Math.sin(rad1)], 'end')
    } else if (e.type === 'polyline') {
      for (const p of e.pts) add(p, 'vertex')
    } else if (e.type === 'point') {
      add(e.p, 'point')
    }
  }
  return out
}

// --- 公開API ---------------------------------------------------------------

export async function loadDxf(bytes: Uint8Array, filename: string): Promise<ModelMeta> {
  const id = `d${await contentHash(bytes)}`
  const cached = _drawings.get(id)
  if (cached) {
    evictOthers(id)
    return metaOf(cached)
  }

  const text = new TextDecoder('utf-8').decode(bytes)
  const parser = new DxfParser()
  let dxf: IDxf | null
  try {
    dxf = parser.parseSync(text)
  } catch (e) {
    throw new Error(`DXF読み込み失敗: ${String(e)}`)
  }
  if (!dxf) throw new Error('DXF読み込み失敗: パース結果が空')

  const flat: FlatEntity[] = []
  flattenEntities(dxf.entities ?? [], dxf.blocks ?? {}, IDENTITY, 0, flat)
  if (flat.length === 0) throw new Error('図面に描画エンティティが無い（対応エンティティ: LINE/CIRCLE/ARC/LWPOLYLINE/POLYLINE/POINT/INSERT）')

  const bb = computeBbox(flat)
  if (!Number.isFinite(bb.min[0]) || !Number.isFinite(bb.max[0])) {
    throw new Error('図面のbbox計算に失敗')
  }
  // 境界線が切れないよう1%パディング（backendのezdxf経路と同じ狙い）
  const pad = 0.01 * Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1])
  const paddedBb = {
    min: [bb.min[0] - pad, bb.min[1] - pad] as [number, number],
    max: [bb.max[0] + pad, bb.max[1] + pad] as [number, number],
  }
  const svg = buildSvg(flat, paddedBb)
  const snapPoints = collectSnaps(flat, paddedBb)

  const name = filename.replace(/^.*[/\\]/, '')
  const drawing: LoadedDrawing = { id, name, svg, bbox2d: { min: bb.min, max: bb.max }, snapPoints }
  _drawings.set(id, drawing)
  evictOthers(id)
  return metaOf(drawing)
}

export async function svgOf(id: string): Promise<string> {
  const d = _drawings.get(id)
  if (!d) throw new Error(`unknown drawing id: ${id}`)
  return d.svg
}

function evictOthers(keepId: string): void {
  for (const id of _drawings.keys()) {
    if (id !== keepId) _drawings.delete(id)
  }
}

export function disposeAll(): void {
  _drawings.clear()
}
