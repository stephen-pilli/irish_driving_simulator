import { approach, clamp, DEG, kmhToMs } from '../core/math'
import type { DriverInput } from '../input/input'

export type Gear = 'R' | 'N' | 'D'

/**
 * Everything tunable about how the car drives. Exposed to the in-game tuning
 * panel so the numbers can be dialled in by feel rather than by guesswork.
 */
export type VehicleParams = {
  /** Front-to-rear axle distance (m). Dictates turning circle. */
  wheelbase: number
  mass: number
  /** Road wheel angle at full lock (deg). ~33-35 for a small hatchback. */
  maxSteerDeg: number
  /** How fast the driver can wind the wheel on (deg of road wheel per second). */
  steerRateDegPerSec: number
  /** Self-centring speed when the wheel is released. */
  steerReturnDegPerSec: number
  enginePowerKw: number
  /** Traction-limited launch acceleration (m/s^2). */
  maxAccel: number
  /** Full-pedal braking (m/s^2). ~9 is a competent dry-road stop. */
  maxBrakeDecel: number
  handbrakeDecel: number
  /** Deceleration on a closed throttle. */
  engineBrakeDecel: number
  /** Rolling resistance as a constant deceleration (m/s^2). */
  rollingResistance: number
  /** Aerodynamic drag coefficient, as m/s^2 per (m/s)^2. */
  dragCoeff: number
  /**
   * Grip ceiling (m/s^2). This is what stops the kinematic model from turning
   * impossibly tightly at speed: beyond this the car understeers instead.
   */
  maxLatAccel: number
  maxSpeedKmh: number
  maxReverseKmh: number
}

export const DEFAULT_PARAMS: VehicleParams = {
  wheelbase: 2.6,
  mass: 1400,
  maxSteerDeg: 34,
  steerRateDegPerSec: 90,
  steerReturnDegPerSec: 130,
  enginePowerKw: 85,
  maxAccel: 3.6,
  maxBrakeDecel: 9.0,
  handbrakeDecel: 5.0,
  engineBrakeDecel: 0.9,
  rollingResistance: 0.15,
  dragCoeff: 0.00031,
  maxLatAccel: 7.5,
  maxSpeedKmh: 160,
  maxReverseKmh: 25,
}

export interface VehicleState {
  /** Sim plane position (m). +y is north; render maps it to -Z. */
  x: number
  y: number
  /** Heading (rad), counter-clockwise, 0 = +x. */
  heading: number
  /** Signed longitudinal speed (m/s). Negative while reversing. */
  speed: number
  /** Current road wheel angle (rad). Positive = left. */
  steer: number
  gear: Gear
  yawRate: number
  latAccel: number
  longAccel: number
  /** True while cornering demand exceeds available grip. */
  atGripLimit: boolean
  /** Metres travelled, for the HUD odometer. */
  odometer: number
}

export function createState(x = 0, y = 0, heading = 0): VehicleState {
  return {
    x,
    y,
    heading,
    speed: 0,
    steer: 0,
    gear: 'D',
    yawRate: 0,
    latAccel: 0,
    longAccel: 0,
    atGripLimit: false,
    odometer: 0,
  }
}

/**
 * Kinematic bicycle model with a grip ceiling.
 *
 * Chosen over a full rigid-body physics engine deliberately: it is stable at
 * any timestep, has no jitter at standstill, is trivially deterministic, and
 * every parameter maps to something a driving instructor would recognise. What
 * it does not model is weight transfer, individual tyre slip or oversteer —
 * none of which a rules-of-the-road trainer needs to grade.
 */
