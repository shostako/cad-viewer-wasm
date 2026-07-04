/** 2D drawing viewer: pan/zoom via viewBox mutation + snap measurement.
 *
 * The backend SVG is injected as-is; we manipulate its viewBox for pan/zoom
 * (keeps getScreenCTM() exact) and append our own <g> for markers/dimensions
 * in the same coordinate space. Snap points carry both svg coords (display)
 * and dxf coords (exact measurement values).
 */

export interface SnapPoint {
  dxf: [number, number]
  svg: [number, number]
  kind: string
}

const SNAP_PX = 12
const SVG_NS = 'http://www.w3.org/2000/svg'

export class Drawing2D {
  private container: HTMLElement
  private hud: (msg: string) => void
  private svg: SVGSVGElement | null = null
  private overlayG: SVGGElement | null = null
  private snaps: SnapPoint[] = []
  private vb = { x: 0, y: 0, w: 1, h: 1 }
  private baseVb = { x: 0, y: 0, w: 1, h: 1 }
  private pendingSnap: SnapPoint | null = null
  measureMode = false

  constructor(container: HTMLElement, hud: (msg: string) => void) {
    this.container = container
    this.hud = hud
    this.bindEvents()
  }

  load(svgText: string, snaps: SnapPoint[]): void {
    this.container.innerHTML = svgText
    this.svg = this.container.querySelector('svg')
    if (!this.svg) throw new Error('svg payload broken')
    this.svg.removeAttribute('width')
    this.svg.removeAttribute('height')
    this.svg.style.width = '100%'
    this.svg.style.height = '100%'
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')

    const [x, y, w, h] = (this.svg.getAttribute('viewBox') ?? '0 0 1 1')
      .split(/\s+/)
      .map(Number)
    this.vb = { x, y, w, h }
    this.baseVb = { x, y, w, h }

    this.overlayG = document.createElementNS(SVG_NS, 'g')
    this.svg.appendChild(this.overlayG)
    this.snaps = snaps
    this.pendingSnap = null
  }

  clearMeasurements(): void {
    if (this.overlayG) this.overlayG.innerHTML = ''
    this.pendingSnap = null
  }

  private applyViewBox(): void {
    this.svg?.setAttribute('viewBox', `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`)
    this.updateOverlayScale()
  }

  /** svg-units per screen pixel (uniform thanks to preserveAspectRatio meet) */
  private unitsPerPx(): number {
    if (!this.svg) return 1
    const r = this.svg.getBoundingClientRect()
    return Math.max(this.vb.w / r.width, this.vb.h / r.height)
  }

  private clientToSvg(cx: number, cy: number): [number, number] {
    if (!this.svg) return [0, 0]
    const ctm = this.svg.getScreenCTM()
    if (!ctm) return [0, 0]
    const pt = new DOMPoint(cx, cy).matrixTransform(ctm.inverse())
    return [pt.x, pt.y]
  }

