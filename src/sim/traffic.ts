/**
 * Other road users.
 *
 * Traffic exists here to be read, not to be admired: the point of the whole
 * project is grading what the driver does about other people, and until there
 * is someone to give way to, half the Rules of the Road cannot be examined at
 * all. So the priorities are, in order: traffic that obeys the rules it is
 * meant to obey, traffic that behaves consistently enough to be gradeable, and
 * only then traffic that looks convincing.
 *
 * Longitudinal behaviour is the Intelligent Driver Model (Treiber, Hennecke
 * and Helbing, 2000). It is used because it is collision-free by construction
 * when its parameters are sane, which matters: traffic that rear-ends itself
 * would generate faults against the player that the player did not cause.
 *
 * Every road user sits on the lane graph — an edge, a direction, a lane and an
 * arc length — exactly as the player's localisation does. Nothing here holds a
 * free-floating position that could drift away from the road.
 */

import { mulberry32 } from '../core/rng'
import {
  angleDelta,
  approachBearing,
  directionAwayFrom,
  edgePoint,
  exitsFrom,
  laneForTravel,
  sampleEdge,
  type Edge,
  type EdgeId,
  type LaneGraph,
  type NodeId,
} from '../world/laneGraph'
import type { SignalController } from '../world/signals'

export type RoadUserKind = 'car' | 'van' | 'cyclist'

export interface KindProfile {
  length: number
  width: number
  /** Cap on desired speed (m/s), whatever the limit says. */
  maxSpeed: number
  /** Fraction of the speed limit this user aims for. */
  limitFactor: number
  /** Comfortable acceleration (m/s^2). */
  accel: number
  /** Comfortable deceleration (m/s^2). */
  decel: number
  /** Desired time gap to the vehicle ahead (s). */
  timeGap: number
  /** Minimum standstill gap (m). */
  minGap: number
  /** Offset from the centre of the lane; cyclists ride near the kerb. */
  laneOffset: number
}

export const KIND_PROFILES: Record<RoadUserKind, KindProfile> = {
  car: {
    length: 4.3,
    width: 1.8,
    maxSpeed: 33,
    limitFactor: 0.94,
    accel: 1.5,
    decel: 2.2,
    timeGap: 1.6,
    minGap: 2.4,
    laneOffset: 0,
  },
  van: {
    length: 6.2,
    width: 2.1,
    maxSpeed: 25,
    limitFactor: 0.88,
    accel: 1.0,
    decel: 1.9,
    timeGap: 1.9,
    minGap: 3,
    laneOffset: 0,
  },
  cyclist: {
    length: 1.8,
    width: 0.65,
    // A cyclist is slow and does not care what the limit is, which is the
    // whole point of putting one on a 60 km/h road.
    maxSpeed: 6.2,
    limitFactor: 1,
    accel: 0.8,
    decel: 1.6,
    timeGap: 1.2,
    minGap: 1.5,
    laneOffset: 1.1,
  },
}

export interface RoadUser {
  id: number
  kind: RoadUserKind
  edgeId: EdgeId
  direction: 1 | -1
  laneIndex: number
  /** Arc length along the edge, regardless of direction of travel. */
  s: number
  speed: number
  /** Exit chosen for the node ahead. */
  nextEdgeId: EdgeId | null
  /** True once past the stop line and committed to crossing. */
  inJunction: boolean
  /** The junction this user has already come to a halt at, if any. */
  haltedAt: NodeId | null
  /** Latched once a driver has waited long enough to stop deferring. */
  impatient: boolean
  /** Seconds spent stationary, so a deadlocked junction can be broken. */
  stoppedFor: number
  x: number
  y: number
  heading: number
  /** Colour seed, so the renderer can vary without storing anything itself. */
  tint: number
}

/** The player, seen the way traffic sees it: as something in the way. */
export interface PlayerObstacle {
  x: number
  y: number
  heading: number
  speed: number
  length: number
  width: number
  edgeId: EdgeId
  direction: 1 | -1
  laneIndex: number
  s: number
}

