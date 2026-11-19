/**
 * Mirrors.
 *
 * Three extra views of the scene — interior, and one wing mirror each side —
 * rendered to textures and composited over the main picture.
 *
 * They are here because the rules need them. "Check your mirrors" is a thing a
 * driver is marked on, and asking someone to press a key for a mirror they
 * cannot see is asking them to perform a ritual rather than to look at
 * anything. With the mirrors on screen the check has something behind it.
 *
 * Each is rendered at a deliberately small resolution. Three extra passes per
 * frame is the cost of having them at all, and a mirror the size of a stamp
 * does not need the same pixels as the windscreen.
 */

import * as THREE from 'three'
import type { CarView } from './car'

export type MirrorLayout = 'all' | 'interiorOnly' | 'none'

interface MirrorView {
  camera: THREE.PerspectiveCamera
  target: THREE.WebGLRenderTarget
  plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  /** The surround, hidden with the mirror it frames. */
  frame: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  /** Eye point in the car's local space. */
  offset: THREE.Vector3
  /** Direction the mirror looks, in the car's local space. */
  look: THREE.Vector3
}

/**
 * Where each mirror sits on screen, in normalised device coordinates, and how
 * big it is. The interior mirror sits where it would through a windscreen;
 * the wings sit out at the edges rather than in a strictly accurate position,
 * because an accurate one is off the bottom of a monitor-shaped viewport.
 */
const PLACEMENT = {
  interior: { x: 0, y: 0.84, w: 0.3, h: 0.085 },
  left: { x: -0.8, y: -0.3, w: 0.12, h: 0.085 },
  right: { x: 0.8, y: -0.3, w: 0.12, h: 0.085 },
} as const

export class Mirrors {
  layout: MirrorLayout = 'all'
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly views: Record<'interior' | 'left' | 'right', MirrorView>
  private readonly worldPosition = new THREE.Vector3()
  private readonly worldLook = new THREE.Vector3()
  private readonly worldTarget = new THREE.Vector3()

  constructor() {
    this.views = {
      // Three's fov is VERTICAL. A 4:1 strip at 42 degrees vertical is a
      // 114-degree horizontal view, which made everything behind the car look
      // a hundred metres away. A real interior mirror is roughly 50 degrees
      // across, which on this shape is about 13 vertical.
      interior: this.makeView(
        512,
        128,
        PLACEMENT.interior,
        new THREE.Vector3(1.25, 1.36, 0),
        new THREE.Vector3(-1, -0.04, 0),
        13.5,
      ),
      left: this.makeView(
        192,
        144,
        PLACEMENT.left,
        // Local -Z is the car's left.
        new THREE.Vector3(1.05, 1.02, -0.95),
        new THREE.Vector3(-1, -0.12, -0.42),
        34,
      ),
      right: this.makeView(
        192,
        144,
        PLACEMENT.right,
        new THREE.Vector3(1.05, 1.02, 0.95),
        new THREE.Vector3(-1, -0.12, 0.42),
        34,
      ),
    }
  }

  private makeView(
    width: number,
    height: number,
    place: { x: number; y: number; w: number; h: number },
    offset: THREE.Vector3,
    look: THREE.Vector3,
    fov: number,
  ): MirrorView {
    const target = new THREE.WebGLRenderTarget(width, height)
    target.texture.colorSpace = THREE.SRGBColorSpace
    // A mirror reverses left and right. Flipping the texture here rather than
    // mirroring the camera keeps the scene's winding order intact, which a
    // negatively scaled camera does not.
    target.texture.wrapS = THREE.ClampToEdgeWrapping
    target.texture.repeat.x = -1
    target.texture.offset.x = 1

    const camera = new THREE.PerspectiveCamera(fov, width / height, 0.3, 450)

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(place.w * 2, place.h * 2),
      new THREE.MeshBasicMaterial({ map: target.texture, toneMapped: false }),
    )
    plane.position.set(place.x, place.y, 0)

    // A surround, so the mirror reads as a mirror and not as a hole.
    const frame = new THREE.Mesh(
      new THREE.PlaneGeometry(place.w * 2 + 0.012, place.h * 2 + 0.016),
      new THREE.MeshBasicMaterial({ color: 0x14181e, toneMapped: false }),
    )
    frame.position.set(place.x, place.y, -0.01)

    this.scene.add(frame, plane)
    return { camera, target, plane, frame, offset, look }
  }

  /** Wing mirrors are only shown from the driving seat. */
  private wings = true

  private visible(name: 'interior' | 'left' | 'right'): boolean {
    if (this.layout === 'none') return false
    if (name === 'interior') return true
    if (this.layout === 'interiorOnly') return false
    return this.wings
  }

  cycle(): MirrorLayout {
    this.layout =
      this.layout === 'all' ? 'interiorOnly' : this.layout === 'interiorOnly' ? 'none' : 'all'
    return this.layout
  }

  /**
   * Render the mirror views. Call before the main render; `composite` draws
   * them over the top afterwards.
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    car: CarView,
    aspect: number,
    fromDrivingSeat: boolean,
  ): void {
    this.wings = fromDrivingSeat
    if (this.layout === 'none') return

    // The car's own body is a solid box, so a mirror camera sitting inside it
    // sees nothing but blue paint. A real mirror looks out through glass; this
    // is the cheapest way to get the same view.
    const wasVisible = car.group.visible
    car.group.visible = false

    for (const [name, view] of Object.entries(this.views)) {
      if (!this.visible(name as 'interior' | 'left' | 'right')) continue

      this.worldPosition.copy(view.offset).applyMatrix4(car.group.matrixWorld)
      // transformDirection, not applyMatrix4: the look vector is a DIRECTION.
      // Put through the full matrix it picks up the car's translation as well,
      // which aimed every mirror at the tarmac a couple of metres behind the
      // bumper — the view looked plausibly like a mirror and showed nothing.
      this.worldLook.copy(view.look).normalize().transformDirection(car.group.matrixWorld)

      view.camera.position.copy(this.worldPosition)
      this.worldTarget.copy(this.worldPosition).addScaledVector(this.worldLook, 40)
      view.camera.lookAt(this.worldTarget)
      view.camera.updateProjectionMatrix()

      renderer.setRenderTarget(view.target)
      renderer.render(scene, view.camera)
    }
    renderer.setRenderTarget(null)
    car.group.visible = wasVisible

    // Keep the mirrors a constant shape whatever the window is. Without this
    // they stretch with the viewport and a wide window gives letterbox wing
    // mirrors that no longer look like mirrors.
    for (const [name, view] of Object.entries(this.views)) {
      const place = PLACEMENT[name as keyof typeof PLACEMENT]
      view.plane.scale.set(1, aspect / 1.78, 1)
      view.plane.position.y = place.y
    }
  }

  /** Draw the mirrors over the finished frame. */
  composite(renderer: THREE.WebGLRenderer): void {
    if (this.layout === 'none') return
    for (const [name, view] of Object.entries(this.views)) {
      // The surround has to go with it, or a mirror that is not being rendered
      // leaves a black rectangle floating over the road.
      const shown = this.visible(name as 'interior' | 'left' | 'right')
      view.plane.visible = shown
      view.frame.visible = shown
    }
    const previousAutoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.clearDepth()
    renderer.render(this.scene, this.camera)
    renderer.autoClear = previousAutoClear
  }

  dispose(): void {
    for (const view of Object.values(this.views)) {
      view.target.dispose()
      view.plane.geometry.dispose()
      view.plane.material.dispose()
      view.frame.geometry.dispose()
      view.frame.material.dispose()
    }
  }
}