export function stepVehicle(
  s: VehicleState,
  input: DriverInput,
  p: VehicleParams,
  dt: number,
): void {
  // --- Steering: rate-limited toward the driver's demand -------------------
  const maxSteer = p.maxSteerDeg * DEG
  const target = input.steer * maxSteer
  const rate = (input.steer === 0 ? p.steerReturnDegPerSec : p.steerRateDegPerSec) * DEG
  s.steer = approach(s.steer, target, rate * dt)

  // --- Longitudinal -------------------------------------------------------
  const absV = Math.abs(s.speed)
  const dir = Math.sign(s.speed)
  let a = 0

  const powering = input.throttle > 0 && s.gear !== 'N'
  if (powering) {
    const gearDir = s.gear === 'D' ? 1 : -1
    const capMs = kmhToMs(s.gear === 'D' ? p.maxSpeedKmh : p.maxReverseKmh)
    // Power-limited above a few m/s, traction-limited below it.
    const available = Math.min(p.maxAccel, (p.enginePowerKw * 1000) / (p.mass * Math.max(absV, 2.5)))
    // Only ease off in the last stretch before the speed cap. Tapering across
    // the whole range (1 - v/vmax) looks reasonable but quietly destroys
    // mid-range acceleration: it was adding eight seconds to 0-100.
    const headroom = clamp((capMs - absV) / Math.max(capMs * 0.15, 1), 0, 1)
    a += gearDir * input.throttle * available * headroom
  }

  // Retarding forces, accumulated as a positive magnitude.
  let decel = 0
  if (!powering && absV > 0.1) decel += p.engineBrakeDecel
  if (absV > 0.01) {
    decel += p.rollingResistance + p.dragCoeff * absV * absV
    if (input.handbrake) decel += p.handbrakeDecel
    if (input.brake > 0) decel += input.brake * p.maxBrakeDecel

    // The tyres have a single grip budget. Braking must not stack on top of
    // engine braking and drag to beat the quoted figure — otherwise the
    // stopping distances the trainer teaches would be shorter than reality.
    if (input.brake > 0 || input.handbrake) decel = Math.min(decel, p.maxBrakeDecel)
  }
  a -= dir * decel

  let v = s.speed + a * dt
  // Resistive forces must bring the car to rest, never push it backwards.
  if (!powering && s.speed !== 0 && Math.sign(v) !== Math.sign(s.speed)) v = 0
  if (input.handbrake && Math.abs(v) < 0.3) v = 0
  // Below the deadband the resistive forces switch off, which would otherwise
  // leave the car drifting at a few millimetres per second indefinitely.
  if (!powering && Math.abs(v) < 0.05) v = 0

  const cap = kmhToMs(v >= 0 ? p.maxSpeedKmh : p.maxReverseKmh)
  v = clamp(v, -cap, cap)

  s.longAccel = (v - s.speed) / dt
  s.speed = v

  // --- Yaw: bicycle kinematics, clipped to the grip circle -----------------
  let yawRate = (s.speed / p.wheelbase) * Math.tan(s.steer)
  const demandedLat = s.speed * yawRate
  s.atGripLimit = false
  if (Math.abs(demandedLat) > p.maxLatAccel) {
    s.atGripLimit = true
    yawRate = (Math.sign(yawRate) * p.maxLatAccel) / Math.max(Math.abs(s.speed), 0.001)
  }
  s.yawRate = yawRate
  s.latAccel = s.speed * yawRate

  s.heading += yawRate * dt
  s.x += Math.cos(s.heading) * s.speed * dt
  s.y += Math.sin(s.heading) * s.speed * dt
  s.odometer += Math.abs(s.speed) * dt
}

/** Shifting between drive and reverse is only allowed at a standstill. */
export function requestReverseToggle(s: VehicleState): boolean {
  if (Math.abs(s.speed) > 0.3) return false
  s.gear = s.gear === 'R' ? 'D' : 'R'
  return true
}

/** Path radius of the rear axle at full lock — what the sim actually traces. */
export function rearAxleTurnRadius(p: VehicleParams): number {
  return p.wheelbase / Math.tan(p.maxSteerDeg * DEG)
}

/**
 * Kerb-to-kerb turning circle (m) at full lock. This is the figure quoted on a
 * car's spec sheet and the one that decides whether a turnabout fits inside a
 * given road width, so it is measured at the OUTER FRONT wheel, not the rear
 * axle — those differ by well over a metre.
 */
export function turningCircleDiameter(p: VehicleParams, trackHalfWidth = 0.78): number {
  const steer = p.maxSteerDeg * DEG
  return 2 * (p.wheelbase / Math.sin(steer) + trackHalfWidth)
}
