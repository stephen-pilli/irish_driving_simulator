/**
 * People on foot.
 *
 * Only at marked crossings, and deliberately so. A pedestrian who steps into
 * the road at a random point is a reaction test; a pedestrian at a crossing is
 * a rule, and the rule is the thing being taught: traffic must yield to anyone
 * on a crossing, and to anyone waiting to step onto one.
 *
 * Each crossing runs its own small cycle — nobody there, someone waiting at
 * the kerb, someone walking across — so that a driver who approaches the same
 * crossing twice does not meet the same thing both times.
 */

import { mulberry32 } from '../core/rng'
import { edgePoint, sampleEdge, type EdgeId, type LaneGraph } from '../world/laneGraph'

export type PedestrianState = 'away' | 'waiting' | 'crossing'

export interface Pedestrian {
  id: number
  edgeId: EdgeId
  /** Arc length of the crossing this person is using. */
  s: number
  /** Signed lateral position, walking from one kerb to the other. */
  lateral: number
  /** +1 walks towards increasing lateral, which is towards the left kerb. */
  direction: 1 | -1
  state: PedestrianState
  /** Seconds left in the current state. */
  timer: number
  x: number
  y: number
  /** Height of the road under them (m). */
  z: number
  /** Width of the carriageway here, so the walk has somewhere to end. */
  halfWidth: number
}

/** Walking pace, in metres per second. */
const WALK_SPEED = 1.35

/** How far beyond the kerb someone stands while waiting. */
const KERB_MARGIN = 1.2

export interface CrossingBlockage {
  edgeId: EdgeId
  s: number
}

export class PedestrianSystem {
  readonly people: Pedestrian[] = []
  private readonly rand: () => number

  constructor(graph: LaneGraph, seed = 99) {
    this.rand = mulberry32(seed)

    let id = 1
    for (const edge of graph.edges.values()) {
      for (const s of edge.crossings) {
        this.people.push({
          id: id++,
          edgeId: edge.id,
          s,
          direction: this.rand() < 0.5 ? 1 : -1,
          lateral: 0,
          state: 'away',
          timer: 4 + this.rand() * 18,
          x: 0,
          y: 0,
          z: 0,
          halfWidth: edge.halfWidth,
        })
      }
    }
    for (const person of this.people) {
      person.lateral = -person.direction * (person.halfWidth + KERB_MARGIN)
      this.place(graph, person)
    }
  }

  private place(graph: LaneGraph, person: Pedestrian): void {
    const edge = graph.edges.get(person.edgeId)
    if (!edge) return
    const p = edgePoint(edge, person.s, person.lateral)
    person.x = p.x
    person.y = p.y
    person.z = edge.elevationAt(person.s)
  }

  /** Heading of the road at a crossing, for drawing the stripes. */
  static headingAt(graph: LaneGraph, person: Pedestrian): number {
    const edge = graph.edges.get(person.edgeId)
    return edge ? sampleEdge(edge, person.s).heading : 0
  }

  update(graph: LaneGraph, dt: number): void {
    for (const person of this.people) {
      person.timer -= dt

      switch (person.state) {
        case 'away':
          if (person.timer <= 0) {
            person.direction = this.rand() < 0.5 ? 1 : -1
            person.lateral = -person.direction * (person.halfWidth + KERB_MARGIN)
            person.state = 'waiting'
            // A moment at the kerb: long enough that an attentive driver can
            // see someone is waiting, which is what the rule asks of them.
            person.timer = 1.5 + this.rand() * 2.5
          }
          break

        case 'waiting':
          if (person.timer <= 0) person.state = 'crossing'
          break

        case 'crossing': {
          person.lateral += person.direction * WALK_SPEED * dt
          const far = person.halfWidth + KERB_MARGIN
          if (Math.abs(person.lateral) >= far && Math.sign(person.lateral) === person.direction) {
            person.state = 'away'
            person.timer = 10 + this.rand() * 30
          }
          break
        }
      }

      this.place(graph, person)
    }
  }

  /** Crossings that traffic must currently stop short of. */
  blockages(): CrossingBlockage[] {
    const out: CrossingBlockage[] = []
    for (const person of this.people) {
      if (person.state === 'away') continue
      out.push({ edgeId: person.edgeId, s: person.s })
    }
    return out
  }

  /**
   * Is someone on, or waiting to step onto, the crossing at this point?
   *
   * Waiting counts. The Rules of the Road do not ask a driver to wait until
   * someone is already in front of the car.
   */
  activeAt(edgeId: EdgeId, s: number, tolerance = 1.5): boolean {
    return this.people.some(
      (p) => p.edgeId === edgeId && p.state !== 'away' && Math.abs(p.s - s) <= tolerance,
    )
  }

  /**
   * Put the person at a given crossing into a given state immediately. Used to
   * set a scenario up, where waiting for the cycle to come round would mean
   * the situation being practised might not appear at all.
   */
  force(graph: LaneGraph, edgeId: EdgeId, s: number, state: 'waiting' | 'crossing'): boolean {
    const person = this.people.find((p) => p.edgeId === edgeId && Math.abs(p.s - s) < 2)
    if (!person) return false

    person.state = state
    person.timer = state === 'waiting' ? 4 : 0
    person.lateral =
      state === 'waiting'
        ? -person.direction * (person.halfWidth + KERB_MARGIN)
        : -person.direction * person.halfWidth * 0.6
    this.place(graph, person)
    return true
  }

  /** Crossing points on an edge, whether or not anyone is at them. */
  crossingsOn(edgeId: EdgeId): number[] {
    return this.people.filter((p) => p.edgeId === edgeId).map((p) => p.s)
  }
}
