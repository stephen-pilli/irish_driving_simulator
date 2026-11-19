/**
 * Rain.
 *
 * A box of falling streaks kept around the camera and recycled as they drop
 * out the bottom. It is a cheap trick, and the right one: the point of showing
 * rain is that the driver can see less and knows the road is wet, and a few
 * hundred instanced lines do that for almost nothing.
 *
 * The streaks lean with the car's speed, which is what makes rain look like
 * rain from a moving vehicle rather than like a falling curtain.
 */

import * as THREE from 'three'

const DROPS = 900
/** Half-size of the box the rain lives in, around the camera. */
const BOX = 26
const FALL_SPEED = 26

export class Rain {
  readonly group = new THREE.Group()
  private readonly mesh: THREE.InstancedMesh
  private readonly dummy = new THREE.Object3D()
  private readonly positions: Float32Array
  private readonly lengths: Float32Array

  constructor() {
    const geometry = new THREE.PlaneGeometry(0.022, 1)
    this.mesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: 0xc9d6e4,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
      DROPS,
    )
    this.mesh.frustumCulled = false
    this.group.add(this.mesh)
    this.group.visible = false

    this.positions = new Float32Array(DROPS * 3)
    this.lengths = new Float32Array(DROPS)
    for (let i = 0; i < DROPS; i++) {
      this.positions[i * 3] = (Math.random() * 2 - 1) * BOX
      this.positions[i * 3 + 1] = Math.random() * BOX * 1.4
      this.positions[i * 3 + 2] = (Math.random() * 2 - 1) * BOX
      this.lengths[i] = 0.6 + Math.random() * 1.1
    }
  }

  setIntensity(rain: number): void {
    this.group.visible = rain > 0.02
    this.mesh.count = Math.round(DROPS * Math.min(1, rain))
    const material = this.mesh.material as THREE.MeshBasicMaterial
    material.opacity = 0.2 + 0.3 * Math.min(1, rain)
  }

  /**
   * `velocity` is the camera's own motion in world space, which is what tilts
   * the streaks. Falling rain seen from a moving car does not fall straight
   * down, and drawing it that way is the thing that looks wrong.
   */
  update(dt: number, centre: THREE.Vector3, velocity: THREE.Vector3): void {
    if (!this.group.visible) return

    const lean = Math.min(1.4, velocity.length() / 22)
    const tilt = new THREE.Vector3(-velocity.x, 0, -velocity.z).normalize().multiplyScalar(lean)

    for (let i = 0; i < this.mesh.count; i++) {
      let y = this.positions[i * 3 + 1]! - FALL_SPEED * dt
      if (y < -4) {
        y = BOX * 1.4
        this.positions[i * 3] = (Math.random() * 2 - 1) * BOX
        this.positions[i * 3 + 2] = (Math.random() * 2 - 1) * BOX
      }
      this.positions[i * 3 + 1] = y

      const length = this.lengths[i]! * (1 + lean * 0.8)
      this.dummy.position.set(
        centre.x + this.positions[i * 3]!,
        centre.y + y,
        centre.z + this.positions[i * 3 + 2]!,
      )
      this.dummy.scale.set(1, length, 1)
      // Lean the streak into the direction of travel.
      this.dummy.rotation.set(tilt.z * 0.5, 0, -tilt.x * 0.5)
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}
