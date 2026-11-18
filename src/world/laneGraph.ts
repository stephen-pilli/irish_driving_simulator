/**
 * The lane graph: a semantic description of the road network.
 *
 * This is the centre of the whole project. Road geometry is GENERATED from
 * this, rather than this being inferred from geometry, so the rules engine and
 * the renderer read exactly the same data. They cannot drift apart and disagree
 * about where a lane is, what the limit is, or who has priority.
 */

import { smoothPolyline } from '../core/spline'

export type NodeId = string
export type EdgeId = string

export interface Vec2 {
  x: number
  y: number
}

/**
 * Road categories carry Ireland's default speed limits.
 *
 * Verified against the Department of Transport's 2025 changes. Two of these are
 * mid-rollout and must be checked before being relied on:
 *  - ruralLocal fell 80 -> 60 km/h on 7 February 2025 (in force).
 *  - urbanCore is moving 50 -> 30 km/h via local authority bye-laws, targeted
 *    for completion by 31 March 2027, so coverage is patchy in the meantime.
 *  - nationalSecondary was slated to fall 100 -> 80 km/h; treat 80 as the
 *    working default but confirm before teaching it as fact.
 *
 * In practice an edge should carry an explicit `speedLimit` wherever the real
 * road is signed, and fall back to the category default only when it is not.
 */
export type RoadCategory =
  | 'motorway'
  | 'nationalPrimary'
  | 'nationalSecondary'
  | 'regional'
  | 'ruralLocal'
  | 'urban'
  | 'urbanCore'

export const DEFAULT_SPEED_LIMITS: Record<RoadCategory, number> = {
  motorway: 120,
  nationalPrimary: 100,
  nationalSecondary: 80,
  regional: 80,
  ruralLocal: 60,
  urban: 50,
  urbanCore: 30,
}

export type LaneKind = 'general' | 'bus' | 'cycle'

/** Markings down the middle of a two-way road. */
export type CentreLine =
  | 'broken' // may be crossed
  | 'continuous' // must not be crossed
  | 'doubleContinuous' // must not be crossed from either side
  | 'none'

export interface Lane {
  /** +1 travels from->to along the edge; -1 travels against it. */
  direction: 1 | -1
  width: number
  kind: LaneKind
}

export const generalLane = (direction: 1 | -1, width = 3.5): Lane => ({
  direction,
  width,
  kind: 'general',
})

/** A standard two-way road. Lanes read left to right along the edge. */
export const twoWay = (width = 3.5): Lane[] => [generalLane(1, width), generalLane(-1, width)]

export type JunctionControl =
  | { kind: 'uncontrolled' }
  /** Named edges must yield; the others have priority. */
  | { kind: 'yield'; yieldEdges: EdgeId[] }
  | { kind: 'stop'; stopEdges: EdgeId[] }
  | { kind: 'signals'; groups: EdgeId[][]; greenSeconds: number; amberSeconds: number }
  /**
   * A roundabout. Authored as a single node; the graph expands it into a real
   * one-way circulatory carriageway with a yield-controlled entry per arm, so
   * nothing downstream needs to know roundabouts exist as a special case.
   */
  | { kind: 'roundabout' }

export interface JunctionSpec {
  control: JunctionControl
  /** Radius of the paved junction area. Edges are trimmed back to it. */
  radius: number
}

export interface NodeSpec {
  id: NodeId
  x: number
  y: number
  junction?: JunctionSpec
  /**
   * Set by the roundabout expansion on the former junction node, which is left
   * behind with no edges so the renderer knows where to put the island.
   */
  island?: { radius: number }
}

export interface EdgeSpec {
  id: EdgeId
  from: NodeId
  to: NodeId
  /** Intermediate shape points; the edge is a straight line without them. */
  via?: Vec2[]
  category: RoadCategory
  /** Explicit signed limit, overriding the category default. */
  speedLimit?: number
  lanes?: Lane[]
  centreLine?: CentreLine
  /** Set on generated circulatory carriageway, naming the roundabout it rings. */
  circulatoryOf?: NodeId
}

export interface LaneGraphSpec {
  nodes: NodeSpec[]
  edges: EdgeSpec[]
}

