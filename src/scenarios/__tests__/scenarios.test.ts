import { describe, expect, it } from 'vitest'
import { PedestrianSystem } from '../../sim/pedestrians'
import { DEFAULT_TRAFFIC, TrafficSystem } from '../../sim/traffic'
import { createState, type VehicleState } from '../../sim/vehicle'
import { edgePoint, LaneGraph, sampleEdge, type NodeId } from '../../world/laneGraph'
import { createSignals, type SignalController } from '../../world/signals'
import { BALLYROAD } from '../../world/town'
import { SCENARIOS, scenarioById, type ScenarioWorld } from '../scenarios'

interface Harness {
  world: ScenarioWorld
  state: VehicleState
  graph: LaneGraph
  traffic: TrafficSystem
  pedestrians: PedestrianSystem
  signals: Map<NodeId, SignalController>
}

/**
 * The same handle on the world that the app gives a scenario. Kept here rather
 * than imported from main.ts, which cannot load without a DOM.
 */
function harness(): Harness {
  const graph = new LaneGraph(BALLYROAD)
  const signals = createSignals(graph)
  const traffic = new TrafficSystem(graph, signals, DEFAULT_TRAFFIC)
  const pedestrians = new PedestrianSystem(graph)
  const state = createState()

  const world: ScenarioWorld = {
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
  }
  return { world, state, graph, traffic, pedestrians, signals }
}

describe('the scenario library', () => {
  it('has unique ids, and a rule reference for every scenario', () => {
    const ids = SCENARIOS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const scenario of SCENARIOS) {
      expect(scenario.title.length).toBeGreaterThan(3)
      expect(scenario.brief.length).toBeGreaterThan(30)
      expect(scenario.reference).toContain('Rules of the Road')
    }
  })

  it('looks scenarios up by id', () => {
    expect(scenarioById('red-light')?.title).toContain('red light')
    expect(scenarioById('nope')).toBeUndefined()
  })

  it.each(SCENARIOS.map((s) => [s.id, s] as const))(
    'sets %s up on the road, facing the right way',
    (_id, scenario) => {
      const h = harness()
      scenario.setUp(h.world)

      const loc = h.graph.locate(h.state.x, h.state.y, h.state.heading)
      expect(loc).not.toBeNull()
      expect(loc!.offRoad).toBe(false)
      expect(Math.abs(loc!.headingError)).toBeLessThan(0.3)

      for (const user of h.traffic.users) {
        const userLoc = h.graph.locate(user.x, user.y, user.heading)
        expect(userLoc).not.toBeNull()
        expect(userLoc!.offRoad).toBe(false)
        // And nobody is standing on top of the driver.
        expect(Math.hypot(user.x - h.state.x, user.y - h.state.y)).toBeGreaterThan(7)
      }
    },
  )

  it.each(SCENARIOS.map((s) => [s.id, s] as const))(
    'gives %s something to interact with',
    (_id, scenario) => {
      const h = harness()
      scenario.setUp(h.world)
      const busy =
        h.traffic.users.length > 0 || h.pedestrians.people.some((p) => p.state !== 'away')
      expect(busy).toBe(true)
    },
  )

  it('puts a red light in front of the driver who is told to expect one', () => {
    const h = harness()
    scenarioById('red-light')!.setUp(h.world)
    expect(h.signals.get('n_cross')!.aspectFor('main_e')).toBe('red')
  })

  it('puts a pedestrian at the crossing the brief talks about', () => {
    const h = harness()
    scenarioById('pedestrian-crossing')!.setUp(h.world)
    expect(h.pedestrians.activeAt('residential', 165)).toBe(true)
  })

  it('puts circulating traffic on the roundabout, going clockwise', () => {
    const h = harness()
    scenarioById('roundabout-entry')!.setUp(h.world)
    const onRing = h.traffic.users.filter(
      (u) => h.graph.edge(u.edgeId).circulatoryOf === 'n_ne',
    )
    expect(onRing.length).toBeGreaterThanOrEqual(3)
    for (const user of onRing) expect(user.direction).toBe(1)
  })

  it('leaves each scenario stable rather than immediately colliding', () => {
    for (const scenario of SCENARIOS) {
      const h = harness()
      scenario.setUp(h.world)
      for (let i = 0; i < 60 * 8; i++) {
        h.pedestrians.update(h.graph, 1 / 60)
        h.traffic.setBlockages(h.pedestrians.blockages())
        h.traffic.update(1 / 60)
      }
      for (const user of h.traffic.users) {
        const loc = h.graph.locate(user.x, user.y, user.heading)
        expect(loc, `${scenario.id}: a road user left the map`).not.toBeNull()
        expect(loc!.offRoad, `${scenario.id}: a road user left the road`).toBe(false)
      }
    }
  })
})