export interface TrafficOptions {
  /** Target number of road users on the network. */
  population: number
  /** Share of them that are cyclists. */
  cyclistShare: number
  /** Share of them that are vans. */
  vanShare: number
  seed: number
}

export const DEFAULT_TRAFFIC: TrafficOptions = {
  population: 24,
  cyclistShare: 0.18,
  vanShare: 0.14,
  seed: 20250207,
}

/** How far ahead a vehicle looks for something to follow. */
const LOOKAHEAD = 120

/** Gap in seconds a yielding driver will accept at a junction. */
const ACCEPTED_GAP = 4.5

/** Distance before the stop line at which a junction decision is taken. */
const DECISION_DISTANCE = 45

/**
 * After this long at a standstill a driver edges out regardless. Without it,
 * four cars meeting at an uncontrolled crossroads can each wait for the one on
 * their right forever, which is a real deadlock and not a useful one.
 */
const PATIENCE = 9

interface Obstacle {
  /** Clear distance to its back end (m). Negative means overlapping. */
  gap: number
  speed: number
}

/** A point on a road that traffic must stop short of, such as an occupied crossing. */
export interface RoadBlockage {
  edgeId: EdgeId
  s: number
}

export class TrafficSystem {
  readonly users: RoadUser[] = []
  private readonly rand: () => number
  private nextId = 1
  private blockages: readonly RoadBlockage[] = []

  constructor(
    private readonly graph: LaneGraph,
    private readonly signals: Map<NodeId, SignalController>,
    private readonly options: TrafficOptions = DEFAULT_TRAFFIC,
  ) {
    this.rand = mulberry32(options.seed)
    this.populate()
  }

  /** Remove every road user. Used when a scenario sets the road up by hand. */
  clear(): void {
    this.users.length = 0
  }

  /**
   * Put one road user exactly where it is wanted.
   *
   * Scenarios need the same situation every time: a cyclist at this point on
   * this road at this speed, not a cyclist somewhere plausible. Returns null
   * if the road cannot carry that user in that direction.
   */
  spawn(
    kind: RoadUserKind,
    edgeId: EdgeId,
    direction: 1 | -1,
    s: number,
    speed: number,
  ): RoadUser | null {
    const edge = this.graph.edges.get(edgeId)
    if (!edge) return null
    const laneIndex = laneForTravel(edge, direction, kind === 'cyclist' ? 'cycle' : 'general')
    if (laneIndex < 0) return null

    const user = this.make(kind, edge, direction, laneIndex, Math.max(0, Math.min(edge.length, s)))
    user.speed = speed
    this.users.push(user)
    return user
  }

  /**
   * Take away anyone standing in a given circle.
   *
   * Used where the drive starts: traffic is scattered over the network before
   * the car is placed, and a drive that begins with the player's bonnet inside
   * someone else's boot records a collision the driver did not cause.
   */
  clearAround(x: number, y: number, radius: number): void {
    for (let i = this.users.length - 1; i >= 0; i--) {
      const user = this.users[i]!
      if (Math.hypot(user.x - x, user.y - y) < radius) this.users.splice(i, 1)
    }
  }

  /**
   * Points traffic must stop short of this step. Set from outside rather than
   * owned here, because what blocks a road — a pedestrian on a crossing today,
   * a works lorry tomorrow — is not the traffic model's business.
   */
  setBlockages(blockages: readonly RoadBlockage[]): void {
    this.blockages = blockages
  }

  /** Distance to the nearest blockage ahead on this user's own road. */
  private blockageAhead(user: RoadUser): number | null {
    let nearest: number | null = null
    for (const block of this.blockages) {
      if (block.edgeId !== user.edgeId) continue
      const ahead = user.direction === 1 ? block.s - user.s : user.s - block.s
      // Measured to a point a car's length short of the crossing itself.
      const gap = ahead - KIND_PROFILES[user.kind].length / 2 - 1.5
      if (ahead <= 0 || gap > LOOKAHEAD) continue
      if (nearest === null || gap < nearest) nearest = gap
    }
    return nearest
  }

