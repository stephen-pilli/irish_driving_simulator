import { describe, expect, it } from 'vitest'
import type { DriverInput } from '../../input/input'
import { RulesEngine } from '../../rules/engine'
import { PedestrianSystem } from '../../sim/pedestrians'
import { DEFAULT_TRAFFIC, TrafficSystem } from '../../sim/traffic'
import { createState, DEFAULT_PARAMS, stepVehicle, type VehicleState } from '../../sim/vehicle'
import { angleDelta, edgePoint, LaneGraph, sampleEdge } from '../../world/laneGraph'
import { createSignals } from '../../world/signals'
import { BALLYROAD } from '../../world/town'
import { MANOEUVRES, manoeuvreById, manoeuvreRule, type ExerciseOutcome } from '../manoeuvres'
import type { ScenarioWorld } from '../scenarios'

const DT = 1 / 120

/**
 * A manoeuvre under test, driven through the real vehicle model.
 *
 * Unlike the rule tests, these cannot cheat by sliding the car along the lane
 * graph: a turnabout IS the handling, and a hill start is entirely about what
 * the vehicle model does when the brake comes off.
 */
class Attempt {
  readonly graph = new LaneGraph(BALLYROAD)
  readonly signals = createSignals(this.graph)
  readonly traffic = new TrafficSystem(this.graph, this.signals, DEFAULT_TRAFFIC)
  readonly pedestrians = new PedestrianSystem(this.graph)
  readonly state: VehicleState = createState()
  readonly engine: RulesEngine
  outcome: ExerciseOutcome = 'inProgress'

  constructor(private readonly id: string) {
    const scenario = manoeuvreById(id)
    if (!scenario) throw new Error(`no manoeuvre ${id}`)
    scenario.exercise.reset()
    this.engine = new RulesEngine(
      [
        manoeuvreRule(
          () => scenario.exercise,
          (outcome) => {
            this.outcome = outcome
          },
        ),
      ],
      this.graph,
      this.signals,
    )
    scenario.setUp(this.world())
  }

  private world(): ScenarioWorld {
    const { graph, traffic, pedestrians, signals, state } = this
    return {
      graph,
      traffic,
      pedestrians,
      signals,
      placeCar(edgeId, s, options = {}) {
        const edge = graph.edge(edgeId)
        const backwards = options.backwards ?? false
        const lane = backwards ? edge.lanes.length - 1 : 0
        const p = edgePoint(edge, s, edge.laneOffset(lane))
        const pose = sampleEdge(edge, s)
        Object.assign(state, createState(p.x, p.y, pose.heading + (backwards ? Math.PI : 0)))
        state.speed = (options.speedKmh ?? 0) / 3.6
      },
      add(kind, edgeId, direction, s, speedKmh) {
        traffic.spawn(kind, edgeId, direction, s, speedKmh / 3.6)
      },
      setSignal(nodeId, edgeId, aspect) {
        signals.get(nodeId)?.forceAspect(edgeId, aspect)
      },
      setPedestrian(edgeId, s, pedestrianState) {
        pedestrians.force(graph, edgeId, s, pedestrianState)
      },
      holdOnParkBrake() {
        state.parkBrake = true
      },
    }
  }

