/**
 * Recording and replay of a drive.
 *
 * The simulation is deterministic — a fixed timestep, no randomness in the
 * vehicle model, no dependence on frame rate — so a drive is fully described by
 * its starting conditions plus the driver's input over time. Replaying those
 * inputs reproduces the drive exactly, including every fault the rules engine
 * raised.
 *
 * That is worth more than a video. A recording lets the post-drive report jump
 * to the moment a fault happened and show what the car was actually doing, and
 * it lets the test suite assert that a drive is reproducible rather than taking
 * determinism on trust.
 *
 * Input is stored as changes, not as one entry per step. A driver holds the
 * keys still for most of a drive, so a ten-minute drive at 120 Hz — 72,000
 * steps — usually comes to a few hundred entries.
 */

import type { DriverInput } from '../input/input'
import type { NodeId } from '../world/laneGraph'
import type { SignalController } from '../world/signals'
import { createState, stepVehicle, type Gear, type VehicleParams, type VehicleState } from './vehicle'

export interface InputFrame {
  /** Simulation step at which the input changed to this. */
  step: number
  throttle: number
  brake: number
  steer: number
  handbrake: boolean
}

export interface RecordedDrive {
  version: 1
  /** Seconds per simulation step. */
  dt: number
  steps: number
  start: VehicleState
  params: VehicleParams
  inputs: InputFrame[]
  /** Gear selections, which come from discrete actions rather than from input. */
  gears: Array<[step: number, gear: Gear]>
  /** Where each set of lights stood when the drive began. */
  signalPhases: Array<[node: NodeId, seconds: number]>
  /** Car position every `pathEvery` steps, for drawing the route. */
  path: Array<[x: number, y: number]>
  pathEvery: number
}

/** How often the path is sampled. At 120 Hz this is four points a second. */
const PATH_EVERY = 30

function sameInput(a: InputFrame, b: DriverInput): boolean {
  return (
    a.throttle === b.throttle &&
    a.brake === b.brake &&
    a.steer === b.steer &&
    a.handbrake === b.handbrake
  )
}

export class DriveRecorder {
  private frames: InputFrame[] = []
  private gears: Array<[number, Gear]> = []
  private path: Array<[number, number]> = []
  private signalPhases: Array<[NodeId, number]> = []
  private start: VehicleState = createState()
  private params: VehicleParams | null = null
  private dt = 1 / 120
  private step = 0
  private lastGear: Gear = 'D'

  get steps(): number {
    return this.step
  }

  get seconds(): number {
    return this.step * this.dt
  }

  begin(
    state: Readonly<VehicleState>,
    params: VehicleParams,
    signals: Map<NodeId, SignalController>,
    dt: number,
  ): void {
    this.frames = []
    this.gears = []
    this.path = []
    this.step = 0
    this.dt = dt
    this.start = { ...state }
    // Copied, not referenced: the tuning panel can move these mid-drive and a
    // recording that silently adopted the new numbers would not replay.
    this.params = { ...params }
    this.lastGear = state.gear
    this.signalPhases = [...signals.entries()].map(([id, c]) => [id, c.phaseSeconds])
  }

  /** Call once per simulation step, before the step is taken. */
  record(input: Readonly<DriverInput>, state: Readonly<VehicleState>): void {
    const last = this.frames[this.frames.length - 1]
    if (!last || !sameInput(last, input)) {
      this.frames.push({
        step: this.step,
        throttle: input.throttle,
        brake: input.brake,
        steer: input.steer,
        handbrake: input.handbrake,
      })
    }

    if (state.gear !== this.lastGear) {
      this.gears.push([this.step, state.gear])
      this.lastGear = state.gear
    }

    if (this.step % PATH_EVERY === 0) this.path.push([state.x, state.y])
    this.step++
  }

  finish(): RecordedDrive | null {
    if (!this.params || this.step === 0) return null
    return {
      version: 1,
      dt: this.dt,
      steps: this.step,
      start: { ...this.start },
      params: { ...this.params },
      inputs: [...this.frames],
      gears: [...this.gears],
      signalPhases: [...this.signalPhases],
      path: [...this.path],
      pathEvery: PATH_EVERY,
    }
  }
}