  private pickKind(): RoadUserKind {
    const r = this.rand()
    if (r < this.options.cyclistShare) return 'cyclist'
    if (r < this.options.cyclistShare + this.options.vanShare) return 'van'
    return 'car'
  }

  /** Scatter road users over the network, skipping junction mouths. */
  private populate(): void {
    const edges = [...this.graph.edges.values()]
    if (edges.length === 0) return

    let attempts = 0
    while (this.users.length < this.options.population && attempts < this.options.population * 40) {
      attempts++
      const edge = edges[Math.floor(this.rand() * edges.length)]!
      const direction: 1 | -1 = this.rand() < 0.5 ? 1 : -1
      const kind = this.pickKind()
      const laneIndex = laneForTravel(edge, direction, kind === 'cyclist' ? 'cycle' : 'general')
      if (laneIndex < 0) continue

      const usable = edge.length - edge.startTrim - edge.endTrim
      if (usable < 30) continue
      const s = edge.startTrim + 10 + this.rand() * (usable - 20)

      const candidate = this.make(kind, edge, direction, laneIndex, s)
      if (this.tooClose(candidate)) continue
      this.users.push(candidate)
    }
  }

  private make(
    kind: RoadUserKind,
    edge: Edge,
    direction: 1 | -1,
    laneIndex: number,
    s: number,
  ): RoadUser {
    const user: RoadUser = {
      id: this.nextId++,
      kind,
      edgeId: edge.id,
      direction,
      laneIndex,
      s,
      speed: 0,
      nextEdgeId: null,
      inJunction: false,
      haltedAt: null,
      impatient: false,
      stoppedFor: 0,
      x: 0,
      y: 0,
      heading: 0,
      tint: this.rand(),
    }
    user.speed = this.desiredSpeed(user) * 0.6
    this.place(user)
    return user
  }

  private tooClose(candidate: RoadUser): boolean {
    for (const other of this.users) {
      if (Math.hypot(other.x - candidate.x, other.y - candidate.y) < 12) return true
    }
    return false
  }

  /** Lateral offset of this user within its lane. */
  private lateral(user: RoadUser): number {
    const edge = this.graph.edge(user.edgeId)
    const centre = edge.laneOffset(user.laneIndex)
    const profile = KIND_PROFILES[user.kind]
    // "Towards the kerb" is the positive side when travelling with the edge.
    return centre + profile.laneOffset * user.direction
  }

  /** Recompute world pose from the user's place on the graph. */
  private place(user: RoadUser): void {
    const edge = this.graph.edge(user.edgeId)
    const pose = sampleEdge(edge, user.s)
    const p = edgePoint(edge, user.s, this.lateral(user))
    user.x = p.x
    user.y = p.y
    user.heading = user.direction === 1 ? pose.heading : pose.heading + Math.PI
  }

  private desiredSpeed(user: RoadUser): number {
    const profile = KIND_PROFILES[user.kind]
    const edge = this.graph.edge(user.edgeId)
    return Math.min(profile.maxSpeed, (edge.speedLimit / 3.6) * profile.limitFactor)
  }

  /** Distance from this user to the end of its current edge. */
  private distanceToNode(user: RoadUser): number {
    const edge = this.graph.edge(user.edgeId)
    return user.direction === 1 ? edge.length - user.s : user.s
  }

  private nodeAhead(user: RoadUser): NodeId {
    const edge = this.graph.edge(user.edgeId)
    return user.direction === 1 ? edge.to : edge.from
  }