  drive(seconds: number, input: Partial<DriverInput> = {}): this {
    const driver: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, ...input }
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      const here = this.graph.locate(this.state.x, this.state.y, this.state.heading)
      stepVehicle(
        this.state,
        driver,
        DEFAULT_PARAMS,
        DT,
        here && !here.offRoad ? here.gradient : 0,
      )
      this.engine.update(this.state, driver, DT, null)
    }
    return this
  }

  /**
   * Hold a target speed with the pedals, which is what a driver does and what
   * a manoeuvre needs. Driving a manoeuvre on a fixed throttle instead just
   * accelerates to the reverse limit and drives off into the field.
   */
  private hold(targetMs: number, steer: number): void {
    const v = Math.abs(this.state.speed)
    const throttle = v < targetMs ? 0.35 : 0
    const brake = v > targetMs * 1.35 ? 0.25 : 0
    this.drive(0.05, { throttle, brake, steer })
  }

  /** Creep at `targetMs` until `done()` says so, or `maxSeconds` run out. */
  creepUntil(targetMs: number, steer: number, maxSeconds: number, done: () => boolean): this {
    for (let t = 0; t < maxSeconds; t += 0.05) {
      this.hold(targetMs, steer)
      if (done()) break
    }
    return this
  }

  get on(): string | null {
    return this.graph.locate(this.state.x, this.state.y, this.state.heading)?.edge.id ?? null
  }

  /** Drive until the car is on `edgeId`, or `maxSeconds` run out. */
  driveUntilOn(edgeId: string, maxSeconds: number, input: Partial<DriverInput> = {}): this {
    for (let t = 0; t < maxSeconds; t += 0.1) {
      this.drive(0.1, input)
      const loc = this.graph.locate(this.state.x, this.state.y, this.state.heading)
      if (loc?.edge.id === edgeId) break
    }
    return this
  }

  /**
   * Shuffle the car round at full lock, changing direction whenever it runs
   * out of road, until it faces the other way or the moves run out.
   */
  turnUntilRoundOrOutOfMoves(moves: number): this {
    const start = this.state.heading
    let forwards = true

    for (let move = 0; move < moves; move++) {
      this.state.gear = forwards ? 'D' : 'R'
      // Right lock going forward, left lock coming back: a turnabout starts
      // from the left kerb and crosses the road, so steering left on the first
      // move simply drives into the kerb it started against.
      const steer = forwards ? -1 : 1

      for (let t = 0; t < 6; t += 0.05) {
        this.drive(0.05, { throttle: 0.5, steer })
        const loc = this.graph.locate(this.state.x, this.state.y, this.state.heading)
        if (!loc) break
        // Stop short of the kerb rather than climbing it — but not before the
        // move has started, or a move that begins near the kerb ends at once
        // and the car shuffles on the spot for ever.
        if (t > 0.6 && Math.abs(loc.lateral) > loc.edge.halfWidth - 1.3) break
        if (Math.abs(angleDelta(start + Math.PI, this.state.heading)) < 0.3) break
      }
      this.drive(1.2, { brake: 1 })

      if (Math.abs(angleDelta(start + Math.PI, this.state.heading)) < 0.3) break
      forwards = !forwards
    }
    this.drive(0.6, { brake: 1 })
    return this
  }

  get faults(): string[] {
    return this.engine.faults.map((f) => `G${f.grade} ${f.message}`)
  }

  get id_(): string {
    return this.id
  }
}

describe('the manoeuvre library', () => {
  it('has a grader and a reference for every manoeuvre', () => {
    expect(MANOEUVRES.length).toBeGreaterThanOrEqual(3)
    for (const m of MANOEUVRES) {
      expect(m.exercise).toBeDefined()
      expect(m.reference).toContain('Rules of the Road')
      expect(m.brief.length).toBeGreaterThan(40)
    }
  })

  it('sets every manoeuvre up on the road with nothing in the way', () => {
    for (const m of MANOEUVRES) {
      const attempt = new Attempt(m.id)
      const loc = attempt.graph.locate(
        attempt.state.x,
        attempt.state.y,
        attempt.state.heading,
      )
      expect(loc, m.id).not.toBeNull()
      expect(loc!.offRoad, m.id).toBe(false)
      expect(attempt.traffic.users, m.id).toHaveLength(0)
    }
  })
})