export interface Edge {
  id: EdgeId
  from: NodeId
  to: NodeId
  category: RoadCategory
  speedLimit: number
  lanes: Lane[]
  centreLine: CentreLine
  /** Centre-line polyline, including both endpoints. */
  points: Vec2[]
  /** Arc length at each point. */
  cumulative: number[]
  length: number
  /** Arc length eaten by the junction at each end. */
  startTrim: number
  endTrim: number
  halfWidth: number
  /** Set on generated circulatory carriageway, naming the roundabout it rings. */
  circulatoryOf?: NodeId
  /** Lateral offset of a lane's centre. Positive is left of the centre line. */
  laneOffset(index: number): number
  /** Signed lateral span of a lane, as [nearEdge, farEdge] offsets. */
  laneSpan(index: number): [number, number]
}

export interface Node extends NodeSpec {
  /** Edges touching this node, in no particular order. */
  edges: EdgeId[]
}

export interface Localisation {
  edge: Edge
  /** Arc length along the edge from its `from` end. */
  s: number
  /** Signed distance from the centre line; positive is left along the edge. */
  lateral: number
  laneIndex: number
  lane: Lane
  /** True when the car is travelling broadly from->to. */
  withEdge: boolean
  /** Angle between the car's heading and its lane's direction (rad). */
  headingError: number
  speedLimit: number
  /** True when the car is outside the paved carriageway. */
  offRoad: boolean
  /** Distance to whichever end of the edge the car is heading towards. */
  distanceToEnd: number
  /** The node the car is heading towards. */
  aheadNode: NodeId
  /** Distance from the centre of the nearest lane the car occupies. */
  laneDeviation: number
}

const EPS = 1e-9

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** Shortest signed angle from `a` to `b`, in [-pi, pi]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

interface Segment {
  edgeId: EdgeId
  ax: number
  ay: number
  bx: number
  by: number
  /** Arc length at the segment's start. */
  s0: number
  length: number
}

const GRID_CELL = 24

export class LaneGraph {
  readonly nodes = new Map<NodeId, Node>()
  readonly edges = new Map<EdgeId, Edge>()
  private readonly segments: Segment[] = []
  private readonly grid = new Map<string, number[]>()

  constructor(rawSpec: LaneGraphSpec) {
    // Roundabouts are authored as a single node and expanded here, so the
    // editor and the town file stay readable while everything downstream sees
    // ordinary one-way roads with yield-controlled entries.
    const spec = expandRoundabouts(rawSpec)

    for (const n of spec.nodes) {
      this.nodes.set(n.id, { ...n, edges: [] })
    }

    for (const e of spec.edges) {
      const from = this.nodes.get(e.from)
      const to = this.nodes.get(e.to)
      if (!from || !to) throw new Error(`Edge ${e.id} references a missing node`)
      from.edges.push(e.id)
      to.edges.push(e.id)
      this.edges.set(e.id, this.buildEdge(e, from, to))
    }

    this.buildIndex()
  }

  private buildEdge(spec: EdgeSpec, from: Node, to: Node): Edge {
    const control: Vec2[] = [
      { x: from.x, y: from.y },
      ...(spec.via ?? []).map((p) => ({ x: p.x, y: p.y })),
      { x: to.x, y: to.y },
    ]
    // Shape points describe the road loosely; smoothing turns them into a
    // drivable curve and gives the localisation index fine-grained segments.
    const points: Vec2[] = control.length > 2 ? smoothPolyline(control, 4) : control

    const cumulative: number[] = [0]
    for (let i = 1; i < points.length; i++) {
      cumulative.push(cumulative[i - 1]! + dist(points[i - 1]!, points[i]!))
    }
    const length = cumulative[cumulative.length - 1]!

    const lanes = spec.lanes ?? twoWay()
    const totalWidth = lanes.reduce((sum, l) => sum + l.width, 0)
    const halfWidth = totalWidth / 2

    // Offsets are measured from the left kerb inwards, so lane 0 (the leftmost
    // looking along the edge) sits nearest the +halfWidth side.
    const offsets: Array<[number, number]> = []
    let cursor = halfWidth
    for (const lane of lanes) {
      offsets.push([cursor, cursor - lane.width])
      cursor -= lane.width
    }

    return {
      id: spec.id,
      from: spec.from,
      to: spec.to,
      category: spec.category,
      speedLimit: spec.speedLimit ?? DEFAULT_SPEED_LIMITS[spec.category],
      lanes,
      centreLine: spec.centreLine ?? (lanes.length > 1 ? 'broken' : 'none'),
      ...(spec.circulatoryOf ? { circulatoryOf: spec.circulatoryOf } : {}),
      points,
      cumulative,
      length,
      startTrim: from.junction?.radius ?? 0,
      endTrim: to.junction?.radius ?? 0,
      halfWidth,
      laneOffset: (i) => {
        const span = offsets[i]
        return span ? (span[0] + span[1]) / 2 : 0
      },
      laneSpan: (i) => offsets[i] ?? [0, 0],
    }
  }

