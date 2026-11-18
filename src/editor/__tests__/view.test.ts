import { describe, expect, it } from 'vitest'
import { BALLYROAD } from '../../world/town'
import { GraphDoc } from '../graphDoc'
import { PlanView } from '../view'

/**
 * The plan view is constructed with a canvas it never touches outside draw()
 * and resize(), so hit testing can be exercised with no DOM at all.
 */
function view(): PlanView {
  const v = new PlanView({} as HTMLCanvasElement)
  v.x = 0
  v.y = 0
  v.zoom = 1
  return v
}

describe('hit testing', () => {
  it('finds a road without the view ever having been drawn', () => {
    // Regression: hit testing used to rely on draw() to populate its path
    // cache, so the first click after opening the editor — and every click in
    // a throttled background tab — silently missed every road.
    const v = view()
    const doc = new GraphDoc(BALLYROAD)
    const point = v.toScreen(150, 0) // midway along the main street

    expect(v.hitTest(doc, point.x, point.y, { kind: 'none' })).toEqual({
      kind: 'edge',
      id: 'main_e',
    })
  })

  it('finds a junction, and prefers it to the roads meeting there', () => {
    const v = view()
    const doc = new GraphDoc(BALLYROAD)
    const point = v.toScreen(0, 0) // the signalised crossroads

    expect(v.hitTest(doc, point.x, point.y, { kind: 'none' })).toEqual({
      kind: 'node',
      id: 'n_cross',
    })
  })

  it('finds a road created a moment ago', () => {
    const v = view()
    const doc = new GraphDoc(BALLYROAD)
    const node = doc.addNode(-150, 150)
    const edgeId = doc.addEdge(node, 'n_north')!

    const point = v.toScreen(-75, 195)
    expect(v.hitTest(doc, point.x, point.y, { kind: 'none' })).toEqual({
      kind: 'edge',
      id: edgeId,
    })
  })

  it('returns nothing for empty ground', () => {
    const v = view()
    const doc = new GraphDoc(BALLYROAD)
    const point = v.toScreen(-900, 900)
    expect(v.hitTest(doc, point.x, point.y, { kind: 'none' })).toEqual({ kind: 'none' })
  })

  it('follows a bent road around its curve', () => {
    const v = view()
    const doc = new GraphDoc(BALLYROAD)
    // A point on the curve of the rural road, away from its straight chord.
    const point = v.toScreen(474, -88)
    expect(v.hitTest(doc, point.x, point.y, { kind: 'none' })).toEqual({
      kind: 'edge',
      id: 'rural',
    })
  })
})

describe('bend insertion', () => {
  it('inserts a new bend into the nearest span, not at the end', () => {
    const v = view()
    const doc = new GraphDoc(BALLYROAD)
    // 'rural' already has three shape points; a click near the first span
    // should insert before them rather than after.
    expect(v.insertionIndex(doc, 'rural', { x: 350, y: -6 })).toBe(0)
    expect(v.insertionIndex(doc, 'rural', { x: 516, y: -180 })).toBe(3)
  })
})

describe('camera', () => {
  it('keeps the point under the cursor fixed while zooming', () => {
    const v = view()
    const screen = { x: 120, y: -80 }
    const before = v.toWorld(screen.x, screen.y)
    v.zoomAt(screen.x, screen.y, 1.8)
    const after = v.toWorld(screen.x, screen.y)

    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('round-trips between world and screen coordinates', () => {
    const v = view()
    v.zoomAt(0, 0, 0.6)
    const world = { x: -312.5, y: 184.25 }
    const screen = v.toScreen(world.x, world.y)
    const back = v.toWorld(screen.x, screen.y)

    expect(back.x).toBeCloseTo(world.x, 6)
    expect(back.y).toBeCloseTo(world.y, 6)
  })
})