export interface ReplayCursor {
  state: VehicleState
  input: DriverInput
  step: number
  t: number
}

/**
 * A recording being played back, one simulation step at a time.
 *
 * Kept as an object with a cursor rather than a loop so the report screen can
 * drive it from the render loop, pause it, and jump to the moment a fault was
 * recorded.
 */
export class ReplaySession {
  readonly state: VehicleState
  readonly input: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false }
  private step = 0
  private frameIndex = 0
  private gearIndex = 0

  constructor(readonly drive: RecordedDrive) {
    this.state = { ...drive.start }
  }

  get finished(): boolean {
    return this.step >= this.drive.steps
  }

  /** Seconds of the recording played so far. */
  get seconds(): number {
    return this.step * this.drive.dt
  }

  get totalSeconds(): number {
    return this.drive.steps * this.drive.dt
  }

  /** Take one step. Returns false once the recording has run out. */
  advance(): boolean {
    if (this.finished) return false

    const { inputs, gears, params, dt } = this.drive
    while (this.frameIndex < inputs.length && inputs[this.frameIndex]!.step <= this.step) {
      const f = inputs[this.frameIndex]!
      this.input.throttle = f.throttle
      this.input.brake = f.brake
      this.input.steer = f.steer
      this.input.handbrake = f.handbrake
      this.frameIndex++
    }
    while (this.gearIndex < gears.length && gears[this.gearIndex]![0] <= this.step) {
      this.state.gear = gears[this.gearIndex]![1]
      this.gearIndex++
    }

    stepVehicle(this.state, this.input, params, dt)
    this.step++
    return true
  }

  /** Wind back to the beginning and play forward to `seconds`. */
  seek(seconds: number): void {
    const target = Math.max(0, Math.min(this.drive.steps, Math.round(seconds / this.drive.dt)))
    this.rewind()
    while (this.step < target) this.advance()
  }

  rewind(): void {
    Object.assign(this.state, this.drive.start)
    this.input.throttle = 0
    this.input.brake = 0
    this.input.steer = 0
    this.input.handbrake = false
    this.step = 0
    this.frameIndex = 0
    this.gearIndex = 0
  }
}

/**
 * Re-run a recorded drive to the end. `onStep` sees every step, which is how
 * the rules engine is fed during a verification replay.
 *
 * It fires AFTER the step is integrated, matching the live loop, where the
 * rules see the state the car ended the step in. Calling it before instead
 * shifts every fault one step earlier in the replay — close enough to look
 * right, wrong enough that the replay is no longer the same drive.
 */
export function replayDrive(
  drive: RecordedDrive,
  onStep?: (cursor: ReplayCursor) => void,
): VehicleState {
  const session = new ReplaySession(drive)
  let step = 0
  while (session.advance()) {
    onStep?.({ state: session.state, input: session.input, step, t: session.seconds })
    step++
  }
  return session.state
}

/**
 * Put a recorded drive's lights back where they stood. Called before a
 * replay; without it the lights carry on from wherever the live drive left
 * them and the replay diverges at the first junction.
 *
 * `atSeconds` winds them forward to a point partway through, for a replay that
 * starts just before a fault rather than at the beginning.
 */
export function restoreSignalPhases(
  drive: RecordedDrive,
  signals: Map<NodeId, SignalController>,
  atSeconds = 0,
): void {
  for (const [nodeId, seconds] of drive.signalPhases) {
    signals.get(nodeId)?.setPhaseSeconds(seconds + atSeconds)
  }
}

/**
 * The state the car was in at a given moment, reached by replaying up to it.
 * Used by the report to show what was happening when a fault was recorded.
 */
export function stateAt(drive: RecordedDrive, seconds: number): VehicleState {
  const session = new ReplaySession(drive)
  session.seek(seconds)
  return session.state
}