  /**
   * Uniform grid over every road segment. Localisation runs every simulation
   * step, so a linear scan of the whole network is not an option once the town
   * grows beyond a handful of roads.
   */
  private buildIndex(): void {
    for (const edge of this.edges.values()) {
      for (let i = 0; i < edge.points.length - 1; i++) {
        const a = edge.points[i]!
        const b = edge.points[i + 1]!
        const index = this.segments.length
        this.segments.push({
          edgeId: edge.id,
          ax: a.x,
          ay: a.y,
          bx: b.x,
          by: b.y,
          s0: edge.cumulative[i]!,
          length: dist(a, b),
        })

        // Register the segment in every cell its bounding box touches, padded
        // by a lane's width so a car just off the road still finds it.
        const pad = edge.halfWidth + 6
        const x0 = Math.floor((Math.min(a.x, b.x) - pad) / GRID_CELL)
        const x1 = Math.floor((Math.max(a.x, b.x) + pad) / GRID_CELL)
        const y0 = Math.floor((Math.min(a.y, b.y) - pad) / GRID_CELL)
        const y1 = Math.floor((Math.max(a.y, b.y) + pad) / GRID_CELL)
        for (let cx = x0; cx <= x1; cx++) {
          for (let cy = y0; cy <= y1; cy++) {
            const key = `${cx},${cy}`
            const bucket = this.grid.get(key)
            if (bucket) bucket.push(index)
            else this.grid.set(key, [index])
          }
        }
      }
    }
  }

  edge(id: EdgeId): Edge {
    const e = this.edges.get(id)
    if (!e) throw new Error(`Unknown edge ${id}`)
    return e
  }

  node(id: NodeId): Node {
    const n = this.nodes.get(id)
    if (!n) throw new Error(`Unknown node ${id}`)
    return n
  }

  /**
   * Where is the car? Returns the nearest edge together with everything the
   * rules engine needs: lane, lateral position, heading error and limit.
   */
  locate(x: number, y: number, heading: number): Localisation | null {
    const cx = Math.floor(x / GRID_CELL)
    const cy = Math.floor(y / GRID_CELL)

    let best: { seg: Segment; t: number; distSq: number } | null = null
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = this.grid.get(`${gx},${gy}`)
        if (!bucket) continue
        for (const index of bucket) {
          const seg = this.segments[index]!
          const dx = seg.bx - seg.ax
          const dy = seg.by - seg.ay
          const lenSq = dx * dx + dy * dy
          const t =
            lenSq < EPS ? 0 : Math.max(0, Math.min(1, ((x - seg.ax) * dx + (y - seg.ay) * dy) / lenSq))
          const px = seg.ax + dx * t
          const py = seg.ay + dy * t
          const distSq = (x - px) * (x - px) + (y - py) * (y - py)
          if (!best || distSq < best.distSq) best = { seg, t, distSq }
        }
      }
    }
    if (!best) return null

    const { seg, t } = best
    const edge = this.edge(seg.edgeId)
    const tangent = Math.atan2(seg.by - seg.ay, seg.bx - seg.ax)

    // Signed lateral offset: positive to the LEFT of the edge direction.
    const px = seg.ax + (seg.bx - seg.ax) * t
    const py = seg.ay + (seg.by - seg.ay) * t
    const lateral = -Math.sin(tangent) * (x - px) + Math.cos(tangent) * (y - py)

    const s = seg.s0 + seg.length * t
    const withEdge = Math.abs(angleDelta(tangent, heading)) < Math.PI / 2

    // Pick the lane whose lateral span contains the car, clamping to the
    // nearest lane when it has strayed off the carriageway.
    let laneIndex = 0
    let bestGap = Infinity
    for (let i = 0; i < edge.lanes.length; i++) {
      const [near, far] = edge.laneSpan(i)
      const gap = lateral <= near && lateral >= far ? 0 : Math.min(Math.abs(lateral - near), Math.abs(lateral - far))
      if (gap < bestGap) {
        bestGap = gap
        laneIndex = i
      }
    }
    const lane = edge.lanes[laneIndex]!
    const laneHeading = lane.direction === 1 ? tangent : tangent + Math.PI

    return {
      edge,
      s,
      lateral,
      laneIndex,
      lane,
      withEdge,
      headingError: angleDelta(laneHeading, heading),
      speedLimit: edge.speedLimit,
      offRoad: Math.abs(lateral) > edge.halfWidth,
      distanceToEnd: withEdge ? edge.length - s : s,
      aheadNode: withEdge ? edge.to : edge.from,
      laneDeviation: lateral - edge.laneOffset(laneIndex),
    }
  }
}

