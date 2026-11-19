import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../../core/rng'
import { isCirculatory, LaneGraph, twoWay, type LaneGraphSpec } from '../../world/laneGraph'
import { BALLYROAD } from '../../world/town'
import { instructionText, planRoute, RouteProgress, turnBetween } from '../route'

const graph = new LaneGraph(BALLYROAD)

/** A plain crossroads, so "left" and "right" have an obvious right answer. */
const CROSS: LaneGraphSpec = {
  nodes: [
    { id: 'c', x: 0, y: 0, junction: { radius: 10, control: { kind: 'uncontrolled' } } },
    { id: 'n', x: 0, y: 200 },
    { id: 'e', x: 200, y: 0 },
    { id: 'w', x: -200, y: 0 },
    { id: 's', x: 0, y: -200 },
  ],
  edges: [
    { id: 'north', from: 'c', to: 'n', category: 'urban', lanes: twoWay() },
    { id: 'east', from: 'c', to: 'e', category: 'urban', lanes: twoWay() },
    { id: 'west', from: 'c', to: 'w', category: 'urban', lanes: twoWay() },
    { id: 'south', from: 'c', to: 's', category: 'urban', lanes: twoWay() },
  ],
}

describe('working out the turn', () => {
  const cross = new LaneGraph(CROSS)

  it('calls a left turn a left turn', () => {
    // Arriving from the west, heading east. North is on the left.
    expect(turnBetween(cross, 'c', 'west', 'north').kind).toBe('left')
  })

  it('calls a right turn a right turn', () => {
    expect(turnBetween(cross, 'c', 'west', 'south').kind).toBe('right')
  })

  it('calls carrying on ahead carrying on ahead', () => {
    expect(turnBetween(cross, 'c', 'west', 'east').kind).toBe('ahead')
  })

  it('is consistent from the other direction', () => {
    // Arriving from the east, heading west: now SOUTH is the left turn.
    expect(turnBetween(cross, 'c', 'east', 'south').kind).toBe('left')
    expect(turnBetween(cross, 'c', 'east', 'north').kind).toBe('right')
  })
})

describe('planning a route', () => {
  it('produces a connected chain of roads', () => {
    const route = planRoute(graph, 'main_e', 'n_east', 10, mulberry32(1))
    expect(route.legs.length).toBeGreaterThan(5)

    for (let i = 0; i < route.legs.length - 1; i++) {
      const leg = route.legs[i]!
      const next = route.legs[i + 1]!
      const nextEdge = graph.edge(next.edgeId)
      // Consecutive legs must actually meet at the junction between them.
      expect(nextEdge.from === leg.toNode || nextEdge.to === leg.toNode).toBe(true)
      expect(next.fromNode).toBe(leg.toNode)
    }
  })

  it('never doubles back on the road it just came down', () => {
    for (let seed = 1; seed < 40; seed++) {
      const route = planRoute(graph, 'main_e', 'n_east', 12, mulberry32(seed))
      for (let i = 0; i < route.legs.length - 1; i++) {
        expect(route.legs[i + 1]!.edgeId, `seed ${seed}`).not.toBe(route.legs[i]!.edgeId)
      }
    }
  })

  it('never ends the route on a roundabout', () => {
    for (let seed = 1; seed < 60; seed++) {
      const route = planRoute(graph, 'north_link', 'n_ne_r0', 9, mulberry32(seed))
      const last = route.legs[route.legs.length - 1]!
      expect(isCirculatory(graph.edge(last.edgeId)), `seed ${seed}`).toBe(false)
    }
  })

  it('gives an instruction for every leg except inside a roundabout', () => {
    for (let seed = 1; seed < 30; seed++) {
      const route = planRoute(graph, 'main_e', 'n_east', 8, mulberry32(seed))
      for (const leg of route.legs) {
        if (isCirculatory(graph.edge(leg.edgeId))) expect(leg.instruction).toBeNull()
        else expect(leg.instruction, `seed ${seed}`).not.toBeNull()
      }
    }
  })

  it('ends with an instruction to stop', () => {
    const route = planRoute(graph, 'main_e', 'n_east', 8, mulberry32(5))
    expect(route.legs[route.legs.length - 1]!.instruction).toEqual({ kind: 'finish' })
  })

  it('calls a roundabout a roundabout and counts the exit', () => {
    // Search seeds for a route that goes through the roundabout at all.
    let found: ReturnType<typeof planRoute> | null = null
    for (let seed = 1; seed < 400 && !found; seed++) {
      const route = planRoute(graph, 'north_link', 'n_ne_r0', 14, mulberry32(seed))
      if (route.legs.some((l) => isCirculatory(graph.edge(l.edgeId)))) found = route
    }
    expect(found, 'no planned route used the roundabout').not.toBeNull()

    const entry = found!.legs.find((l) => l.instruction?.kind === 'roundabout')
    expect(entry, 'entering a roundabout should be announced as one').toBeDefined()
    const instruction = entry!.instruction!
    if (instruction.kind !== 'roundabout') throw new Error('wrong instruction kind')
    expect(instruction.exit).toBeGreaterThanOrEqual(1)
    expect(instruction.exit).toBeLessThanOrEqual(3)
  })
})