  /**
   * Distance from `a` to `b` measured along `a`'s direction of travel, or null
   * when `b` is not ahead of `a` on a path `a` is taking.
   */
  private gapAlong(a: RoadUser | PlayerObstacle, b: RoadUser | PlayerObstacle, aheadLimit: number): number | null {
    const aLength = 'kind' in a ? KIND_PROFILES[a.kind].length : a.length
    const bLength = 'kind' in b ? KIND_PROFILES[b.kind].length : b.length

    if (a.edgeId === b.edgeId) {
      if (a.direction !== b.direction) return null
      const ahead = a.direction === 1 ? b.s - a.s : a.s - b.s
      if (ahead <= 0) return null
      return ahead - (aLength + bLength) / 2
    }

    // On the road beyond the junction, if that is the way this one is going.
    const next = 'nextEdgeId' in a ? a.nextEdgeId : null
    if (!next || next !== b.edgeId) return null

    const node = 'kind' in a ? this.nodeAhead(a) : this.playerNodeAhead(a)
    const bEdge = this.graph.edge(b.edgeId)
    const bDirection = directionAwayFrom(bEdge, node)
    if (b.direction !== bDirection) return null

    const intoNext = bDirection === 1 ? b.s : bEdge.length - b.s
    const total = this.distanceOf(a) + intoNext - (aLength + bLength) / 2
    return total <= aheadLimit ? total : null
  }

  private distanceOf(a: RoadUser | PlayerObstacle): number {
    if ('kind' in a) return this.distanceToNode(a)
    const edge = this.graph.edge(a.edgeId)
    return a.direction === 1 ? edge.length - a.s : a.s
  }

  private playerNodeAhead(player: PlayerObstacle): NodeId {
    const edge = this.graph.edge(player.edgeId)
    return player.direction === 1 ? edge.to : edge.from
  }

  /** Closest thing in front of `user`, be it traffic or the player. */
  private leader(user: RoadUser, player: PlayerObstacle | null): Obstacle | null {
    let best: Obstacle | null = null

    const consider = (gap: number | null, speed: number): void => {
      if (gap === null || gap > LOOKAHEAD) return
      if (!best || gap < best.gap) best = { gap, speed }
    }

    for (const other of this.users) {
      if (other === user) continue
      consider(this.gapAlong(user, other, LOOKAHEAD), other.speed)
    }
    if (player) consider(this.gapAlong(user, player, LOOKAHEAD), Math.abs(player.speed))

    return best
  }

  /**
   * Does this user have to give way at the junction it is approaching?
   *
   * Returns the distance at which it must be stopped, or null to carry on.
   */
  private junctionConstraint(user: RoadUser, player: PlayerObstacle | null): number | null {
    const distance = this.distanceToNode(user)
    const nodeId = this.nodeAhead(user)
    const node = this.graph.nodes.get(nodeId)
    if (!node?.junction) return null

    // The stop line sits just outside the paved junction area.
    const stopDistance = distance - node.junction.radius - 0.9

    // Committed only once actually MOVING past the line. Latching on position
    // alone let a car that had stopped a hand's width over the line declare
    // itself committed and drive through a red light from a standstill.
    if (user.inJunction || (stopDistance < -0.5 && user.speed > 0.3)) {
      user.inJunction = true
      return null
    }
    if (stopDistance > DECISION_DISTANCE) return null

    const control = node.junction.control

    if (control.kind === 'signals') {
      const aspect = this.signals.get(nodeId)?.aspectFor(user.edgeId) ?? 'red'
      if (aspect === 'green') return null
      if (aspect === 'amber') {
        // Stop if it can be done without standing on the brakes.
        const needed = (user.speed * user.speed) / (2 * Math.max(stopDistance, 0.5))
        return needed <= KIND_PROFILES[user.kind].decel * 1.6 ? stopDistance : null
      }
      return stopDistance
    }

    const mustGiveWay =
      control.kind === 'stop'
        ? control.stopEdges.includes(user.edgeId)
        : control.kind === 'yield'
          ? control.yieldEdges.includes(user.edgeId)
          : control.kind === 'uncontrolled'

    if (!mustGiveWay) return null

    // A stop sign means stopping, whether or not anything is coming, and it
    // means stopping rather than creeping: keyed off a halt actually having
    // happened, not off the current speed. Keyed off speed, the constraint
    // switched itself off at walking pace and the car crept over the line at a
    // steady 0.4 m/s without ever coming to rest.
    if (control.kind === 'stop' && user.haltedAt !== nodeId) {
      if (user.speed < 0.15 && stopDistance < 6) user.haltedAt = nodeId
      else return stopDistance
    }

    // Impatience has to LATCH. Keyed off the current wait, a driver who edged
    // forward immediately reset its own wait, deferred again, stopped, waited
    // again — four cars at an uncontrolled crossroads twitched at each other
    // indefinitely instead of one of them going.
    if (user.impatient) return null
    if (user.stoppedFor > this.patienceOf(user)) {
      user.impatient = true
      return null
    }
    return this.conflictAt(user, nodeId, player) ? stopDistance : null
  }