export interface EdgePose {
  x: number
  y: number
  /** Tangent direction at this point (rad). */
  heading: number
}

/** Position and tangent at arc length `s` along an edge's centre line. */
export function sampleEdge(edge: Edge, s: number): EdgePose {
  const clamped = Math.max(0, Math.min(edge.length, s))
  let i = 1
  while (i < edge.cumulative.length - 1 && edge.cumulative[i]! < clamped) i++
  const s0 = edge.cumulative[i - 1]!
  const s1 = edge.cumulative[i]!
  const a = edge.points[i - 1]!
  const b = edge.points[i]!
  const t = s1 - s0 < EPS ? 0 : (clamped - s0) / (s1 - s0)
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    heading: Math.atan2(b.y - a.y, b.x - a.x),
  }
}

/** A point offset laterally from the centre line. Positive is to the left. */
export function edgePoint(edge: Edge, s: number, lateral: number): Vec2 {
  const pose = sampleEdge(edge, s)
  return {
    x: pose.x - Math.sin(pose.heading) * lateral,
    y: pose.y + Math.cos(pose.heading) * lateral,
  }
}

/**
 * Lateral offset of the boundary between opposing flows — where the centre
 * line is painted. Returns null for a one-way road, which has no centre line.
 */
export function centreLineOffset(edge: Edge): number | null {
  let cursor = edge.halfWidth
  for (let i = 0; i < edge.lanes.length - 1; i++) {
    cursor -= edge.lanes[i]!.width
    if (edge.lanes[i]!.direction !== edge.lanes[i + 1]!.direction) return cursor
  }
  return null
}

/** Lanes that travel towards `node`, with their combined lateral span. */
export function approachSpan(edge: Edge, node: NodeId): [number, number] | null {
  const direction = node === edge.to ? 1 : -1
  let near: number | null = null
  let far = 0
  for (let i = 0; i < edge.lanes.length; i++) {
    if (edge.lanes[i]!.direction !== direction) continue
    const [a, b] = edge.laneSpan(i)
    if (near === null) near = a
    far = b
  }
  return near === null ? null : [near, far]
}

export interface StopLine {
  nodeId: NodeId
  /** Metres to the stop line. Negative once the car has crossed it. */
  distance: number
}

/**
 * The stop line on the junction the car is approaching, if there is one.
 * Painted just short of the junction surface, matching the geometry.
 */
export function stopLineAhead(loc: Localisation, graph: LaneGraph): StopLine | null {
  const node = graph.nodes.get(loc.aheadNode)
  if (!node?.junction) return null
  const edge = loc.edge

  const lineS = loc.withEdge ? edge.length - edge.endTrim - 0.9 : edge.startTrim + 0.9
  const distance = loc.withEdge ? lineS - loc.s : loc.s - lineS
  return { nodeId: node.id, distance }
}

/** True when the car is inside or right on top of a junction. */
export function withinJunction(loc: Localisation, graph: LaneGraph, margin = 0): boolean {
  for (const nodeId of [loc.edge.from, loc.edge.to]) {
    const node = graph.nodes.get(nodeId)
    if (!node?.junction) continue
    const s = nodeId === loc.edge.to ? loc.edge.length - loc.s : loc.s
    if (s <= node.junction.radius + margin) return true
  }
  return false
}

/**
 * Width of a single-lane circulatory carriageway. Wider than a running lane:
 * a roundabout has to take a long vehicle tracking round a tight radius.
 */
const CIRCULATORY_WIDTH = 5.5

/** Radius of the paved entry area where an arm meets the ring. */
const ENTRY_RADIUS = 5

/**
 * Direction a road leaves a node, taking its shape points into account.
 *
 * Resolved against the working node list rather than the original spec, so a
 * road joining two roundabouts still has a bearing at the second one after the
 * first has already moved its far end onto a ring.
 */
function bearingFromNode(nodes: NodeSpec[], edge: EdgeSpec, nodeId: NodeId): number | null {
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) return null
  const via = edge.via ?? []
  const other = nodes.find((n) => n.id === (edge.from === nodeId ? edge.to : edge.from))
  if (!other) return null

  const next =
    edge.from === nodeId ? (via[0] ?? other) : (via[via.length - 1] ?? other)
  const dx = next.x - node.x
  const dy = next.y - node.y
  if (Math.hypot(dx, dy) < EPS) return null
  return Math.atan2(dy, dx)
}

