import * as THREE from 'three'
import type { VehicleState, VehicleParams } from '../sim/vehicle'

const WHEEL_RADIUS = 0.32
const WHEEL_WIDTH = 0.22
const TRACK_HALF = 0.78

/** A white plate with a red L, as every Irish learner must display. */
function makeLPlateTexture(): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
    ctx.fillStyle = '#cc0000'
    ctx.font = `bold ${size * 0.82}px Helvetica, Arial, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('L', size / 2, size * 0.54)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/**
 * Placeholder car built from primitives. The shape is throwaway; what matters
 * for a feel spike is that the wheels steer and roll and the brake lights
 * respond, because those are the cues you read when judging the handling.
 */
export class CarView {
  readonly group = new THREE.Group()
  /**
   * Driver's eye point in local space. Height matters more than it looks: sit
   * it too close to the bonnet and the car's own nose fills half the screen,
   * which is both ugly and useless for judging road position. Roughly 0.5 m
   * above the bonnet line is what a real driving position gives you.
   */
  readonly eyePoint = new THREE.Vector3(1.45, 1.52, 0.38)

  /** Cabin and roof, hidden from inside so they don't black out the view. */
  private readonly shell: THREE.Mesh[] = []
  private readonly steerPivots: THREE.Group[] = []
  private readonly wheelMeshes: THREE.Mesh[] = []
  private readonly indicatorLamps: { left: THREE.MeshStandardMaterial; right: THREE.MeshStandardMaterial }
  private readonly headlampBeams: THREE.SpotLight[] = []
  private readonly headlampGlow: THREE.MeshStandardMaterial[] = []
  private readonly brakeLights: THREE.MeshStandardMaterial
  private readonly reverseLight: THREE.MeshStandardMaterial
  private spin = 0

  constructor(params: VehicleParams) {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2f6fb3, roughness: 0.45, metalness: 0.25 })
    // Dark enough to read as glass, light enough to catch the sun. At 0x10171f
    // with no environment map to reflect, the cabin rendered as a black void.
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x3e4c5e, roughness: 0.32, metalness: 0.2 })
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.8 })
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.9 })
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.35, metalness: 0.7 })

    // The simulation's reference point is the REAR axle, so the model is built
    // forward from the origin.
    const wheelbase = params.wheelbase

    const body = new THREE.Mesh(new THREE.BoxGeometry(4.25, 0.78, 1.74), bodyMat)
    body.position.set(wheelbase / 2, 0.62, 0)
    body.castShadow = true
    this.group.add(body)

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.62, 1.6), glassMat)
    cabin.position.set(wheelbase / 2 + 0.05, 1.3, 0)
    cabin.castShadow = true
    this.group.add(cabin)

    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.08, 1.5), bodyMat)
    roof.position.set(wheelbase / 2 + 0.05, 1.63, 0)
    this.group.add(roof)
    this.shell.push(cabin, roof)

    const bumperGeo = new THREE.BoxGeometry(0.22, 0.34, 1.7)
    const frontBumper = new THREE.Mesh(bumperGeo, trimMat)
    frontBumper.position.set(wheelbase / 2 + 2.14, 0.45, 0)
    this.group.add(frontBumper)
    const rearBumper = new THREE.Mesh(bumperGeo, trimMat)
    rearBumper.position.set(wheelbase / 2 - 2.14, 0.45, 0)
    this.group.add(rearBumper)

    // Lights
    const headlightMat = new THREE.MeshStandardMaterial({
      color: 0xfff6d8,
      emissive: 0xfff2cc,
      emissiveIntensity: 0.6,
    })
    for (const side of [-1, 1]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.42), headlightMat)
      hl.position.set(wheelbase / 2 + 2.19, 0.72, side * 0.56)
      this.group.add(hl)
      if (hl.material instanceof THREE.MeshStandardMaterial) this.headlampGlow.push(hl.material)

      // Dipped beam. No shadows from these: two more shadow-casting lights
      // would cost more than the whole rest of the scene, and dipped beams
      // throwing hard shadows up the road looks worse, not better.
      const beam = new THREE.SpotLight(0xfff0d0, 0, 90, 0.5, 0.45, 1.1)
      beam.position.set(wheelbase / 2 + 2.2, 0.7, side * 0.56)
      beam.target.position.set(wheelbase / 2 + 26, -1.4, side * 1.6)
      beam.castShadow = false
      this.group.add(beam, beam.target)
      this.headlampBeams.push(beam)
    }

    this.brakeLights = new THREE.MeshStandardMaterial({
      color: 0x5a0d0d,
      emissive: 0xff1a1a,
      emissiveIntensity: 0,
    })
    for (const side of [-1, 1]) {
      const bl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 0.4), this.brakeLights)
      bl.position.set(wheelbase / 2 - 2.19, 0.78, side * 0.58)
      this.group.add(bl)
    }

    // Indicators. Amber, front and rear on each side, so the signal reads from
    // behind in the chase view and from the mirrors once there are any.
    this.indicatorLamps = {
      left: new THREE.MeshStandardMaterial({ color: 0x6b4a10, emissive: 0xffa21f, emissiveIntensity: 0 }),
      right: new THREE.MeshStandardMaterial({ color: 0x6b4a10, emissive: 0xffa21f, emissiveIntensity: 0 }),
    }
    for (const side of [1, -1] as const) {
      // Local +Z is the car's RIGHT. Rotating about +Y by the heading maps
      // local +Z to simulation (sin h, -cos h), which for a car facing east is
      // due south — the driver's right hand side.
      const material = side === 1 ? this.indicatorLamps.right : this.indicatorLamps.left
      for (const x of [wheelbase / 2 + 2.19, wheelbase / 2 - 2.19]) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.2), material)
        lamp.position.set(x, 0.62, side * 0.74)
        this.group.add(lamp)
      }
    }

    this.reverseLight = new THREE.MeshStandardMaterial({
      color: 0x9a9a92,
      emissive: 0xffffff,
      emissiveIntensity: 0,
    })
    const rl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.26), this.reverseLight)
    rl.position.set(wheelbase / 2 - 2.19, 0.52, 0.2)
    this.group.add(rl)

    // L-plates, front and rear
    const plateTex = makeLPlateTexture()
    const plateMat = new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.7 })
    const plateGeo = new THREE.PlaneGeometry(0.3, 0.3)
    const frontPlate = new THREE.Mesh(plateGeo, plateMat)
    frontPlate.position.set(wheelbase / 2 + 2.27, 0.42, -0.45)
    frontPlate.rotation.y = Math.PI / 2
    this.group.add(frontPlate)
    const rearPlate = new THREE.Mesh(plateGeo, plateMat)
    rearPlate.position.set(wheelbase / 2 - 2.27, 0.42, 0.45)
    rearPlate.rotation.y = -Math.PI / 2
    this.group.add(rearPlate)

    // Wheels: axle along local Z, so rolling is a rotation about Z.
    const tyreGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 18)
    tyreGeo.rotateX(Math.PI / 2)
    const rimGeo = new THREE.BoxGeometry(WHEEL_RADIUS * 1.1, WHEEL_RADIUS * 1.1, WHEEL_WIDTH + 0.01)

    for (const [axleX, steered] of [
      [wheelbase, true],
      [0, false],
    ] as Array<[number, boolean]>) {
      for (const side of [-1, 1]) {
        const pivot = new THREE.Group()
        pivot.position.set(axleX, WHEEL_RADIUS, side * TRACK_HALF)
        this.group.add(pivot)
        if (steered) this.steerPivots.push(pivot)

        const tyre = new THREE.Mesh(tyreGeo, tyreMat)
        tyre.castShadow = true
        const rim = new THREE.Mesh(rimGeo, rimMat)
        tyre.add(rim)
        pivot.add(tyre)
        this.wheelMeshes.push(tyre)
      }
    }
  }

  /**
   * The placeholder car has no modelled interior, so from the driver's eye
   * point the roof slab renders as an unlit black band across the view. Until
   * there is a real cabin to sit in, hide the shell for the inside view.
   */
  setShellVisible(visible: boolean): void {
    for (const mesh of this.shell) mesh.visible = visible
  }

  /** Dipped beams, and the lamps themselves lit so they read from outside. */
  setHeadlights(on: boolean): void {
    // Candela, not an arbitrary 0-1 scale: Three's lights have been physically
    // units since r155, and the 26 this started at lit precisely nothing.
    for (const beam of this.headlampBeams) beam.intensity = on ? 4200 : 0
    for (const glow of this.headlampGlow) {
      glow.emissive.set(0xfff0d0)
      glow.emissiveIntensity = on ? 1.6 : 0
    }
  }

  update(
    state: VehicleState,
    braking: boolean,
    dt: number,
    ground = 0,
    gradient = 0,
    indicator: 'off' | 'left' | 'right' = 'off',
    elapsed = 0,
  ): void {
    this.group.position.set(state.x, ground, -state.y)
    // Local +X is forwards and Euler 'XYZ' applies Z first, in the car's own
    // frame, so this pitches the nose up the hill and then yaws the result.
    this.group.rotation.set(0, state.heading, Math.atan(gradient))

    for (const pivot of this.steerPivots) pivot.rotation.y = state.steer

    this.spin -= (state.speed / WHEEL_RADIUS) * dt
    for (const wheel of this.wheelMeshes) wheel.rotation.z = this.spin

    // About 1.5 Hz, which is roughly the legal flash rate.
    const flash = indicator !== 'off' && Math.sin(elapsed * Math.PI * 3) > 0 ? 3.2 : 0
    this.indicatorLamps.left.emissiveIntensity = indicator === 'left' ? flash : 0
    this.indicatorLamps.right.emissiveIntensity = indicator === 'right' ? flash : 0

    this.brakeLights.emissiveIntensity = braking ? 2.2 : 0
    this.reverseLight.emissiveIntensity = state.gear === 'R' ? 1.4 : 0
  }
}
