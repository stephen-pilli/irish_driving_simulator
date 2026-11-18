import type { DriverInput } from '../input/input'
import type { VehicleState } from '../sim/vehicle'
import type { LaneGraph, Localisation, NodeId } from '../world/laneGraph'
import type { SignalController } from '../world/signals'

/**
 * Fault grades, as used on the RSA driving test report form.
 *
 *  1 — minor; recorded but does not count towards the result.
 *  2 — serious.
 *  3 — dangerous, potentially dangerous, or ignoring a traffic control.
 *
 * Source: RSA, "Making Your Mark — Marking Guidelines for the Driving Test".
 */
export type FaultGrade = 1 | 2 | 3

/**
 * Headings on the test report form. Faults are tallied per aspect as well as
 * overall, because the pass/fail rules have per-aspect thresholds.
 */
export type Aspect =
  | 'Vehicle controls'
  | 'Moving off'
  | 'Progress'
  | 'Road position'
  | 'Overtaking'
  | 'Speed'
  | 'Traffic controls'
  | 'Observation'
  | 'Anticipation and reaction'

export interface Fault {
  ruleId: string
  aspect: Aspect
  grade: FaultGrade
  message: string
  /** Seconds into the drive. */
  t: number
  x: number
  y: number
  speedKmh: number
  /** Where in the Rules of the Road this comes from, for the report. */
  reference?: string
}

export interface FaultSpec {
  grade: FaultGrade
  message: string
  reference?: string
}

export interface RuleContext {
  state: Readonly<VehicleState>
  input: Readonly<DriverInput>
  /** Null when the car is nowhere near any road. */
  loc: Localisation | null
  graph: LaneGraph
  signals: Map<NodeId, SignalController>
  /** Seconds since the drive began. */
  t: number
  dt: number
  speedKmh: number
  /** Report a fault. The engine applies the cooldown and double-marking rules. */
  report(spec: FaultSpec): void
}

export interface Rule {
  id: string
  aspect: Aspect
  /**
   * Minimum seconds before this rule may fire again. The RSA records a fault
   * once per occurrence, not once per frame, so every rule needs one.
   */
  cooldown: number
  /** Called once per simulation step. */
  evaluate(ctx: RuleContext): void
  /** Clear any accumulated state between drives. */
  reset?(): void
}

export interface AspectTally {
  grade2: number
  grade3: number
  /** Grade 2 counts per rule, for the "same fault four times" threshold. */
  byRule: Map<string, number>
}

export interface Verdict {
  passed: boolean
  /** Why the test was failed, in the marking guidelines' own terms. */
  reasons: string[]
  grade1: number
  grade2: number
  grade3: number
}
