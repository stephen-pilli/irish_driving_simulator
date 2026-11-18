import { describe, expect, it } from 'vitest'
import { createState } from '../../sim/vehicle'
import { LaneGraph } from '../../world/laneGraph'
import { createSignals } from '../../world/signals'
import { BALLYROAD } from '../../world/town'
import { FAIL_THRESHOLDS, RulesEngine } from '../engine'
import type { Aspect, FaultGrade, Rule } from '../types'

const DT = 1 / 60
const input = { throttle: 0, brake: 0, steer: 0, handbrake: false }

/** A rule that fires on every step, for exercising the grading logic. */
const firing = (id: string, aspect: Aspect, grade: FaultGrade): Rule => ({
  id,
  aspect,
  cooldown: 0,
  evaluate: (ctx) => ctx.report({ grade, message: id }),
})

function engineWith(rules: Rule[]): RulesEngine {
  const graph = new LaneGraph(BALLYROAD)
  return new RulesEngine(rules, graph, createSignals(graph))
}

function step(engine: RulesEngine, times: number): void {
  const state = createState()
  for (let i = 0; i < times; i++) engine.update(state, input, DT)
}

describe('fault grading', () => {
  it('passes a clean drive', () => {
    const engine = engineWith([])
    step(engine, 100)
    expect(engine.verdict().passed).toBe(true)
  })

  it('ignores grade 1 faults entirely', () => {
    const engine = engineWith([firing('minor', 'Observation', 1)])
    step(engine, 30)
    const verdict = engine.verdict()
    expect(verdict.grade1).toBe(30)
    expect(verdict.passed).toBe(true)
  })

  it('fails on a single grade 3 fault', () => {
    const engine = engineWith([firing('dangerous', 'Traffic controls', 3)])
    step(engine, 1)
    const verdict = engine.verdict()
    expect(verdict.grade3).toBe(1)
    expect(verdict.passed).toBe(false)
    expect(verdict.reasons[0]).toContain('Grade 3')
  })

  it('fails on nine grade 2 faults spread across aspects', () => {
    // Spread thin enough that no single aspect hits its own threshold.
    const rules = ['Speed', 'Observation', 'Progress'].flatMap((aspect, a) =>
      [0, 1, 2].map((i) => firing(`r${a}-${i}`, aspect as Aspect, 2)),
    )
    const engine = engineWith(rules)
    step(engine, 1)

    const verdict = engine.verdict()
    expect(verdict.grade2).toBe(FAIL_THRESHOLDS.overall)
    expect(verdict.passed).toBe(false)
    expect(verdict.reasons.some((r) => r.includes('overall'))).toBe(true)
  })

  it('passes with eight grade 2 faults spread across aspects', () => {
    const rules = ['Speed', 'Observation', 'Progress', 'Moving off'].flatMap((aspect, a) =>
      [0, 1].map((i) => firing(`r${a}-${i}`, aspect as Aspect, 2)),
    )
    const engine = engineWith(rules)
    step(engine, 1)
    expect(engine.verdict().grade2).toBe(8)
    expect(engine.verdict().passed).toBe(true)
  })

  it('fails on six grade 2 faults under one heading', () => {
    const rules = [0, 1, 2, 3, 4, 5].map((i) => firing(`speed-${i}`, 'Speed', 2))
    const engine = engineWith(rules)
    step(engine, 1)

    const verdict = engine.verdict()
    expect(verdict.grade2).toBe(FAIL_THRESHOLDS.perAspect)
    expect(verdict.passed).toBe(false)
    expect(verdict.reasons.some((r) => r.includes('under "Speed"'))).toBe(true)
  })

  it('fails on the same grade 2 fault four times under one aspect', () => {
    const engine = engineWith([firing('repeat', 'Road position', 2)])
    step(engine, FAIL_THRESHOLDS.sameFaultPerAspect)

    const verdict = engine.verdict()
    expect(verdict.grade2).toBe(4)
    expect(verdict.passed).toBe(false)
    expect(verdict.reasons.some((r) => r.includes('4 times'))).toBe(true)
  })

  it('passes with the same grade 2 fault three times', () => {
    const engine = engineWith([firing('repeat', 'Road position', 2)])
    step(engine, 3)
    expect(engine.verdict().passed).toBe(true)
  })
})

describe('double marking', () => {
  it('drops a lesser fault raised alongside a grade 3 in the same aspect', () => {
    const engine = engineWith([
      firing('serious', 'Traffic controls', 2),
      firing('dangerous', 'Traffic controls', 3),
    ])
    step(engine, 1)

    expect(engine.faults).toHaveLength(1)
    expect(engine.faults[0]!.grade).toBe(3)
  })

  it('keeps a lesser fault in a different aspect', () => {
    const engine = engineWith([
      firing('serious', 'Speed', 2),
      firing('dangerous', 'Traffic controls', 3),
    ])
    step(engine, 1)
    expect(engine.faults).toHaveLength(2)
  })
})

describe('cooldown', () => {
  it('records a repeated condition once per occurrence, not once per frame', () => {
    const engine = engineWith([
      { ...firing('slow', 'Speed', 2), cooldown: 5 },
    ])
    step(engine, 60 * 12) // twelve seconds of continuous breach
    // Fires at t=0, then once every five seconds.
    expect(engine.faults.length).toBeLessThanOrEqual(3)
    expect(engine.faults.length).toBeGreaterThanOrEqual(2)
  })
})

describe('reset', () => {
  it('clears the report between drives', () => {
    const engine = engineWith([firing('x', 'Speed', 2)])
    step(engine, 3)
    expect(engine.faults.length).toBeGreaterThan(0)

    engine.reset()
    expect(engine.faults).toHaveLength(0)
    expect(engine.verdict().passed).toBe(true)
    expect(engine.seconds).toBe(0)
  })
})
