import type { DriverInput } from '../input/input'
import type { VehicleState } from '../sim/vehicle'
import type { LaneGraph, NodeId } from '../world/laneGraph'
import type { SignalController } from '../world/signals'
import { DRY_DAY, type Conditions } from '../sim/conditions'
import {
  NO_OBSERVATIONS,
  type Aspect,
  type AspectTally,
  type Fault,
  type Observations,
  type Rule,
  type RuleContext,
  type Verdict,
  type WorldSense,
} from './types'

/**
 * Failure thresholds from the RSA marking guidelines. A test is failed by any
 * one of these:
 *  - one or more Grade 3 faults
 *  - four or more of the SAME Grade 2 fault under one aspect
 *  - six or more Grade 2 faults under one heading
 *  - nine or more Grade 2 faults overall
 */
export const FAIL_THRESHOLDS = {
  grade3: 1,
  sameFaultPerAspect: 4,
  perAspect: 6,
  overall: 9,
} as const

export class RulesEngine {
  readonly faults: Fault[] = []
  private readonly tallies = new Map<Aspect, AspectTally>()
  private readonly lastFired = new Map<string, number>()
  private elapsed = 0

  constructor(
    private readonly rules: Rule[],
    private readonly graph: LaneGraph,
    private readonly signals: Map<NodeId, SignalController>,
  ) {}

  get seconds(): number {
    return this.elapsed
  }

  reset(): void {
    this.faults.length = 0
    this.tallies.clear()
    this.lastFired.clear()
    this.elapsed = 0
    for (const rule of this.rules) rule.reset?.()
  }

  update(
    state: VehicleState,
    input: DriverInput,
    dt: number,
    world: WorldSense | null = null,
    observations: Observations = NO_OBSERVATIONS,
    conditions: Conditions = DRY_DAY,
  ): void {
    this.elapsed += dt
    const loc = this.graph.locate(state.x, state.y, state.heading)
    const speedKmh = Math.abs(state.speed) * 3.6

    // Faults raised this step, held back so the double-marking rule can be
    // applied before any of them are committed.
    const pending: Fault[] = []

    for (const rule of this.rules) {
      const last = this.lastFired.get(rule.id)
      const onCooldown = last !== undefined && this.elapsed - last < rule.cooldown

      const ctx: RuleContext = {
        state,
        input,
        loc,
        graph: this.graph,
        signals: this.signals,
        t: this.elapsed,
        dt,
        speedKmh,
        world,
        observations,
        conditions,
        report: (spec) => {
          if (onCooldown) return
          pending.push({
            ruleId: rule.id,
            aspect: rule.aspect,
            grade: spec.grade,
            message: spec.message,
            t: this.elapsed,
            x: state.x,
            y: state.y,
            speedKmh,
            ...(spec.reference ? { reference: spec.reference } : {}),
          })
        },
      }
      rule.evaluate(ctx)
    }

    this.commit(pending)
  }

  /**
   * The guidelines say faults are not double-marked: where two apply, the one
   * carrying the most useful information is recorded. A Grade 3 always says
   * more than a Grade 2 raised for the same moment, so lesser faults sharing
   * an aspect with a Grade 3 this step are dropped.
   */
  private commit(pending: Fault[]): void {
    if (pending.length === 0) return
    const seriousAspects = new Set(pending.filter((f) => f.grade === 3).map((f) => f.aspect))

    for (const fault of pending) {
      if (fault.grade < 3 && seriousAspects.has(fault.aspect)) continue

      this.faults.push(fault)
      this.lastFired.set(fault.ruleId, this.elapsed)

      let tally = this.tallies.get(fault.aspect)
      if (!tally) {
        tally = { grade2: 0, grade3: 0, byRule: new Map() }
        this.tallies.set(fault.aspect, tally)
      }
      if (fault.grade === 2) {
        tally.grade2++
        tally.byRule.set(fault.ruleId, (tally.byRule.get(fault.ruleId) ?? 0) + 1)
      } else if (fault.grade === 3) {
        tally.grade3++
      }
    }
  }

  verdict(): Verdict {
    const grade1 = this.faults.filter((f) => f.grade === 1).length
    const grade2 = this.faults.filter((f) => f.grade === 2).length
    const grade3 = this.faults.filter((f) => f.grade === 3).length
    const reasons: string[] = []

    for (const fault of this.faults) {
      if (fault.grade === 3) {
        reasons.push(`Grade 3 fault — ${fault.message}`)
        break
      }
    }

    for (const [aspect, tally] of this.tallies) {
      if (tally.grade2 >= FAIL_THRESHOLDS.perAspect) {
        reasons.push(`${tally.grade2} Grade 2 faults under "${aspect}"`)
      }
      for (const [ruleId, count] of tally.byRule) {
        if (count >= FAIL_THRESHOLDS.sameFaultPerAspect) {
          reasons.push(`The same fault ${count} times under "${aspect}" (${ruleId})`)
        }
      }
    }

    if (grade2 >= FAIL_THRESHOLDS.overall) {
      reasons.push(`${grade2} Grade 2 faults overall`)
    }

    return { passed: reasons.length === 0, reasons, grade1, grade2, grade3 }
  }

  /** Per-aspect counts, for the post-drive report. */
  tallyFor(aspect: Aspect): AspectTally | undefined {
    return this.tallies.get(aspect)
  }
}