  /**
   * How long this driver will defer before going anyway. Varied per driver so
   * that a symmetric standoff is broken by one of them rather than by all four
   * setting off together.
   */
  private patienceOf(user: RoadUser): number {
    return PATIENCE * (0.55 + user.tint * 0.9)
  }

  /** Is someone with priority close enough to this junction to wait for? */
  private conflictAt(user: RoadUser, nodeId: NodeId, player: PlayerObstacle | null): boolean {
    const ourBearing = approachBearing(this.graph.edge(user.edgeId), nodeId)

    const threatens = (
      otherEdgeId: EdgeId,
      otherDistance: number,
      otherSpeed: number,
      otherInJunction: boolean,
    ): boolean => {
      if (otherEdgeId === user.edgeId) return false
      if (otherInJunction) return true
      if (otherDistance > 70) return false
      if (!this.otherHasPriority(nodeId, otherEdgeId, ourBearing)) return false
      return otherDistance / Math.max(otherSpeed, 1.5) < ACCEPTED_GAP
    }

    for (const other of this.users) {
      if (other === user) continue
      if (this.nodeAhead(other) !== nodeId) continue
      if (threatens(other.edgeId, this.distanceToNode(other), other.speed, other.inJunction)) {
        return true
      }
    }

    if (player && this.playerNodeAhead(player) === nodeId) {
      const distance = this.distanceOf(player)
      if (threatens(player.edgeId, distance, Math.abs(player.speed), distance < 2)) return true
    }
    return false
  }

  /**
   * Who goes first. Signals and signs settle most of it; where nothing does,
   * Irish practice is to yield to traffic coming from the right.
   */
  private otherHasPriority(nodeId: NodeId, otherEdge: EdgeId, ourBearing: number): boolean {
    const control = this.graph.nodes.get(nodeId)?.junction?.control
    if (!control) return false

    if (control.kind === 'signals') {
      return this.signals.get(nodeId)?.aspectFor(otherEdge) === 'green'
    }
    if (control.kind === 'stop') return !control.stopEdges.includes(otherEdge)
    if (control.kind === 'yield') return !control.yieldEdges.includes(otherEdge)

    const other = this.graph.edges.get(otherEdge)
    if (!other) return false

    // Both bearings point away from the junction while the traffic on them
    // travels towards it, so an approaching driver faces bearing + pi and its
    // right hand points along bearing + pi/2. An arm lying counter-clockwise
    // of ours is therefore the one on our right, and has priority.
    return angleDelta(ourBearing, approachBearing(other, nodeId)) > 0
  }

  /** Intelligent Driver Model acceleration. */
  private idmAccel(user: RoadUser, obstacle: Obstacle | null): number {
    const p = KIND_PROFILES[user.kind]
    const v = user.speed
    const v0 = Math.max(this.desiredSpeed(user), 0.5)

    let accel = p.accel * (1 - Math.pow(v / v0, 4))
    if (obstacle) {
      const gap = Math.max(obstacle.gap, 0.1)
      const closing = v - obstacle.speed
      const desired =
        p.minGap + Math.max(0, v * p.timeGap + (v * closing) / (2 * Math.sqrt(p.accel * p.decel)))
      accel -= p.accel * Math.pow(desired / gap, 2)
    }
    return accel
  }

