/**
 * Routes, and the directions an examiner gives for them.
 *
 * A test route is a sequence of roads. What makes it a test rather than a
 * drive is that the candidate is told where to go a few seconds before each
 * junction and has to deal with everything else themselves — which means the
 * instruction has to be derived from the geometry rather than written by hand,
 * or the moment anyone edits the town the examiner starts giving directions
 * into fields.
 *
 * Deliberately free of speech, timers and the DOM: this works out WHAT to say
 * and when the car has got there. Saying it is somebody else's job.
 */

import {
  angleDelta,
  approachBearing,
  directionAwayFrom,
  exitsFrom,
  isCirculatory,
  type EdgeId,
  type LaneGraph,
  type NodeId,
} from '../world/laneGraph'

export type Instruction =
  | { kind: 'ahead' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'roundabout'; exit: number }
  | { kind: 'finish' }

export interface RouteLeg {
  edgeId: EdgeId
  /** The node this leg leaves from. */
  fromNode: NodeId
  /** The node it arrives at. */
  toNode: NodeId
  /** What to do at `toNode`. Null on a leg the driver is simply following. */
  instruction: Instruction | null
}

export interface Route {
  legs: RouteLeg[]
}

/** Anything within this of straight on is "follow the road", not a turn. */
const AHEAD_RADIANS = 0.5

/**
 * The turn needed to get from one road to the next at a shared junction.
 *
 * Both bearings point away from the junction. The driver arrives travelling
 * along `arrival + pi`, so the turn is measured from there; counter-clockwise
 * is to the left in this coordinate system.
 */
export function turnBetween(
  graph: LaneGraph,
  node: NodeId,
  arrivedOn: EdgeId,
  leavingOn: EdgeId,
): Instruction {
  const arrival = graph.edges.get(arrivedOn)
  const departure = graph.edges.get(leavingOn)
  if (!arrival || !departure) return { kind: 'ahead' }

  const travelling = approachBearing(arrival, node) + Math.PI
  const turn = angleDelta(travelling, approachBearing(departure, node))

  if (Math.abs(turn) < AHEAD_RADIANS) return { kind: 'ahead' }
  return turn > 0 ? { kind: 'left' } : { kind: 'right' }
}

/**
 * Plan a route of roughly `legCount` roads, wandering the network without
 * doubling back on itself.
 */
export function planRoute(
  graph: LaneGraph,
  startEdgeId: EdgeId,
  towardsNode: NodeId,
  legCount: number,
  rand: () => number,
): Route {
  const legs: RouteLeg[] = []
  let edgeId = startEdgeId
  let node = towardsNode

  const step = (): boolean => {
    const edge = graph.edges.get(edgeId)
    if (!edge) return false
    const fromNode = edge.from === node ? edge.to : edge.from
    legs.push({ edgeId, fromNode, toNode: node, instruction: null })

    const exits = exitsFrom(graph, node, edgeId)
    if (exits.length === 0) return false

    // Prefer somewhere you can drive out of again. Sending a candidate down a
    // cul-de-sac and then asking them to turn round is a manoeuvre, not a
    // direction, and the examiner has no words for it here.
    const open = exits.filter((id) => {
      const candidate = graph.edges.get(id)
      if (!candidate) return false
      const far = directionAwayFrom(candidate, node) === 1 ? candidate.to : candidate.from
      return (graph.nodes.get(far)?.edges.length ?? 0) > 1
    })
    let pool = open.length ? open : exits

    // Do not send anyone round a roundabout twice. A random walk is perfectly
    // happy to keep circulating, and the exit then gets announced as "the
    // fifth exit" on a roundabout that has three.
    const circulatoryOf = edge.circulatoryOf
    if (circulatoryOf !== undefined) {
      const arms = [...graph.edges.values()].filter((e) => e.circulatoryOf === circulatoryOf).length
      let consecutive = 0
      for (let j = legs.length - 1; j >= 0; j--) {
        if (graph.edge(legs[j]!.edgeId).circulatoryOf !== circulatoryOf) break
        consecutive++
      }
      if (consecutive >= arms - 1) {
        const leaving = pool.filter((id) => graph.edges.get(id)?.circulatoryOf === undefined)
        if (leaving.length) pool = leaving
      }
    }

    const nextId = pool[Math.floor(rand() * pool.length)] ?? pool[0]!
    const next = graph.edges.get(nextId)
    if (!next) return false

    edgeId = nextId
    node = directionAwayFrom(next, node) === 1 ? next.to : next.from
    return true
  }

  for (let i = 0; i < legCount; i++) {
    if (!step()) break
  }

  // A route must not end on a roundabout: "pull in and stop" is not something
  // that can be done on a circulatory carriageway, and the last leg is where
  // that instruction goes.
  let guard = 0
  while (legs.length > 0 && isCirculatory(graph.edge(legs[legs.length - 1]!.edgeId)) && guard++ < 8) {
    if (!step()) break
  }

  return { legs: withInstructions(graph, legs) }
}

