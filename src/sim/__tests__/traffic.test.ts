import { describe, expect, it } from 'vitest'
import { LaneGraph, laneForTravel, twoWay, type LaneGraphSpec } from '../../world/laneGraph'
import { createSignals } from '../../world/signals'
import { BALLYROAD } from '../../world/town'
import {
  KIND_PROFILES,
  TrafficSystem,
  type PlayerObstacle,
  type RoadUser,
  type TrafficOptions,
} from '../traffic'

const DT = 1 / 60

function town(options: Partial<TrafficOptions> = {}): TrafficSystem {
  const graph = new LaneGraph(BALLYROAD)
  return new TrafficSystem(graph, createSignals(graph), {
    population: 18,
    cyclistShare: 0.18,
    vanShare: 0.14,
    seed: 7,
    ...options,
  })
}

function run(traffic: TrafficSystem, seconds: number, player: PlayerObstacle | null = null): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) traffic.update(DT, player)
}

/** A straight road with a stop-controlled T-junction at its far end. */
const T_JUNCTION: LaneGraphSpec = {
  nodes: [
    { id: 'w', x: -300, y: 0 },
    { id: 'j', x: 0, y: 0, junction: { radius: 10, control: { kind: 'stop', stopEdges: ['side'] } } },
    { id: 'e', x: 300, y: 0 },
    { id: 's', x: 0, y: -300 },
  ],
  edges: [
    { id: 'main_w', from: 'w', to: 'j', category: 'urban', lanes: twoWay() },
    { id: 'main_e', from: 'j', to: 'e', category: 'urban', lanes: twoWay() },
    { id: 'side', from: 'j', to: 's', category: 'urban', lanes: twoWay() },
  ],
}

function place(
  traffic: TrafficSystem,
  graph: LaneGraph,
  edgeId: string,
  direction: 1 | -1,
  s: number,
  speed: number,
): RoadUser {
  const edge = graph.edge(edgeId)
  const user = traffic.users[0]!
  user.edgeId = edgeId
  user.direction = direction
  user.laneIndex = laneForTravel(edge, direction)
  user.s = s
  user.speed = speed
  user.nextEdgeId = null
  user.inJunction = false
  user.stoppedFor = 0
  return user
}

describe('traffic population', () => {
  it('puts every road user on a real lane, facing the right way', () => {
    const traffic = town()
    const graph = new LaneGraph(BALLYROAD)
    expect(traffic.users.length).toBeGreaterThan(8)

    for (const user of traffic.users) {
      const edge = graph.edge(user.edgeId)
      expect(edge.lanes[user.laneIndex]!.direction).toBe(user.direction)
      const loc = graph.locate(user.x, user.y, user.heading)
      expect(loc).not.toBeNull()
      expect(loc!.offRoad).toBe(false)
    }
  })

  it('is reproducible from its seed', () => {
    const a = town({ seed: 42 })
    const b = town({ seed: 42 })
    run(a, 12)
    run(b, 12)
    expect(a.users.map((u) => [u.edgeId, u.s, u.speed])).toEqual(
      b.users.map((u) => [u.edgeId, u.s, u.speed]),
    )
  })

  it('does not spawn anyone on top of anyone else', () => {
    const traffic = town({ population: 24 })
    for (let i = 0; i < traffic.users.length; i++) {
      for (let j = i + 1; j < traffic.users.length; j++) {
        const a = traffic.users[i]!
        const b = traffic.users[j]!
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(8)
      }
    }
  })
})

describe('traffic driving', () => {
  it('keeps everyone on the carriageway over a long run', () => {
    const traffic = town()
    const graph = new LaneGraph(BALLYROAD)
    run(traffic, 240)

    for (const user of traffic.users) {
      const loc = graph.locate(user.x, user.y, user.heading)
      expect(loc).not.toBeNull()
      // Cyclists ride near the kerb, so allow for the offset.
      expect(Math.abs(loc!.lateral)).toBeLessThanOrEqual(loc!.edge.halfWidth + 0.1)
    }
  })

  it('never drives into the back of anything', () => {
    const traffic = town({ population: 26 })
    for (let i = 0; i < 60 * 180; i++) {
      traffic.update(DT)
      if (i % 120 !== 0) continue
      for (let a = 0; a < traffic.users.length; a++) {
        for (let b = a + 1; b < traffic.users.length; b++) {
          const ua = traffic.users[a]!
          const ub = traffic.users[b]!
          // Only vehicles sharing a lane and direction are really in conflict;
          // passing on opposite sides of a centre line is not a collision.
          if (ua.edgeId !== ub.edgeId) continue
          if (ua.direction !== ub.direction || ua.laneIndex !== ub.laneIndex) continue
          const clear =
            Math.abs(ua.s - ub.s) -
            (KIND_PROFILES[ua.kind].length + KIND_PROFILES[ub.kind].length) / 2
          expect(clear).toBeGreaterThan(-0.5)
        }
      }
    }
  })

  it('obeys the speed limit of the road it is on', () => {
    const traffic = town()
    const graph = new LaneGraph(BALLYROAD)
    run(traffic, 120)
    for (const user of traffic.users) {
      const limit = graph.edge(user.edgeId).speedLimit / 3.6
      expect(user.speed).toBeLessThanOrEqual(limit + 0.5)
    }
  })

  it('holds cyclists to a cyclist’s speed on a fast road', () => {
    const graph = new LaneGraph(BALLYROAD)
    const traffic = new TrafficSystem(graph, createSignals(graph), {
      population: 10,
      cyclistShare: 1,
      vanShare: 0,
      seed: 3,
    })
    run(traffic, 90)
    for (const user of traffic.users) {
      expect(user.kind).toBe('cyclist')
      expect(user.speed).toBeLessThanOrEqual(KIND_PROFILES.cyclist.maxSpeed + 0.01)
    }
  })

  it('gets everyone moving rather than gridlocked', () => {
    const traffic = town()
    run(traffic, 90)
    const moving = traffic.users.filter((u) => u.speed > 1).length
    expect(moving).toBeGreaterThan(traffic.users.length / 2)
  })
})

