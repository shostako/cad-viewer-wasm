import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { ModelData, PartData } from './model'

const DEFAULT_PART_COLOR = 0x8fb4d8
const EDGE_COLOR = 0x20262e

export class Viewer {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  readonly controls: OrbitControls
  readonly labelRenderer: CSS2DRenderer
  /** overlay group for dimensions / markers / annotations */
  readonly overlay = new THREE.Group()
  private modelGroup = new THREE.Group()
  private gridHelper: THREE.GridHelper | null = null
  private lineMaterials: LineMaterial[] = []
  private partGroups = new Map<number, THREE.Group>()
  private partMeshes = new Map<number, THREE.Mesh>()

  constructor(container: HTMLElement) {
    this.scene.background = new THREE.Color(0x1d2126)

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1e6)
    // CAD convention: Z-up. Keep world coordinates identical to server B-rep coords.
    this.camera.up.set(0, 0, 1)
    this.camera.position.set(80, -60, 50)

    // stencil: needed for section caps (three defaults stencil:false since r163)
    this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    container.appendChild(this.renderer.domElement)

    this.labelRenderer = new CSS2DRenderer()
    this.labelRenderer.domElement.style.position = 'absolute'
    this.labelRenderer.domElement.style.inset = '0'
    this.labelRenderer.domElement.style.pointerEvents = 'none'
    container.appendChild(this.labelRenderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true

    // CAD-ish lighting: hemisphere + key + fill
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2))
    const key = new THREE.DirectionalLight(0xffffff, 1.4)
    key.position.set(1, -1.5, 2)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.5)
    fill.position.set(-1.5, 1, -1)
    this.scene.add(fill)

    this.scene.add(this.modelGroup)
    this.scene.add(this.overlay)

    const resize = () => {
      const w = container.clientWidth
      const h = container.clientHeight
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(w, h)
      this.labelRenderer.setSize(w, h)
      for (const m of this.lineMaterials) m.resolution.set(w, h)
    }
    new ResizeObserver(resize).observe(container)
    resize()

    this.renderer.setAnimationLoop(() => {
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
      this.labelRenderer.render(this.scene, this.camera)
    })
  }

  getPartMesh(partId: number): THREE.Mesh | undefined {
    return this.partMeshes.get(partId)
  }

  getPartMeshes(): ReadonlyMap<number, THREE.Mesh> {
    return this.partMeshes
  }

  modelBBox(): THREE.Box3 {
    return new THREE.Box3().setFromObject(this.modelGroup)
  }

  /** Thickness heatmap: red below threshold, grading to base blue when thick. */
  setThicknessColors(thickness: Map<number, Float32Array>, threshold: number): void {
    for (const [partId, t] of thickness) {
      const mesh = this.partMeshes.get(partId)
      if (!mesh) continue
      // contract: one thickness value per display vertex
      if (t.length !== mesh.geometry.getAttribute('position').count) {
        console.warn(`thickness length mismatch for part ${partId} — skipped`)
        continue
      }
      const n = t.length
      const colors = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        const v = t[i]
        let r = 0.55
        let g = 0.62
        let b = 0.75 // no-data: neutral gray-blue
        if (v > 0) {
          const u = Math.min(v / (2 * threshold), 1)
          if (u < 0.5) {
            // thin: red -> yellow
            const k = u / 0.5
            r = 1
            g = 0.15 + 0.75 * k
            b = 0.08
          } else {
            // ok: yellow -> steel blue
            const k = (u - 0.5) / 0.5
            r = 1 - 0.65 * k
            g = 0.9 - 0.35 * k
            b = 0.08 + 0.72 * k
          }
        }
        colors[i * 3] = r
        colors[i * 3 + 1] = g
        colors[i * 3 + 2] = b
      }
      mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const mat = mesh.material as THREE.MeshStandardMaterial
      if (!mesh.userData.baseColor) mesh.userData.baseColor = mat.color.clone()
      mat.vertexColors = true
      mat.color.set(0xffffff)
      mat.needsUpdate = true
    }
  }

  clearThicknessColors(): void {
    for (const mesh of this.partMeshes.values()) {
      const mat = mesh.material as THREE.MeshStandardMaterial
      if (mat.vertexColors) {
        mat.vertexColors = false
        if (mesh.userData.baseColor) mat.color.copy(mesh.userData.baseColor)
        mat.needsUpdate = true
      }
    }
  }

  /** Apply clipping planes to every model material (mesh + edge lines). */
  setClippingPlanes(planes: THREE.Plane[]): void {
    const list = planes.length ? planes : null
    this.modelGroup.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof LineSegments2) {
        ;(o.material as THREE.Material).clippingPlanes = list
      }
    })
  }

  /** Create a screen-space label attached to a 3D point. */
  makeLabel(text: string, position: THREE.Vector3, className = 'dim-label'): CSS2DObject {
    const div = document.createElement('div')
    div.className = className
    div.textContent = text
    const label = new CSS2DObject(div)
    label.position.copy(position)
    return label
  }

  disposeOverlayObject(obj: THREE.Object3D): void {
    this.overlay.remove(obj)
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof LineSegments2) {
        o.geometry.dispose()
        ;(o.material as THREE.Material).dispose()
      }
      if (o instanceof CSS2DObject) o.element.remove()
    })
  }

  setModel(model: ModelData): void {
    this.clearModel()
    for (const part of model.parts) this.addPart(part)
    this.fitToView()
  }

  private addPart(part: PartData): void {
    const group = new THREE.Group()
    group.name = part.name
    group.userData.partId = part.id

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(part.positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3))
    geo.setIndex(new THREE.BufferAttribute(part.indices, 1))

    const color = part.color
      ? new THREE.Color().setRGB(part.color[0], part.color[1], part.color[2])
      : new THREE.Color(DEFAULT_PART_COLOR)
    const mat = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.1,
      roughness: 0.65,
      side: THREE.DoubleSide,
      // pull faces slightly back so overlaid edges win the depth fight
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    })
    const mesh = new THREE.Mesh(geo, mat)
    group.add(mesh)
    this.partMeshes.set(part.id, mesh)

    if (part.edges.length >= 6) {
      const edgeGeo = new LineSegmentsGeometry()
      // pass the typed array directly — Array.from() would box millions of
      // floats into JS numbers on large assemblies (memory blowup / tab freeze)
      edgeGeo.setPositions(part.edges)
      const edgeMat = new LineMaterial({ color: EDGE_COLOR, linewidth: 1.5 })
      const size = new THREE.Vector2()
      this.renderer.getSize(size)
      edgeMat.resolution.copy(size)
      this.lineMaterials.push(edgeMat)
      group.add(new LineSegments2(edgeGeo, edgeMat))
    }

    this.partGroups.set(part.id, group)
    this.modelGroup.add(group)
  }

  setPartVisible(partId: number, visible: boolean): void {
    const g = this.partGroups.get(partId)
    if (g) g.visible = visible
  }

  clearModel(): void {
    for (const child of [...this.modelGroup.children]) {
      this.modelGroup.remove(child)
      child.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof LineSegments2) {
          o.geometry.dispose()
          ;(o.material as THREE.Material).dispose()
        }
      })
    }
    this.partGroups.clear()
    this.partMeshes.clear()
    this.lineMaterials = []
    for (const child of [...this.overlay.children]) this.disposeOverlayObject(child)
    if (this.gridHelper) {
      this.scene.remove(this.gridHelper)
      this.gridHelper.dispose()
      this.gridHelper = null
    }
  }

  fitToView(): void {
    const box = new THREE.Box3().setFromObject(this.modelGroup)
    if (box.isEmpty()) return
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    const dist = maxDim / (2 * Math.tan((this.camera.fov * Math.PI) / 360))

    const dir = new THREE.Vector3(1, -1, 0.7).normalize()
    this.camera.position.copy(center).addScaledVector(dir, dist * 1.5)
    this.camera.near = maxDim / 1000
    this.camera.far = maxDim * 100
    this.camera.updateProjectionMatrix()
    this.controls.target.copy(center)
    this.controls.update()

    // ground grid sized to the model
    if (this.gridHelper) {
      this.scene.remove(this.gridHelper)
      this.gridHelper.dispose()
    }
    const gridSize = Math.pow(10, Math.ceil(Math.log10(maxDim * 2)))
    this.gridHelper = new THREE.GridHelper(gridSize, 20, 0x3a4250, 0x2a3038)
    // GridHelper lies in XZ; rotate into XY plane for Z-up world
    this.gridHelper.rotation.x = Math.PI / 2
    this.gridHelper.position.set(center.x, center.y, box.min.z)
    this.scene.add(this.gridHelper)
  }
}