/**
 * Work out what to say at the end of each leg.
 *
 * A roundabout is not a sequence of left and right turns, even though that is
 * what the expanded graph contains, so a run of circulatory legs collapses
 * into one "take the Nth exit" given before the driver reaches it. The legs
 * inside the roundabout carry no instruction at all: being told "turn left"
 * halfway round one is worse than being told nothing.
 */
function withInstructions(graph: LaneGraph, legs: RouteLeg[]): RouteLeg[] {
  return legs.map((leg, i) => {
    const next = legs[i + 1]
    if (!next) return { ...leg, instruction: { kind: 'finish' } as Instruction }

    const nextEdge = graph.edges.get(next.edgeId)
    const thisEdge = graph.edges.get(leg.edgeId)
    if (!nextEdge || !thisEdge) return leg

    // Inside a roundabout: nothing to say, the instruction came earlier.
    if (isCirculatory(thisEdge)) return { ...leg, instruction: null }

    if (isCirculatory(nextEdge)) {
      // Each circulatory leg passes exactly one arm, so the exit taken is the
      // number of circulatory legs travelled.
      let exit = 0
      for (let j = i + 1; j < legs.length; j++) {
        const edge = graph.edges.get(legs[j]!.edgeId)
        if (!edge || !isCirculatory(edge)) break
        exit++
      }
      const arms = [...graph.edges.values()].filter(
        (e) => e.circulatoryOf === nextEdge.circulatoryOf,
      ).length
      return {
        ...leg,
        instruction: { kind: 'roundabout', exit: Math.max(1, Math.min(exit, arms)) },
      }
    }

    return { ...leg, instruction: turnBetween(graph, leg.toNode, leg.edgeId, next.edgeId) }
  })
}

/**
 * The words an examiner would use.
 *
 * `far` is true for the early warning given on the approach and false for the
 * reminder at the junction itself, because "at the junction ahead, turn left"
 * is useless when you are already at it.
 */
export function instructionText(instruction: Instruction, far: boolean): string {
  switch (instruction.kind) {
    case 'ahead':
      return far ? 'At the junction ahead, follow the road straight on.' : 'Straight on.'
    case 'left':
      return far ? 'At the junction ahead, turn left.' : 'Turn left here.'
    case 'right':
      return far ? 'At the junction ahead, turn right.' : 'Turn right here.'
    case 'roundabout':
      return far
        ? `At the roundabout ahead, take the ${ordinal(instruction.exit)} exit.`
        : `Take the ${ordinal(instruction.exit)} exit.`
    case 'finish':
      return far
        ? 'That is the end of the route. Pull in and stop when it is safe to do so.'
        : 'Pull in and stop when it is safe.'
  }
}

function ordinal(n: number): string {
  const words = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth']
  return words[n] ?? `${n}th`
}

export type RouteProgressState = 'onRoute' | 'offRoute' | 'finished'

/**
 * Where the car has got to along a route.
 *
 * Deviating is not itself a fault — a real examiner simply redirects — so
 * going the wrong way re-plans from wherever the car actually is rather than
 * ending the test.
 */
export class RouteProgress {
  private index = 0
  state: RouteProgressState = 'onRoute'

  constructor(
    private readonly graph: LaneGraph,
    public route: Route,
  ) {}

  get leg(): RouteLeg | null {
    return this.route.legs[this.index] ?? null
  }

  get nextLeg(): RouteLeg | null {
    return this.route.legs[this.index + 1] ?? null
  }

  get remaining(): number {
    return Math.max(0, this.route.legs.length - this.index - 1)
  }

  /**
   * Tell the route where the car is. Returns true when the leg changed, which
   * is the moment a new instruction becomes due.
   */
  update(currentEdge: EdgeId | null, rand: () => number): boolean {
    if (this.state === 'finished' || currentEdge === null) return false

    const current = this.route.legs[this.index]
    if (current && current.edgeId === currentEdge) {
      this.state = 'onRoute'
      return false
    }

    const next = this.route.legs[this.index + 1]
    if (next && next.edgeId === currentEdge) {
      this.index++
      this.state = 'onRoute'
      if (this.index >= this.route.legs.length - 1) this.state = 'finished'
      return true
    }

    // Somewhere else entirely: re-plan from here and carry on.
    const node = this.graph.edges.get(currentEdge)?.to
    if (!node) return false
    this.route = planRoute(this.graph, currentEdge, node, Math.max(3, this.remaining), rand)
    this.index = 0
    this.state = 'offRoute'
    return true
  }
}
