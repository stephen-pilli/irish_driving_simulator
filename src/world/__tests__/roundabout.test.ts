import { describe, expect, it } from 'vitest'
import {
  angleDelta,
  expandRoundabouts,
  isCirculatory,
  LaneGraph,
  sampleEdge,
  twoWay,
  type LaneGraphSpec,
} from '../laneGraph'
import { BALLYROAD } from '../town'

/** Three arms at due west, due south-east and due north-east. */
const SPEC: LaneGraphSpec = {
  nodes: [
    { id: 'c', x: 0, y: 0, junction: { radius: 18, control: { kind: 'roundabout' } } },
    { id: 'w', x: -200, y: 0 },
    { id: 'ne', x: 160, y: 160 },
    { id: 'se', x: 160, y: -160 },
  ],
  edges: [
    { id: 'arm_w', from: 'w', to: 'c', category: 'urban', lanes: twoWay() },
    { id: 'arm_ne', from: 'c', to: 'ne', category: 'urban', lanes: twoWay() },
    { id: 'arm_se', from: 'c', to: 'se', category: 'urbanCore', lanes: twoWay() },
  ],
}

describe('roundabout expansion', () => {
  it('leaves a graph without roundabouts alone', () => {
    const plain: LaneGraphSpec = {
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 100, y: 0 },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b', category: 'urban' }],
    }
    expect(expandRoundabouts(plain)).toBe(plain)
  })

  it('does not mutate the spec it is given', () => {
    const before = JSON.stringify(SPEC)
    expandRoundabouts(SPEC)
    expect(JSON.stringify(SPEC)).toBe(before)
  })

  it('builds one circulatory edge and one entry node per arm', () => {
    const out = expandRoundabouts(SPEC)
    const ring = out.edges.filter((e) => e.circulatoryOf === 'c')
    expect(ring).toHaveLength(3)

    const entries = out.nodes.filter((n) => n.id.startsWith('c_r'))
    expect(entries).toHaveLength(3)
    for (const entry of entries) {
      expect(Math.hypot(entry.x, entry.y)).toBeCloseTo(18, 5)
    }
  })

  it('leaves the centre as an island with no junction and no roads', () => {
    const graph = new LaneGraph(SPEC)
    const centre = graph.node('c')
    expect(centre.junction).toBeUndefined()
    expect(centre.island?.radius).toBeGreaterThan(10)
    expect(centre.edges).toHaveLength(0)
  })

  it('moves each arm onto the ring instead of into the middle', () => {
    const out = expandRoundabouts(SPEC)
    for (const arm of out.edges.filter((e) => !e.circulatoryOf)) {
      expect(arm.from === 'c' || arm.to === 'c').toBe(false)
    }
  })

  it('makes every entry give way to the circulating traffic', () => {
    const out = expandRoundabouts(SPEC)
    const armIds = new Set(['arm_w', 'arm_ne', 'arm_se'])
    const yielding = new Set<string>()

    for (const node of out.nodes.filter((n) => n.id.startsWith('c_r'))) {
      const control = node.junction?.control
      expect(control?.kind).toBe('yield')
      if (control?.kind === 'yield') for (const id of control.yieldEdges) yielding.add(id)
    }
    expect(yielding).toEqual(armIds)
  })

  it('circulates clockwise, as Irish roundabouts do', () => {
    const graph = new LaneGraph(SPEC)
    const ring = [...graph.edges.values()].filter(isCirculatory)
    expect(ring.length).toBeGreaterThan(0)

    for (const edge of ring) {
      // Walking along a clockwise ring, the bearing from the centre decreases.
      const a = sampleEdge(edge, edge.length * 0.2)
      const b = sampleEdge(edge, edge.length * 0.8)
      const centre = graph.node('c')
      const bearingA = Math.atan2(a.y - centre.y, a.x - centre.x)
      const bearingB = Math.atan2(b.y - centre.y, b.x - centre.x)
      expect(angleDelta(bearingA, bearingB)).toBeLessThan(0)
    }
  })

  it('makes the ring one-way', () => {
    const graph = new LaneGraph(SPEC)
    for (const edge of [...graph.edges.values()].filter(isCirculatory)) {
      expect(edge.lanes).toHaveLength(1)
      expect(edge.lanes[0]!.direction).toBe(1)
      expect(edge.centreLine).toBe('none')
    }
  })

  it('takes the lowest limit of the arms for the ring', () => {
    const graph = new LaneGraph(SPEC)
    const ring = [...graph.edges.values()].filter(isCirculatory)
    // arm_se is urbanCore (30); the others are urban (50).
    for (const edge of ring) expect(edge.speedLimit).toBe(30)
  })

  it('places the ring where a car driving it stays on the carriageway', () => {
    const graph = new LaneGraph(SPEC)
    const ring = [...graph.edges.values()].filter(isCirculatory)

    for (const edge of ring) {
      for (let s = edge.startTrim; s <= edge.length - edge.endTrim; s += 2) {
        const pose = sampleEdge(edge, s)
        const loc = graph.locate(pose.x, pose.y, pose.heading)
        expect(loc).not.toBeNull()
        expect(loc!.offRoad).toBe(false)
      }
    }
  })

  it('survives two roundabouts joined to each other', () => {
    const chain: LaneGraphSpec = {
      nodes: [
        { id: 'a', x: 0, y: 0, junction: { radius: 16, control: { kind: 'roundabout' } } },
        { id: 'b', x: 200, y: 0, junction: { radius: 16, control: { kind: 'roundabout' } } },
        { id: 'a_w', x: -160, y: 0 },
        { id: 'a_n', x: 0, y: 160 },
        { id: 'b_e', x: 360, y: 0 },
        { id: 'b_s', x: 200, y: -160 },
      ],
      edges: [
        { id: 'link', from: 'a', to: 'b', category: 'urban' },
        { id: 'aw', from: 'a_w', to: 'a', category: 'urban' },
        { id: 'an', from: 'a', to: 'a_n', category: 'urban' },
        { id: 'be', from: 'b', to: 'b_e', category: 'urban' },
        { id: 'bs', from: 'b', to: 'b_s', category: 'urban' },
      ],
    }
    const graph = new LaneGraph(chain)
    expect([...graph.edges.values()].filter((e) => e.circulatoryOf === 'a')).toHaveLength(3)
    expect([...graph.edges.values()].filter((e) => e.circulatoryOf === 'b')).toHaveLength(3)

    // The link road must have been moved onto both rings, not left joined to
    // either centre. Which entry index it lands on is an implementation
    // detail, so this checks the property rather than the generated id.
    const link = graph.edge('link')
    expect(link.from.startsWith('a_r')).toBe(true)
    expect(link.to.startsWith('b_r')).toBe(true)
    // 200 m apart, minus a 16 m radius bitten out of each end.
    expect(link.length).toBeCloseTo(168, 0)
  })

  it('refuses to ring a roundabout with only one arm', () => {
    const stub: LaneGraphSpec = {
      nodes: [
        { id: 'c', x: 0, y: 0, junction: { radius: 16, control: { kind: 'roundabout' } } },
        { id: 'a', x: 120, y: 0 },
      ],
      edges: [{ id: 'only', from: 'c', to: 'a', category: 'urban' }],
    }
    const graph = new LaneGraph(stub)
    expect([...graph.edges.values()].filter(isCirculatory)).toHaveLength(0)
    expect(graph.node('c').island).toBeUndefined()
  })

  it('gives Ballyroad a drivable roundabout', () => {
    const graph = new LaneGraph(BALLYROAD)
    const ring = [...graph.edges.values()].filter((e) => e.circulatoryOf === 'n_ne')
    expect(ring).toHaveLength(3)
    expect(graph.node('n_ne').island).toBeDefined()

    // Every arm still reaches the roundabout, by way of an entry node.
    for (const armId of ['north_link', 'north_east_link', 'ne_spur']) {
      const arm = graph.edge(armId)
      expect(arm.from.startsWith('n_ne_r') || arm.to.startsWith('n_ne_r')).toBe(true)
    }
  })
})
