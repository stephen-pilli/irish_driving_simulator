import * as THREE from 'three'
import type { VehicleState } from '../sim/vehicle'
import type { CarView } from './car'

export type CameraMode = 'chase' | 'bonnet' | 'overhead'
export const CAMERA_MODES: CameraMode[] = ['chase', 'bonnet', 'overhead']

/**
 * Camera geometry. Deliberately plain: fixed height, fixed distance, fixed
 * field of view, rigidly attached to the car.
 *
 * This is a trainer, not a racing game. Speed-dependent field of view, heading
 * lag, lateral drift under cornering and road vibration all make a car feel
 * more exciting and all make road position harder to judge — which is the one
 * thing the driver is actually here to learn. None of them are present.
 */
export type CameraParams = {
  /** Metres behind the car. */
  distance: number
  /** Eye height above the road. */
  height: number
  fov: number
  /** How far ahead of the car the camera is aimed. */
  lookAhead: number
  /** Height of the overhead view. */
  overheadHeight: number
}

export const DEFAULT_CAMERA_PARAMS: CameraParams = {
  distance: 7,
  height: 2.5,
  fov: 62,
  lookAhead: 12,
  overheadHeight: 26,
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera
  private mode: CameraMode = 'chase'
  private readonly forward = new THREE.Vector3()
  private readonly anchor = new THREE.Vector3()
  private readonly lookAt = new THREE.Vector3()

  constructor(aspect: number, private readonly p: CameraParams) {
    this.camera = new THREE.PerspectiveCamera(p.fov, aspect, 0.15, 2600)
  }

  get currentMode(): CameraMode {
    return this.mode
  }

  cycle(): CameraMode {
    const i = CAMERA_MODES.indexOf(this.mode)
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length] ?? 'chase'
    if (this.mode !== 'overhead') this.camera.up.set(0, 1, 0)
    return this.mode
  }

  update(state: VehicleState, car: CarView): void {
    // The simulation's reference point is the rear axle; aim at the middle of
    // the car so it sits centred in frame.
    this.forward.set(Math.cos(state.heading), 0, -Math.sin(state.heading))
    this.anchor.set(state.x, 0, -state.y).addScaledVector(this.forward, 1.3)

    switch (this.mode) {
      case 'chase':
        this.updateChase()
        break
      case 'bonnet':
        this.updateBonnet(car)
        break
      case 'overhead':
        this.updateOverhead()
        break
    }

    this.camera.lookAt(this.lookAt)
    this.camera.updateProjectionMatrix()
  }

  private updateChase(): void {
    this.camera.fov = this.p.fov
    this.camera.position
      .copy(this.anchor)
      .addScaledVector(this.forward, -this.p.distance)
    this.camera.position.y = this.p.height

    this.lookAt.copy(this.anchor).addScaledVector(this.forward, this.p.lookAhead)
    this.lookAt.y = 1.0
  }

  private updateBonnet(car: CarView): void {
    this.camera.fov = this.p.fov + 8
    this.camera.position.copy(car.eyePoint).applyMatrix4(car.group.matrixWorld)
    // Straight ahead. A real driver's head does not swivel with the steering
    // wheel, and making the view lead into corners hides what you are turning
    // towards at exactly the moment it matters.
    this.lookAt
      .copy(this.camera.position)
      .addScaledVector(this.forward, 30)
    this.lookAt.y = this.camera.position.y - 1.1
  }

  private updateOverhead(): void {
    this.camera.fov = 50
    this.camera.position.set(this.anchor.x, this.p.overheadHeight, this.anchor.z)
    this.lookAt.copy(this.anchor)
    // Heading-up, which is what makes a three-point turn legible.
    this.camera.up.set(this.forward.x, 0, this.forward.z)
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
  }
}
