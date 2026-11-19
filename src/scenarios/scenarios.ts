/**
 * The scenario library.
 *
 * Random traffic is good for practising driving. It is bad for practising a
 * RULE, because the situation the rule is about may not turn up, and when it
 * does it will not turn up the same way twice. A scenario pins one down: the
 * same junction, the same vehicle, the same gap, every time, so that a driver
 * can try the same decision again and find out whether the change they made
 * was the thing that mattered.
 *
 * Each one names what is being examined and where it comes from, because
 * "you failed" is only useful next to "this is the rule".
 */

import type { SignalController } from '../world/signals'
import type { EdgeId, LaneGraph, NodeId } from '../world/laneGraph'
import type { PedestrianSystem } from '../sim/pedestrians'
import type { RoadUserKind, TrafficSystem } from '../sim/traffic'

export interface ScenarioWorld {
  graph: LaneGraph
  traffic: TrafficSystem
  pedestrians: PedestrianSystem
  signals: Map<NodeId, SignalController>
  /** Put the player on a road, facing the way it runs (or against it). */
  placeCar(edgeId: EdgeId, s: number, options?: { backwards?: boolean; speedKmh?: number }): void
  /** Put a road user on a road. Positive direction runs from->to. */
  add(kind: RoadUserKind, edgeId: EdgeId, direction: 1 | -1, s: number, speedKmh: number): void
  /** Force a set of lights to show a given aspect on a given approach. */
  setSignal(nodeId: NodeId, edgeId: EdgeId, aspect: 'red' | 'green'): void
  /** Start a pedestrian crossing, or waiting, at a crossing point. */
  setPedestrian(edgeId: EdgeId, s: number, state: 'waiting' | 'crossing'): void
  /** Leave the car held on the parking brake until the driver asks for drive. */
  holdOnParkBrake(): void
}

export interface Scenario {
  id: string
  title: string
  /** One or two sentences, shown before the driver sets off. */
  brief: string
  /** What is being examined, in the Rules of the Road's terms. */
  reference: string
  setUp(world: ScenarioWorld): void
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'yield-t-junction',
    title: 'Emerging at a yield sign',
    brief:
      'You are coming down the link road to the main street, where a yield sign applies. ' +
      'Traffic on the main road has priority. Wait for a gap you can take without making ' +
      'anyone else slow down.',
    reference: 'Rules of the Road — Yield signs',
    setUp(world) {
      world.traffic.clear()
      world.placeCar('north_link', 120, { backwards: true, speedKmh: 30 })
      // A steady stream along the road that has priority.
      for (let i = 0; i < 5; i++) {
        world.add('car', 'main_e', 1, 150 - i * 44, 48)
      }
    },
  },

  {
    id: 'roundabout-entry',
    title: 'Entering a roundabout',
    brief:
      'Traffic is already on the roundabout, and it goes clockwise. Give way to anyone ' +
      'coming from your right, take your exit, and do not stop on the roundabout itself.',
    reference: 'Rules of the Road — Roundabouts',
    setUp(world) {
      world.traffic.clear()
      world.placeCar('north_link', 60, { speedKmh: 35 })

      // Circulating traffic, placed on whatever ring the graph generated.
      const ring = [...world.graph.edges.values()].filter((e) => e.circulatoryOf === 'n_ne')
      ring.forEach((edge, i) => {
        world.add('car', edge.id, 1, edge.length * 0.4, 26)
        if (i === 0) world.add('van', edge.id, 1, edge.length * 0.8, 24)
      })
    },
  },

  {
    id: 'pedestrian-crossing',
    title: 'Someone waiting at a crossing',
    brief:
      'A pedestrian is waiting at the crossing ahead on the residential street. ' +
      'The limit here is 30. Stop and let them cross.',
    reference: 'Rules of the Road — Pedestrian crossings',
    setUp(world) {
      world.traffic.clear()
      world.placeCar('residential', 110, { speedKmh: 30 })
      world.setPedestrian('residential', 165, 'waiting')
    },
  },

  {
    id: 'cyclist-no-overtaking',
    title: 'A cyclist, and nowhere to pass',
    brief:
      'There is a cyclist ahead of you and a continuous white line down the middle of the ' +
      'road. Hold back. Overtaking here means crossing the line, and that is a serious ' +
      'fault whatever the reason.',
    reference: 'Rules of the Road — Overtaking, and continuous white lines',
    setUp(world) {
      world.traffic.clear()
      world.placeCar('town_south', 60, { speedKmh: 45 })
      world.add('cyclist', 'town_south', 1, 110, 18)
      world.add('car', 'town_south', -1, 190, 48)
    },
  },

  {
    id: 'red-light',
    title: 'Approaching a red light',
    brief:
      'The lights at the crossroads are against you. Stop at the line, and wait for green ' +
      'rather than setting off on red and amber.',
    reference: 'Rules of the Road — Traffic lights',
    setUp(world) {
      world.traffic.clear()
      world.placeCar('main_e', 80, { backwards: true, speedKmh: 45 })
      world.setSignal('n_cross', 'main_e', 'red')
      world.add('car', 'residential', 1, 40, 30)
    },
  },

  {
    id: 'stop-sign',
    title: 'A stop sign means stop',
    brief:
      'The road out of town meets the regional road at a stop sign. Come to a complete ' +
      'halt at the line — slowing down is not stopping — then go when it is clear.',
    reference: 'Rules of the Road — Stop signs',
    setUp(world) {
      world.traffic.clear()
      world.placeCar('town_south', 180, { speedKmh: 50 })
      world.add('car', 'regional', 1, 120, 72)
      world.add('van', 'regional', -1, 40, 68)
    },
  },

  {
    id: 'following-distance',
    title: 'Keeping your distance',
    brief:
      'A queue is building on the main street. Keep two seconds between you and the car ' +
      'in front, and keep it as the queue speeds up and slows down.',
    reference: 'Rules of the Road — Safe distance',
    setUp(world) {
      world.traffic.clear()
      world.placeCar('main_e', 220, { backwards: true, speedKmh: 40 })
      for (let i = 0; i < 4; i++) {
        world.add('car', 'main_e', -1, 190 - i * 26, 36)
      }
      world.setSignal('n_cross', 'main_e', 'red')
    },
  },

  {
    id: 'rural-speed',
    title: 'A rural road at 60',
    brief:
      'The limit on a rural local road is 60 km/h, and it has been since February 2025. ' +
      'That is a limit, not a target: the bends here are the reason.',
    reference: 'Rules of the Road — Speed limits',
    setUp(world) {
      world.traffic.clear()
      world.placeCar('rural', 40, { speedKmh: 60 })
      world.add('van', 'rural', -1, 230, 50)
      world.add('cyclist', 'rural', 1, 190, 18)
    },
  },
]

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}
