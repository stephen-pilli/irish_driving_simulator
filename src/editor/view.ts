import { smoothPolyline, type Point2 } from '../core/spline'
import {
  DEFAULT_SPEED_LIMITS,
  type EdgeId,
  type EdgeSpec,
  type RoadCategory,
  type Vec2,
} from '../world/laneGraph'
import type { GraphDoc, Selection } from './graphDoc'

export interface CarPose {
  x: number
  y: number
  heading: number
}

/** Hit radii, in screen pixels. */
const HIT_VIA = 8
const HIT_NODE = 11
const HIT_EDGE = 9

/** Roads are coloured by speed limit — the thing that most changes how one drives. */
const LIMIT_COLOURS: Array<[number, string]> = [
  [30, '#7fc8a9'],
  [50, '#6aa8ff'],
  [60, '#b79cff'],
  [80, '#ffb45e'],
  [100, '#ff8a5e'],
  [120, '#ff6b6b'],
]

function limitColour(limit: number): string {
  for (const [threshold, colour] of LIMIT_COLOURS) {
    if (limit <= threshold) return colour
  }
  return '#ff6b6b'
}

const edgeLimit = (edge: EdgeSpec): number =>
  edge.speedLimit ?? DEFAULT_SPEED_LIMITS[edge.category as RoadCategory] ?? 50

const laneWidth = (edge: EdgeSpec): number =>
  edge.lanes ? edge.lanes.reduce((sum, l) => sum + l.width, 0) : 7