  private bindEvents(): void {
    let panning = false
    let last: [number, number] = [0, 0]
    let downAt: [number, number] | null = null

    this.container.addEventListener('pointerdown', (e) => {
      panning = true
      last = [e.clientX, e.clientY]
      downAt = [e.clientX, e.clientY]
      this.container.setPointerCapture(e.pointerId)
    })
    this.container.addEventListener('pointermove', (e) => {
      if (!panning || !this.svg) return
      const scale = this.unitsPerPx()
      this.vb.x -= (e.clientX - last[0]) * scale
      this.vb.y -= (e.clientY - last[1]) * scale
      last = [e.clientX, e.clientY]
      this.applyViewBox()
    })
    this.container.addEventListener('pointerup', (e) => {
      panning = false
      if (!downAt) return
      const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1])
      downAt = null
      if (moved <= 5 && this.measureMode) this.handleClick(e.clientX, e.clientY)
    })
    // don't leave the pan state stuck if the pointer stream is interrupted
    for (const ev of ['pointercancel', 'lostpointercapture'] as const) {
      this.container.addEventListener(ev, () => {
        panning = false
        downAt = null
      })
    }
    this.container.addEventListener('wheel', (e) => {
      if (!this.svg) return
      e.preventDefault()
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2
      const [mx, my] = this.clientToSvg(e.clientX, e.clientY)
      this.vb.x = mx - (mx - this.vb.x) * factor
      this.vb.y = my - (my - this.vb.y) * factor
      this.vb.w *= factor
      this.vb.h *= factor
      this.applyViewBox()
    })
  }

  fit(): void {
    this.vb = { ...this.baseVb }
    this.applyViewBox()
  }

  private nearestSnap(cx: number, cy: number): SnapPoint | null {
    const [sx, sy] = this.clientToSvg(cx, cy)
    const maxDist = SNAP_PX * this.unitsPerPx()
    let best: SnapPoint | null = null
    let bestD = maxDist
    for (const s of this.snaps) {
      const d = Math.hypot(s.svg[0] - sx, s.svg[1] - sy)
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    return best
  }

  private handleClick(cx: number, cy: number): void {
    const snap = this.nearestSnap(cx, cy)
    if (!snap) {
      this.hud('スナップ点が近くにない（端点・中心・四分円点にスナップする）')
      return
    }
    if (!this.pendingSnap) {
      this.pendingSnap = snap
      this.addMarker(snap)
      this.hud(`(${snap.dxf[0]}, ${snap.dxf[1]}) を選択 — 相手をクリック`)
      return
    }
    const a = this.pendingSnap
    this.pendingSnap = null
    this.addMarker(snap)
    const dx = snap.dxf[0] - a.dxf[0]
    const dy = snap.dxf[1] - a.dxf[1]
    const dist = Math.hypot(dx, dy)
    this.addDimension(a, snap, dist)
    this.hud(`距離 ${dist.toFixed(3)} (ΔX ${Math.abs(dx).toFixed(3)}, ΔY ${Math.abs(dy).toFixed(3)})`)
  }

  private addMarker(s: SnapPoint): SVGCircleElement {
    const c = document.createElementNS(SVG_NS, 'circle')
    c.setAttribute('cx', String(s.svg[0]))
    c.setAttribute('cy', String(s.svg[1]))
    c.setAttribute('fill', '#ffb020')
    c.classList.add('marker2d')
    this.overlayG?.appendChild(c)
    this.updateOverlayScale()
    return c
  }

  private addDimension(a: SnapPoint, b: SnapPoint, dist: number): void {
    const line = document.createElementNS(SVG_NS, 'line')
    line.setAttribute('x1', String(a.svg[0]))
    line.setAttribute('y1', String(a.svg[1]))
    line.setAttribute('x2', String(b.svg[0]))
    line.setAttribute('y2', String(b.svg[1]))
    line.setAttribute('stroke', '#ffd060')
    line.setAttribute('vector-effect', 'non-scaling-stroke')
    line.setAttribute('stroke-width', '1.5')
    this.overlayG?.appendChild(line)

    const text = document.createElementNS(SVG_NS, 'text')
    text.textContent = dist.toFixed(3)
    text.setAttribute('x', String((a.svg[0] + b.svg[0]) / 2))
    text.setAttribute('y', String((a.svg[1] + b.svg[1]) / 2))
    text.setAttribute('fill', '#ffd060')
    text.setAttribute('paint-order', 'stroke')
    text.setAttribute('stroke', '#1d2126')
    text.setAttribute('stroke-width', '3')
    text.classList.add('dimtext2d')
    this.overlayG?.appendChild(text)
    this.updateOverlayScale()
  }

  /** keep markers/text screen-constant across zoom levels */
  private updateOverlayScale(): void {
    if (!this.overlayG) return
    const u = this.unitsPerPx()
    for (const c of Array.from(this.overlayG.querySelectorAll('circle.marker2d'))) {
      c.setAttribute('r', String(5 * u))
    }
    for (const t of Array.from(this.overlayG.querySelectorAll('text.dimtext2d'))) {
      t.setAttribute('font-size', String(13 * u))
    }
  }
}