describe('the hill start', () => {
  it('starts held, on a slope that would otherwise run away', () => {
    const attempt = new Attempt('hill-start')
    expect(attempt.state.parkBrake).toBe(true)

    const loc = attempt.graph.locate(attempt.state.x, attempt.state.y, attempt.state.heading)
    expect(loc!.gradient).toBeGreaterThan(0.04)

    const before = attempt.state.x
    attempt.drive(4)
    expect(attempt.state.x).toBe(before)
    expect(attempt.faults).toHaveLength(0)
  })

  it('passes a clean pull-away', () => {
    const attempt = new Attempt('hill-start')
    attempt.drive(6, { throttle: 1 })
    expect(attempt.outcome).toBe('complete')
    expect(attempt.faults).toHaveLength(0)
  })

  it('marks a roll-back', () => {
    const attempt = new Attempt('hill-start')
    // Enough throttle to release the brake, not enough to hold the car, then
    // enough. The fault is graded once the roll-back has stopped, so the
    // recovery is part of producing it.
    attempt.drive(2, { throttle: 0.1 })
    attempt.drive(6, { throttle: 1 })

    expect(attempt.faults.join(' ')).toContain('Rolled back')
    expect(attempt.engine.faults[0]!.grade).toBe(2)
    expect(attempt.outcome).toBe('complete')
  })

  it('marks a long roll-back as dangerous', () => {
    const attempt = new Attempt('hill-start')
    attempt.drive(0.2, { throttle: 1 })
    attempt.drive(6, { throttle: 0 })
    expect(attempt.engine.faults[0]!.grade).toBe(3)
    expect(attempt.engine.verdict().passed).toBe(false)
  })
})

describe('the turnabout', () => {
  it('completes when the car ends up facing the other way', () => {
    const attempt = new Attempt('turnabout')
    const startHeading = attempt.state.heading

    // Shuffle back and forth at full lock, stopping each move before the kerb,
    // which is how the manoeuvre is actually done. Scripting fixed durations
    // instead just tests how well the durations were guessed.
    attempt.turnUntilRoundOrOutOfMoves(10)

    const turned = Math.abs(angleDelta(startHeading + Math.PI, attempt.state.heading))
    expect(turned, 'the shuffle should have reversed the heading').toBeLessThan(0.45)
    expect(attempt.outcome).toBe('complete')
  })

  it('marks mounting the kerb', () => {
    const attempt = new Attempt('turnabout')
    // Straight on into the verge rather than turning within the road.
    attempt.drive(3.5, { throttle: 0.5, steer: 1 })
    expect(attempt.faults.join(' ')).toContain('Mounted the kerb')
  })

  it('does not complete merely by driving along the road', () => {
    const attempt = new Attempt('turnabout')
    attempt.drive(6, { throttle: 0.4 })
    expect(attempt.outcome).toBe('inProgress')
  })
})

describe('reversing around a corner', () => {
  it('starts on the main road just past the side road', () => {
    const attempt = new Attempt('reverse-around-corner')
    const loc = attempt.graph.locate(attempt.state.x, attempt.state.y, attempt.state.heading)
    expect(loc!.edge.id).toBe('main_e')
    expect(attempt.outcome).toBe('inProgress')
  })

  it('completes once the car is well back into the side road', () => {
    const attempt = new Attempt('reverse-around-corner')
    attempt.state.gear = 'R'
    // Reversing, the tail goes the opposite way to the front wheels: with the
    // wheel to the left the back of the car swings right. The side road is on
    // the left of an eastbound car, so the tail has to go left, which means
    // the wheel goes left too — in this model steering left while reversing
    // turns the car clockwise and the tail to the north, into the side road.
    // Straight back well into the junction before touching the wheel. The
    // tail swings on a 7.7 m radius, so turning at the mouth of the side road
    // carries the car round the corner of the main road instead of into it.
    attempt.creepUntil(1.4, 0, 25, () => attempt.state.x < 4)
    attempt.creepUntil(1.4, 1, 20, () => attempt.state.heading < -Math.PI / 2)
    expect(attempt.on, 'should have reached the side road').toBe('residential')

    attempt.creepUntil(1.4, 0, 20, () => false)
    attempt.drive(1.5, { brake: 1 })

    expect(attempt.on).toBe('residential')
    expect(attempt.outcome).toBe('complete')
  })

  it('does not complete by driving forwards into the side road', () => {
    const attempt = new Attempt('reverse-around-corner')
    attempt.drive(2, { brake: 1 })
    expect(attempt.outcome).toBe('inProgress')
    expect(attempt.faults).toHaveLength(0)
  })
})