function distanceToSegment(p: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  const t = lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/**
 * Top-down plan view of the lane graph. A plan is the right way to edit a road
 * network: the 3D view is for judging what it is like to drive, the plan is for
 * judging how it connects.
 */
export class PlanView {
  x = 0
  y = 0
  zoom = 0.55
  private width = 0
  private height = 0
  /** Smoothed centre lines from the last draw, reused for hit testing. */
  private paths = new Map<EdgeId, Point2[]>()

  constructor(private readonly canvas: HTMLCanvasElement) {}

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio, 2)
    this.width = this.canvas.clientWidth
    this.height = this.canvas.clientHeight
    this.canvas.width = Math.round(this.width * dpr)
    this.canvas.height = Math.round(this.height * dpr)
  }

  toScreen(wx: number, wy: number): Point2 {
    return {
      x: (wx - this.x) * this.zoom + this.width / 2,
      y: -(wy - this.y) * this.zoom + this.height / 2,
    }
  }

  toWorld(sx: number, sy: number): Vec2 {
    return {
      x: (sx - this.width / 2) / this.zoom + this.x,
      y: -(sy - this.height / 2) / this.zoom + this.y,
    }
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy)
    this.zoom = Math.max(0.08, Math.min(6, this.zoom * factor))
    const after = this.toWorld(sx, sy)
    this.x += before.x - after.x
    this.y += before.y - after.y
  }

  /** Fit the whole network on screen. */
  frameAll(doc: GraphDoc): void {
    if (doc.nodes.length === 0) return
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const n of doc.nodes) {
      minX = Math.min(minX, n.x)
      maxX = Math.max(maxX, n.x)
      minY = Math.min(minY, n.y)
      maxY = Math.max(maxY, n.y)
    }
    this.x = (minX + maxX) / 2
    this.y = (minY + maxY) / 2
    const margin = 90
    this.zoom = Math.min(
      (this.width - margin) / Math.max(maxX - minX, 1),
      (this.height - margin) / Math.max(maxY - minY, 1),
    )
    this.zoom = Math.max(0.08, Math.min(6, this.zoom))
  }

  /**
   * Recompute the centre lines used for drawing and hit testing.
   *
   * Hit testing must not depend on draw() having run first: before the first
   * paint — or in a throttled background tab, where rAF may not fire at all —
   * the cache would be empty and every click would silently miss the roads.
   * Rebuilding costs a few hundred microseconds, so it is done on demand.
   */
  private rebuildPaths(doc: GraphDoc): void {
    this.paths.clear()
    for (const edge of doc.edges) {
      const path = this.pathFor(doc, edge)
      if (path) this.paths.set(edge.id, path)
    }
  }

  private pathFor(doc: GraphDoc, edge: EdgeSpec): Point2[] | null {
    const from = doc.node(edge.from)
    const to = doc.node(edge.to)
    if (!from || !to) return null
    const control: Point2[] = [{ x: from.x, y: from.y }, ...(edge.via ?? []), { x: to.x, y: to.y }]
    return control.length > 2 ? smoothPolyline(control, 6) : control
  }

  draw(doc: GraphDoc, selection: Selection, car: CarPose | null, linkFrom: string | null): void {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio, 2)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)
    ctx.fillStyle = '#0d1016'
    ctx.fillRect(0, 0, this.width, this.height)

    this.drawGrid(ctx)
    this.rebuildPaths(doc)

    // Carriageways
    for (const edge of doc.edges) {
      const path = this.paths.get(edge.id)
      if (!path) continue

      const selected = selection.kind === 'edge' && selection.id === edge.id
      const colour = limitColour(edgeLimit(edge))

      ctx.beginPath()
      path.forEach((p, i) => {
        const s = this.toScreen(p.x, p.y)
        if (i === 0) ctx.moveTo(s.x, s.y)
        else ctx.lineTo(s.x, s.y)
      })

      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = selected ? '#ffffff' : 'rgba(255,255,255,0.14)'
      ctx.lineWidth = Math.max(3, laneWidth(edge) * this.zoom) + (selected ? 5 : 2)
      ctx.stroke()

      ctx.strokeStyle = colour
      ctx.lineWidth = Math.max(2, laneWidth(edge) * this.zoom)
      ctx.stroke()

      // A continuous centre line is drawn solid, a broken one dashed.
      if (edge.centreLine === 'continuous' || edge.centreLine === 'doubleContinuous') {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'
        ctx.lineWidth = Math.max(1, 0.3 * this.zoom)
        ctx.setLineDash([])
        ctx.stroke()
      } else if (edge.centreLine !== 'none') {
        ctx.strokeStyle = 'rgba(255,255,255,0.45)'
        ctx.lineWidth = Math.max(1, 0.25 * this.zoom)
        ctx.setLineDash([6, 8])
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    // Shape points of the selected road
    if (selection.kind === 'edge' || selection.kind === 'via') {
      const edge = doc.edge(selection.id)
      edge?.via?.forEach((p, index) => {
        const s = this.toScreen(p.x, p.y)
        const active = selection.kind === 'via' && selection.index === index
        ctx.fillStyle = active ? '#ffffff' : '#6aa8ff'
        ctx.fillRect(s.x - 4, s.y - 4, 8, 8)
      })
    }

    this.drawNodes(ctx, doc, selection, linkFrom)
    if (car) this.drawCar(ctx, car)
    this.drawScaleBar(ctx)
  }

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const spacing = this.zoom > 1.6 ? 10 : this.zoom > 0.5 ? 50 : 250
    const topLeft = this.toWorld(0, 0)
    const bottomRight = this.toWorld(this.width, this.height)

    ctx.lineWidth = 1
    for (let x = Math.floor(topLeft.x / spacing) * spacing; x < bottomRight.x; x += spacing) {
      const s = this.toScreen(x, 0)
      ctx.strokeStyle = x === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)'
      ctx.beginPath()
      ctx.moveTo(s.x, 0)
      ctx.lineTo(s.x, this.height)
      ctx.stroke()
    }
    for (let y = Math.floor(bottomRight.y / spacing) * spacing; y < topLeft.y; y += spacing) {
      const s = this.toScreen(0, y)
      ctx.strokeStyle = y === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)'
      ctx.beginPath()
      ctx.moveTo(0, s.y)
      ctx.lineTo(this.width, s.y)
      ctx.stroke()
    }
  }

  private drawNodes(
    ctx: CanvasRenderingContext2D,
    doc: GraphDoc,
    selection: Selection,
    linkFrom: string | null,
  ): void {
    ctx.font = '600 10px -apple-system, Segoe UI, Roboto, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    for (const node of doc.nodes) {
      const s = this.toScreen(node.x, node.y)
      const selected = selection.kind === 'node' && selection.id === node.id
      const control = node.junction?.control

      if (node.junction) {
        ctx.beginPath()
        ctx.arc(s.x, s.y, node.junction.radius * this.zoom, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(255,255,255,0.22)'
        ctx.lineWidth = 1
        ctx.stroke()
      }

      let fill = '#8b98a8'
      let glyph = ''
      if (control?.kind === 'signals') {
        fill = '#24d05a'
        glyph = 'S'
      } else if (control?.kind === 'stop') {
        fill = '#ff4d4d'
        glyph = 'H'
      } else if (control?.kind === 'yield') {
        fill = '#ffb43d'
        glyph = 'Y'
      }

      ctx.beginPath()
      ctx.arc(s.x, s.y, selected ? 9 : 7, 0, Math.PI * 2)
      ctx.fillStyle = fill
      ctx.fill()
      if (selected || linkFrom === node.id) {
        ctx.strokeStyle = linkFrom === node.id ? '#ffd166' : '#ffffff'
        ctx.lineWidth = 2.5
        ctx.stroke()
      }

      if (glyph) {
        ctx.fillStyle = '#0d1016'
        ctx.fillText(glyph, s.x, s.y + 0.5)
      }

      if (this.zoom > 0.35) {
        ctx.fillStyle = 'rgba(233,238,245,0.55)'
        ctx.fillText(node.id, s.x, s.y - 15)
      }
    }
  }

  private drawCar(ctx: CanvasRenderingContext2D, car: CarPose): void {
    const s = this.toScreen(car.x, car.y)
    ctx.save()
    ctx.translate(s.x, s.y)
    ctx.rotate(-car.heading)
    ctx.beginPath()
    ctx.moveTo(9, 0)
    ctx.lineTo(-6, 5)
    ctx.lineTo(-6, -5)
    ctx.closePath()
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.restore()
  }

  private drawScaleBar(ctx: CanvasRenderingContext2D): void {
    const metres = this.zoom > 1.6 ? 20 : this.zoom > 0.5 ? 100 : 500
    const px = metres * this.zoom
    const x = 18
    const y = this.height - 22
    ctx.strokeStyle = 'rgba(233,238,245,0.7)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + px, y)
    ctx.moveTo(x, y - 4)
    ctx.lineTo(x, y + 4)
    ctx.moveTo(x + px, y - 4)
    ctx.lineTo(x + px, y + 4)
    ctx.stroke()
    ctx.fillStyle = 'rgba(233,238,245,0.7)'
    ctx.textAlign = 'left'
    ctx.font = '11px -apple-system, Segoe UI, Roboto, sans-serif'
    ctx.fillText(`${metres} m`, x + px + 8, y)
  }

  /** What is under the cursor? Handles beat nodes, nodes beat roads. */
  hitTest(doc: GraphDoc, sx: number, sy: number, selection: Selection): Selection {
    this.rebuildPaths(doc)

    if (selection.kind === 'edge' || selection.kind === 'via') {
      const edge = doc.edge(selection.id)
      const via = edge?.via ?? []
      for (let i = 0; i < via.length; i++) {
        const s = this.toScreen(via[i]!.x, via[i]!.y)
        if (Math.hypot(s.x - sx, s.y - sy) <= HIT_VIA) {
          return { kind: 'via', id: selection.id, index: i }
        }
      }
    }

    for (const node of doc.nodes) {
      const s = this.toScreen(node.x, node.y)
      if (Math.hypot(s.x - sx, s.y - sy) <= HIT_NODE) return { kind: 'node', id: node.id }
    }

    for (const [edgeId, path] of this.paths) {
      for (let i = 0; i < path.length - 1; i++) {
        const a = this.toScreen(path[i]!.x, path[i]!.y)
        const b = this.toScreen(path[i + 1]!.x, path[i + 1]!.y)
        if (distanceToSegment({ x: sx, y: sy }, a, b) <= HIT_EDGE) {
          return { kind: 'edge', id: edgeId }
        }
      }
    }

    return { kind: 'none' }
  }

  /**
   * Which gap between shape points is nearest, so a new one is inserted in the
   * right place rather than always at the end.
   */
  insertionIndex(doc: GraphDoc, edgeId: EdgeId, world: Vec2): number {
    const edge = doc.edge(edgeId)
    if (!edge) return 0
    const from = doc.node(edge.from)
    const to = doc.node(edge.to)
    if (!from || !to) return 0

    const control: Point2[] = [{ x: from.x, y: from.y }, ...(edge.via ?? []), { x: to.x, y: to.y }]
    let best = 0
    let bestDistance = Infinity
    for (let i = 0; i < control.length - 1; i++) {
      const d = distanceToSegment(world, control[i]!, control[i + 1]!)
      if (d < bestDistance) {
        bestDistance = d
        best = i
      }
    }
    return best
  }
}
