import type { DriverInput } from '../../input/input'
import { createState, type VehicleState } from '../../sim/vehicle'
import { edgePoint, LaneGraph, sampleEdge, type EdgeId } from '../../world/laneGraph'
import { createSignals } from '../../world/signals'
import { BALLYROAD } from '../../world/town'
import { RulesEngine } from '../engine'
import { irishRules } from '../irish'
import type { Fault, Rule, WorldSense } from '../types'

export interface PlaceOptions {
  /** Lane index, or an explicit lateral offset from the centre line. */
  laneIndex?: number
  lateral?: number
  speedKmh: number
  /** Travel against the edge's direction. */
  backwards?: boolean
}

/**
 * A scripted drive. The car is moved along the lane graph directly rather than
 * through the vehicle model: rule tests should fail when a RULE is wrong, not
 * when the handling changes. The vehicle model has its own tests.
 */
export class ScriptedDrive {
  readonly graph = new LaneGraph(BALLYROAD)
  readonly signals = createSignals(this.graph)
  readonly engine: RulesEngine
  readonly state: VehicleState = createState()
  readonly input: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false }

  private edgeId: EdgeId = 'main_e'
  private s = 0
  private lateral = 0
  private speedMs = 0
  private backwards = false
  /**
   * What the car can see of other road users. A stub by default — no traffic,
   * no pedestrians, nothing to hit — so a test only has to describe the part
   * of the world its own rule is about.
   */
  world: WorldSense = {
    leader: () => null,
    collisions: () => 0,
    pedestrianAhead: () => null,
    mustGiveWay: () => false,
  }

  constructor(rules: Rule[] = irishRules()) {
    this.engine = new RulesEngine(rules, this.graph, this.signals)
  }

  place(edgeId: EdgeId, s: number, options: PlaceOptions): this {
    const edge = this.graph.edge(edgeId)
    this.edgeId = edgeId
    this.s = s
    this.backwards = options.backwards ?? false
    this.lateral =
      options.lateral ??
      edge.laneOffset(options.laneIndex ?? (this.backwards ? edge.lanes.length - 1 : 0))
    this.speedMs = options.speedKmh / 3.6
    this.sync()
    return this
  }

  /** Change speed without moving the car. */
  setSpeed(kmh: number): this {
    this.speedMs = kmh / 3.6
    return this
  }

  setLateral(lateral: number): this {
    this.lateral = lateral
    this.sync()
    return this
  }

  private sync(): void {
    const edge = this.graph.edge(this.edgeId)
    const pose = sampleEdge(edge, this.s)
    const p = edgePoint(edge, this.s, this.lateral)
    this.state.x = p.x
    this.state.y = p.y
    this.state.heading = pose.heading + (this.backwards ? Math.PI : 0)
    this.state.speed = this.speedMs
  }

  /** Advance the drive by `seconds`, moving along the road as it goes. */
  run(seconds: number, dt = 1 / 60): this {
    const steps = Math.round(seconds / dt)
    for (let i = 0; i < steps; i++) {
      this.s += (this.backwards ? -1 : 1) * this.speedMs * dt
      this.sync()
      this.state.odometer += this.speedMs * dt
      for (const controller of this.signals.values()) controller.update(dt)
      this.engine.update(this.state, this.input, dt, this.world)
    }
    return this
  }

  /** Advance until the car passes `s`, or `maxSeconds` elapse. */
  runUntilPast(s: number, maxSeconds = 30, dt = 1 / 60): this {
    const steps = Math.round(maxSeconds / dt)
    for (let i = 0; i < steps; i++) {
      this.run(dt, dt)
      if (this.backwards ? this.s < s : this.s > s) break
    }
    return this
  }

  get faults(): Fault[] {
    return this.engine.faults
  }

  faultsOf(ruleId: string): Fault[] {
    return this.engine.faults.filter((f) => f.ruleId === ruleId)
  }

  get position(): number {
    return this.s
  }
}