/**
 * Turn every node controlled as a roundabout into an actual roundabout: a
 * one-way circulatory carriageway, an entry per arm that yields to it, and an
 * island in the middle.
 *
 * Done as a graph transformation rather than as a special case in the renderer
 * and the rules engine, because a roundabout genuinely IS a one-way road that
 * you give way onto. Expanding it means lane following, localisation, stop
 * lines, priority and traffic all work on it with no extra code, and it means
 * the thing the driver sees and the thing the rules read cannot disagree.
 *
 * The ring runs CLOCKWISE, which is the direction of travel in Ireland.
 */
export function expandRoundabouts(spec: LaneGraphSpec): LaneGraphSpec {
  const targets = spec.nodes.filter((n) => n.junction?.control.kind === 'roundabout')
  if (targets.length === 0) return spec

  const nodes: NodeSpec[] = spec.nodes.map((n) => ({ ...n }))
  const edges: EdgeSpec[] = spec.edges.map((e) => ({ ...e }))

  for (const centre of targets) {
    const node = nodes.find((n) => n.id === centre.id)!
    const radius = Math.max(8, centre.junction?.radius ?? 18)

    const arms = edges
      .filter((e) => e.from === centre.id || e.to === centre.id)
      .map((edge) => ({ edge, bearing: bearingFromNode(nodes, edge, centre.id) }))
      .filter((a): a is { edge: EdgeSpec; bearing: number } => a.bearing !== null)
      // Descending bearing is clockwise in this coordinate system.
      .sort((a, b) => b.bearing - a.bearing)

    // The centre node stays, stripped of its junction, purely to mark the
    // island. Without at least two arms there is nothing to ring.
    delete node.junction
    if (arms.length < 2) continue
    node.island = { radius: Math.max(1.5, radius - CIRCULATORY_WIDTH / 2 - 0.4) }

    const limit = Math.min(
      ...arms.map((a) => a.edge.speedLimit ?? DEFAULT_SPEED_LIMITS[a.edge.category]),
    )
    const slowest = arms.reduce((lowest, a) =>
      (a.edge.speedLimit ?? DEFAULT_SPEED_LIMITS[a.edge.category]) <
      (lowest.edge.speedLimit ?? DEFAULT_SPEED_LIMITS[lowest.edge.category])
        ? a
        : lowest,
    )

    // One node per arm, sitting on the ring where that arm meets it.
    const ringNodes = arms.map((arm, i) => {
      const id: NodeId = `${centre.id}_r${i}`
      nodes.push({
        id,
        x: centre.x + Math.cos(arm.bearing) * radius,
        y: centre.y + Math.sin(arm.bearing) * radius,
        junction: {
          radius: ENTRY_RADIUS,
          // Entering traffic gives way to traffic already on the roundabout.
          control: { kind: 'yield', yieldEdges: [arm.edge.id] },
        },
      })
      if (arm.edge.from === centre.id) arm.edge.from = id
      else arm.edge.to = id
      return id
    })

    for (let i = 0; i < arms.length; i++) {
      const a = arms[i]!
      const b = arms[(i + 1) % arms.length]!
      let delta = b.bearing - a.bearing
      // Always travel the short way clockwise, i.e. with bearing decreasing.
      while (delta > 0) delta -= Math.PI * 2
      while (delta <= -Math.PI * 2) delta += Math.PI * 2
      if (Math.abs(delta) < 0.05) continue

      const steps = Math.max(2, Math.ceil(Math.abs(delta) / (8 * (Math.PI / 180))))
      const via: Vec2[] = []
      for (let k = 1; k < steps; k++) {
        const bearing = a.bearing + (delta * k) / steps
        via.push({
          x: centre.x + Math.cos(bearing) * radius,
          y: centre.y + Math.sin(bearing) * radius,
        })
      }

      edges.push({
        id: `${centre.id}_ring${i}`,
        from: ringNodes[i]!,
        to: ringNodes[(i + 1) % arms.length]!,
        via,
        category: slowest.edge.category,
        speedLimit: limit,
        lanes: [generalLane(1, CIRCULATORY_WIDTH)],
        centreLine: 'none',
        circulatoryOf: centre.id,
      })
    }
  }

  return { nodes, edges }
}

/** True when this edge is part of a roundabout's circulatory carriageway. */
export function isCirculatory(edge: Edge): boolean {
  return edge.circulatoryOf !== undefined
}
