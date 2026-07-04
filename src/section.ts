/** Section (clipping plane) tool with stencil caps.
 *
 * Caps use the classic webgl_clipping_stencil technique: clipped back faces
 * increment the stencil, front faces decrement, and a plane quad drawn where
 * stencil != 0 fills the cut. Stencil meshes live inside each part's group so
 * the assembly-tree visibility toggles them for free. The technique is
 * version-fragile — three.js is pinned in package.json, and `caps` can be
 * switched off as a fallback.
 */
import * as THREE from 'three'
import type { Viewer } from './viewer'

const CAP_COLOR = 0x9aa4b0

export type Axis = 'X' | 'Y' | 'Z'

const NORMALS: Record<Axis, THREE.Vector3> = {
  X: new THREE.Vector3(-1, 0, 0),
  Y: new THREE.Vector3(0, -1, 0),
  Z: new THREE.Vector3(0, 0, -1),
}

export class SectionTool {
  enabled = false
  axis: Axis = 'X'
  /** 0..1 position across the model bbox along the axis */
  position = 0.5
  flip = false
  caps = true

  private viewer: Viewer
  private plane = new THREE.Plane(NORMALS.X.clone(), 0)
  private helper: THREE.PlaneHelper | null = null
  private bbox = new THREE.Box3()
  private stencilMeshes: THREE.Mesh[] = []
  private capMesh: THREE.Mesh | null = null

  constructor(viewer: Viewer) {
    this.viewer = viewer
    viewer.renderer.localClippingEnabled = true
  }

  setModelBBox(min: number[], max: number[]): void {
    this.bbox.set(new THREE.Vector3(...min), new THREE.Vector3(...max))
    this.teardownCaps() // stale stencil meshes reference the previous model
    this.update()
  }

  update(): void {
    if (!this.enabled) {
      this.viewer.setClippingPlanes([])
      this.removeHelper()
      this.teardownCaps()
      return
    }
    const n = NORMALS[this.axis].clone()
    if (this.flip) n.negate()

    const axisIdx = { X: 0, Y: 1, Z: 2 }[this.axis]
    const lo = this.bbox.min.getComponent(axisIdx)
    const hi = this.bbox.max.getComponent(axisIdx)
    const coord = lo + (hi - lo) * this.position
    // plane: n·p + d = 0 passing through coord on the axis
    const pointOnPlane = new THREE.Vector3()
    this.bbox.getCenter(pointOnPlane)
    pointOnPlane.setComponent(axisIdx, coord)
    this.plane.setFromNormalAndCoplanarPoint(n, pointOnPlane)

    this.viewer.setClippingPlanes([this.plane])
    this.showHelper()

    if (this.caps) {
      if (this.stencilMeshes.length === 0) this.buildCaps()
      this.placeCap()
    } else {
      this.teardownCaps()
    }
  }

  // ---- stencil caps -------------------------------------------------

  private buildCaps(): void {
    for (const mesh of this.viewer.getPartMeshes().values()) {
      const parent = mesh.parent
      if (!parent) continue
      for (const [side, op] of [
        [THREE.BackSide, THREE.IncrementWrapStencilOp],
        [THREE.FrontSide, THREE.DecrementWrapStencilOp],
      ] as const) {
        const mat = new THREE.MeshBasicMaterial()
        mat.depthWrite = false
        mat.depthTest = false
        mat.colorWrite = false
        mat.stencilWrite = true
        mat.stencilFunc = THREE.AlwaysStencilFunc
        mat.side = side
        mat.clippingPlanes = [this.plane]
        mat.stencilFail = op
        mat.stencilZFail = op
        mat.stencilZPass = op
        const sm = new THREE.Mesh(mesh.geometry, mat)
        sm.renderOrder = 1
        parent.add(sm)
        this.stencilMeshes.push(sm)
      }
    }

    const size = this.bbox.getSize(new THREE.Vector3()).length() * 1.5
    const capMat = new THREE.MeshStandardMaterial({
      color: CAP_COLOR,
      metalness: 0.1,
      roughness: 0.75,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
      side: THREE.DoubleSide,
    })
    this.capMesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), capMat)
    this.capMesh.renderOrder = 1.1
    const renderer = this.viewer.renderer
    this.capMesh.onAfterRender = () => renderer.clearStencil()
    this.viewer.scene.add(this.capMesh)
  }

  private placeCap(): void {
    if (!this.capMesh) return
    const po = new THREE.Vector3()
    this.plane.coplanarPoint(po)
    this.capMesh.position.copy(po)
    this.capMesh.lookAt(po.clone().sub(this.plane.normal))
  }

  private teardownCaps(): void {
    for (const sm of this.stencilMeshes) {
      sm.parent?.remove(sm)
      ;(sm.material as THREE.Material).dispose() // geometry is shared with the part mesh
    }
    this.stencilMeshes = []
    if (this.capMesh) {
      this.viewer.scene.remove(this.capMesh)
      this.capMesh.geometry.dispose()
      ;(this.capMesh.material as THREE.Material).dispose()
      this.capMesh = null
    }
  }

  private showHelper(): void {
    this.removeHelper()
    const size = this.bbox.getSize(new THREE.Vector3()).length() * 0.75
    this.helper = new THREE.PlaneHelper(this.plane, size, 0xffd060)
    ;(this.helper.material as THREE.Material).opacity = 0.15
    this.viewer.scene.add(this.helper)
  }

  private removeHelper(): void {
    if (this.helper) {
      this.viewer.scene.remove(this.helper)
      this.helper.dispose()
      this.helper = null
    }
  }
}