describe('junction priority', () => {
  it('stops at a stop sign before entering', () => {
    const graph = new LaneGraph(T_JUNCTION)
    const traffic = new TrafficSystem(graph, createSignals(graph), {
      population: 1,
      cyclistShare: 0,
      vanShare: 0,
      seed: 1,
    })
    // Southbound on the side road is the wrong way; come north towards 'j'.
    const user = place(traffic, graph, 'side', -1, 120, 12)

    let stoppedShortOfTheLine = false
    for (let i = 0; i < 60 * 30; i++) {
      traffic.update(DT)
      if (user.edgeId === 'side' && user.speed < 0.2 && user.s > 10) stoppedShortOfTheLine = true
      if (user.edgeId !== 'side') break
    }
    expect(stoppedShortOfTheLine).toBe(true)
  })

  it('waits at a red light and goes on green', () => {
    const graph = new LaneGraph(BALLYROAD)
    const signals = createSignals(graph)
    const traffic = new TrafficSystem(graph, signals, {
      population: 1,
      cyclistShare: 0,
      vanShare: 0,
      seed: 5,
    })
    const controller = signals.get('n_cross')!
    const user = place(traffic, graph, 'main_e', -1, 60, 10)

    // Park the lights on red for this approach and check nobody crosses.
    while (controller.aspectFor('main_e') !== 'red') controller.update(0.5)
    const held = controller.phaseSeconds

    for (let i = 0; i < 60 * 20; i++) {
      controller.setPhaseSeconds(held)
      traffic.update(DT)
    }
    expect(user.edgeId).toBe('main_e')
    expect(user.speed).toBeLessThan(0.5)
    const stopLine = graph.edge('main_e').startTrim
    expect(user.s).toBeGreaterThan(stopLine - 1)

    // Let it run green and the same car should clear the junction.
    while (controller.aspectFor('main_e') !== 'green') controller.update(0.5)
    for (let i = 0; i < 60 * 25; i++) traffic.update(DT)
    expect(user.edgeId).not.toBe('main_e')
  })

  it('gives way to the right where nothing else decides it', () => {
    const cross: LaneGraphSpec = {
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
    const graph = new LaneGraph(cross)
    const traffic = new TrafficSystem(graph, createSignals(graph), {
      population: 2,
      cyclistShare: 0,
      vanShare: 0,
      seed: 11,
    })

    // Westbound car approaching from the east arm, and a northbound car
    // approaching from the south arm — which is on the westbound car's left,
    // so the westbound car goes first and the northbound one waits.
    const fromEast = traffic.users[0]!
    const fromSouth = traffic.users[1]!
    Object.assign(fromEast, {
      edgeId: 'east', direction: -1 as const, laneIndex: laneForTravel(graph.edge('east'), -1),
      s: 40, speed: 9, nextEdgeId: 'west', inJunction: false, stoppedFor: 0,
    })
    Object.assign(fromSouth, {
      edgeId: 'south', direction: -1 as const, laneIndex: laneForTravel(graph.edge('south'), -1),
      s: 40, speed: 9, nextEdgeId: 'north', inJunction: false, stoppedFor: 0,
    })

    // The property is the ORDER they cross in, not how hard the second one
    // brakes: once the first is through, the second stops deferring and gets
    // going again, so its lowest speed depends on the gap, not on the rule.
    let first: RoadUser | null = null
    for (let i = 0; i < 60 * 12 && !first; i++) {
      traffic.update(DT)
      if (fromEast.inJunction) first = fromEast
      else if (fromSouth.inJunction) first = fromSouth
    }
    expect(first).toBe(fromEast)
    expect(fromSouth.edgeId).toBe('south')
    expect(fromSouth.speed).toBeLessThan(9)
  })

  it('breaks a standoff rather than waiting for ever', () => {
    // Four cars meeting at an uncontrolled crossroads, each giving way to the
    // one on its right, is a genuine deadlock. Someone has to edge out.
    const cross: LaneGraphSpec = {
      nodes: [
        { id: 'c', x: 0, y: 0, junction: { radius: 10, control: { kind: 'uncontrolled' } } },
        { id: 'n', x: 0, y: 150 },
        { id: 'e', x: 150, y: 0 },
        { id: 'w', x: -150, y: 0 },
        { id: 's', x: 0, y: -150 },
      ],
      edges: [
        { id: 'north', from: 'c', to: 'n', category: 'urban', lanes: twoWay() },
        { id: 'east', from: 'c', to: 'e', category: 'urban', lanes: twoWay() },
        { id: 'west', from: 'c', to: 'w', category: 'urban', lanes: twoWay() },
        { id: 'south', from: 'c', to: 's', category: 'urban', lanes: twoWay() },
      ],
    }
    const graph = new LaneGraph(cross)
    const traffic = new TrafficSystem(graph, createSignals(graph), {
      population: 4,
      cyclistShare: 0,
      vanShare: 0,
      seed: 2,
    })
    traffic.users.forEach((user, i) => {
      const edgeId = ['north', 'east', 'south', 'west'][i]!
      Object.assign(user, {
        edgeId, direction: -1 as const, laneIndex: laneForTravel(graph.edge(edgeId), -1),
        s: 30, speed: 6, nextEdgeId: null, inJunction: false, stoppedFor: 0,
      })
    })

    run(traffic, 40)
    const cleared = traffic.users.filter(
      (u) => !['north', 'east', 'south', 'west'].includes(u.edgeId) || u.inJunction || u.speed > 1,
    ).length
    expect(cleared).toBeGreaterThan(0)
  })
})

describe('seeing the player', () => {
  const graph = new LaneGraph(T_JUNCTION)

  function playerOn(edgeId: string, direction: 1 | -1, s: number, speed: number): PlayerObstacle {
    const edge = graph.edge(edgeId)
    return {
      x: 0, y: 0, heading: 0, speed, length: 4.2, width: 1.8,
      edgeId, direction, laneIndex: laneForTravel(edge, direction), s,
    }
  }

  it('slows for the player when the player is the one in front', () => {
    const traffic = new TrafficSystem(graph, createSignals(graph), {
      population: 1, cyclistShare: 0, vanShare: 0, seed: 9,
    })
    const user = place(traffic, graph, 'main_w', 1, 40, 13)
    const player = playerOn('main_w', 1, 70, 0)

    run(traffic, 10, player)
    expect(user.speed).toBeLessThan(2)
    // And it stopped behind the player rather than through it.
    expect(player.s - user.s).toBeGreaterThan(4)
  })

  it('ignores a player going the other way on the far side of the road', () => {
    const traffic = new TrafficSystem(graph, createSignals(graph), {
      population: 1, cyclistShare: 0, vanShare: 0, seed: 9,
    })
    const user = place(traffic, graph, 'main_w', 1, 40, 13)
    const player = playerOn('main_w', -1, 70, 13)

    run(traffic, 6, player)
    expect(user.speed).toBeGreaterThan(8)
  })

  it('reports the gap to whatever is in front of the player', () => {
    const traffic = new TrafficSystem(graph, createSignals(graph), {
      population: 1, cyclistShare: 0, vanShare: 0, seed: 9,
    })
    const user = place(traffic, graph, 'main_w', 1, 90, 10)
    const player = playerOn('main_w', 1, 50, 14)

    const leader = traffic.leaderForPlayer(player)
    expect(leader).not.toBeNull()
    expect(leader!.gap).toBeCloseTo(40 - (KIND_PROFILES[user.kind].length + 4.2) / 2, 1)
    expect(leader!.kind).toBe(user.kind)
  })

  it('reports nothing in front when the player is the one in front', () => {
    const traffic = new TrafficSystem(graph, createSignals(graph), {
      population: 1, cyclistShare: 0, vanShare: 0, seed: 9,
    })
    place(traffic, graph, 'main_w', 1, 50, 10)
    expect(traffic.leaderForPlayer(playerOn('main_w', 1, 90, 10))).toBeNull()
  })

  it('notices contact with the player', () => {
    const traffic = new TrafficSystem(graph, createSignals(graph), {
      population: 1, cyclistShare: 0, vanShare: 0, seed: 9,
    })
    const user = place(traffic, graph, 'main_w', 1, 50, 0)
    traffic.update(DT)

    const player = playerOn('main_w', 1, 50, 5)
    player.x = user.x
    player.y = user.y
    expect(traffic.collisionsWith(player)).toHaveLength(1)

    player.x = user.x + 40
    expect(traffic.collisionsWith(player)).toHaveLength(0)
  })
})