  update(dt: number, player: PlayerObstacle | null = null): void {
    for (const user of this.users) {
      // Decide the exit early enough that followers can see where it is going.
      if (!user.nextEdgeId && this.distanceToNode(user) < LOOKAHEAD) {
        const exits = exitsFrom(this.graph, this.nodeAhead(user), user.edgeId)
        user.nextEdgeId = exits[Math.floor(this.rand() * exits.length)] ?? null
      }

      const leader = this.leader(user, player)
      const stopAt = this.junctionConstraint(user, player)

      let obstacle = leader
      const hold = (distance: number | null): void => {
        if (distance === null) return
        const asObstacle: Obstacle = { gap: Math.max(distance, 0.05), speed: 0 }
        if (!obstacle || asObstacle.gap < obstacle.gap) obstacle = asObstacle
      }
      hold(stopAt)
      hold(this.blockageAhead(user))

      const p = KIND_PROFILES[user.kind]
      const accel = Math.max(-p.decel * 2.5, Math.min(p.accel, this.idmAccel(user, obstacle)))
      user.speed = Math.max(0, user.speed + accel * dt)
      // Snap to a standstill only while slowing. Applied unconditionally, this
      // also swallowed the first step of every pull-away — a step's worth of
      // acceleration is less than the threshold — so anything that stopped,
      // at a red light or a stop sign, stayed stopped for ever.
      if (user.speed < 0.05 && accel <= 0) user.speed = 0

      user.stoppedFor = user.speed < 0.2 ? user.stoppedFor + dt : 0
      user.s += user.speed * dt * user.direction

      this.advanceOverNode(user)
      this.place(user)
    }
  }

  /** Hand the user on to its next road once it runs off the end of this one. */
  private advanceOverNode(user: RoadUser): void {
    const edge = this.graph.edge(user.edgeId)
    const overshoot = user.direction === 1 ? user.s - edge.length : -user.s
    if (overshoot < 0) return

    const node = this.nodeAhead(user)
    const nextId =
      user.nextEdgeId ?? exitsFrom(this.graph, node, user.edgeId)[0] ?? user.edgeId
    const next = this.graph.edges.get(nextId)
    if (!next) {
      // Nowhere to go: turn round rather than vanish or drive into the field.
      user.direction = user.direction === 1 ? -1 : 1
      user.s = Math.max(0, Math.min(edge.length, user.s))
      user.nextEdgeId = null
      user.inJunction = false
      user.impatient = false
      user.haltedAt = null
      return
    }

    const direction = directionAwayFrom(next, node)
    const laneIndex = laneForTravel(next, direction, user.kind === 'cyclist' ? 'cycle' : 'general')

    user.edgeId = next.id
    user.direction = direction
    user.laneIndex = laneIndex >= 0 ? laneIndex : 0
    user.s = direction === 1 ? overshoot : next.length - overshoot
    user.nextEdgeId = null
    user.inJunction = false
    user.haltedAt = null
    user.impatient = false
  }

  /**
   * The nearest road user in front of the player, in the player's own lane.
   * This is what the following-distance rule is graded against.
   */
  leaderForPlayer(player: PlayerObstacle): { gap: number; speed: number; kind: RoadUserKind } | null {
    let best: { gap: number; speed: number; kind: RoadUserKind } | null = null
    for (const other of this.users) {
      if (other.laneIndex !== player.laneIndex && other.edgeId === player.edgeId) continue
      const gap = this.gapAlong(player, other, LOOKAHEAD)
      if (gap === null) continue
      if (!best || gap < best.gap) best = { gap, speed: other.speed, kind: other.kind }
    }
    return best
  }

  /** Road users overlapping the player's body, as a rectangle test. */
  collisionsWith(player: PlayerObstacle): RoadUser[] {
    const hits: RoadUser[] = []
    for (const user of this.users) {
      const p = KIND_PROFILES[user.kind]
      // Cheap and slightly generous: two circles sized to each body.
      const reach = (p.length + player.length) / 2
      const distance = Math.hypot(user.x - player.x, user.y - player.y)
      if (distance < reach * 0.62) hits.push(user)
    }
    return hits
  }
}