describe('what the examiner says', () => {
  it('warns early and reminds late', () => {
    expect(instructionText({ kind: 'left' }, true)).toBe('At the junction ahead, turn left.')
    expect(instructionText({ kind: 'left' }, false)).toBe('Turn left here.')
  })

  it('names the exit in words', () => {
    expect(instructionText({ kind: 'roundabout', exit: 2 }, true)).toContain('second exit')
    expect(instructionText({ kind: 'roundabout', exit: 3 }, false)).toContain('third exit')
  })

  it('asks for a stop at the end', () => {
    expect(instructionText({ kind: 'finish' }, true)).toContain('end of the route')
  })
})

describe('following a route', () => {
  it('advances a leg at a time', () => {
    const route = planRoute(graph, 'main_e', 'n_east', 6, mulberry32(9))
    const progress = new RouteProgress(graph, route)
    const rand = mulberry32(9)

    expect(progress.update(route.legs[0]!.edgeId, rand)).toBe(false)
    expect(progress.leg?.edgeId).toBe(route.legs[0]!.edgeId)

    expect(progress.update(route.legs[1]!.edgeId, rand)).toBe(true)
    expect(progress.leg?.edgeId).toBe(route.legs[1]!.edgeId)
    expect(progress.state).toBe('onRoute')
  })

  it('re-plans rather than failing when the driver goes the wrong way', () => {
    const route = planRoute(graph, 'main_e', 'n_east', 6, mulberry32(11))
    const progress = new RouteProgress(graph, route)
    const rand = mulberry32(11)
    progress.update(route.legs[0]!.edgeId, rand)

    // Somewhere else entirely, that is nowhere in the plan.
    const stray = [...graph.edges.keys()].find(
      (id) => !route.legs.some((l) => l.edgeId === id),
    )!
    expect(progress.update(stray, rand)).toBe(true)
    expect(progress.state).toBe('offRoute')
    expect(progress.leg?.edgeId).toBe(stray)
    expect(progress.remaining).toBeGreaterThan(0)
  })

  it('knows when it has run out of route', () => {
    const route = planRoute(graph, 'main_e', 'n_east', 4, mulberry32(13))
    const progress = new RouteProgress(graph, route)
    const rand = mulberry32(13)
    for (const leg of route.legs) progress.update(leg.edgeId, rand)
    expect(progress.state).toBe('finished')
    expect(progress.remaining).toBe(0)
  })

  it('ignores being told nothing', () => {
    const route = planRoute(graph, 'main_e', 'n_east', 4, mulberry32(15))
    const progress = new RouteProgress(graph, route)
    expect(progress.update(null, mulberry32(15))).toBe(false)
    expect(progress.state).toBe('onRoute')
  })
})
