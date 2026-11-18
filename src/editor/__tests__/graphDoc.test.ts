import { describe, expect, it } from 'vitest'
import { LaneGraph } from '../../world/laneGraph'
import { BALLYROAD } from '../../world/town'
import { GraphDoc } from '../graphDoc'
import { fromJson, toJson, toTypeScript } from '../serialise'

const doc = (): GraphDoc => new GraphDoc(BALLYROAD)

describe('editing', () => {
  it('does not mutate the source town', () => {
    // Counted relative to the town rather than against a literal, so adding a
    // road to Ballyroad does not look like an editing bug.
    const before = BALLYROAD.nodes.length
    const d = doc()
    d.addNode(10, 10)
    expect(BALLYROAD.nodes).toHaveLength(before)
    expect(d.nodes).toHaveLength(before + 1)
  })

  it('adds nodes with unique ids', () => {
    const d = doc()
    const a = d.addNode(10, 10)
    const b = d.addNode(20, 20)
    expect(a).not.toBe(b)
    expect(d.node(a)).toBeDefined()
  })

  it('refuses a duplicate or self-referential road', () => {
    const d = doc()
    expect(d.addEdge('n_west', 'n_west')).toBeNull()
    expect(d.addEdge('n_west', 'n_cross')).toBeNull() // main_w already joins these
    expect(d.addEdge('n_west', 'n_north')).not.toBeNull()
  })

  it('deletes the roads attached to a deleted node', () => {
    const d = doc()
    const before = d.edges.length
    const attached = d.edgesAt('n_cross').length
    d.deleteNode('n_cross')
    expect(d.node('n_cross')).toBeUndefined()
    expect(d.edges).toHaveLength(before - attached)
  })
})

describe('referential integrity', () => {
  it('scrubs a deleted road from the junction controls that named it', () => {
    const d = doc()
    d.deleteEdge('town_south')

    const south = d.node('n_south')!
    const control = south.junction!.control
    expect(control.kind).toBe('stop')
    if (control.kind === 'stop') expect(control.stopEdges).not.toContain('town_south')

    // It was also one of the signal groups at the crossroads.
    const cross = d.node('n_cross')!
    const signals = cross.junction!.control
    if (signals.kind === 'signals') {
      expect(signals.groups.flat()).not.toContain('town_south')
    }
    expect(d.problems()).toEqual([])
  })

  it('downgrades signals that lose too many groups to alternate', () => {
    const d = doc()
    d.deleteEdge('residential')
    d.deleteEdge('town_south')

    const cross = d.node('n_cross')!
    expect(cross.junction!.control.kind).toBe('uncontrolled')
    expect(d.problems()).toEqual([])
  })

  it('reports a junction controlling a road that does not exist', () => {
    const d = doc()
    d.updateNode('n_east', {
      junction: { radius: 11, control: { kind: 'yield', yieldEdges: ['ghost_road'] } },
    })
    expect(d.problems().some((p) => p.includes('ghost_road'))).toBe(true)
  })

  it('reports a node left unattached', () => {
    const d = doc()
    d.addNode(900, 900)
    expect(d.problems().some((p) => p.includes('not joined'))).toBe(true)
  })

  it('stays loadable by the simulation after edits', () => {
    const d = doc()
    const node = d.addNode(-320, 240)
    d.addEdge('n_west', node)
    d.deleteEdge('rural')

    expect(d.problems()).toEqual([])
    const graph = new LaneGraph(d.toSpec())
    expect(graph.edges.has('rural')).toBe(false)
    expect(graph.nodes.has(node)).toBe(true)
  })
})

describe('undo', () => {
  it('reverses the last change', () => {
    const d = doc()
    const before = d.nodes.length
    d.addNode(5, 5)
    expect(d.nodes).toHaveLength(before + 1)
    expect(d.undo()).toBe(true)
    expect(d.nodes).toHaveLength(before)
  })

  it('treats a drag as a single change', () => {
    const d = doc()
    const start = d.node('n_north')!.y

    d.beginChange()
    for (let i = 1; i <= 20; i++) d.moveNode('n_north', 0, start + i)
    d.commit()

    expect(d.node('n_north')!.y).toBe(start + 20)
    d.undo()
    expect(d.node('n_north')!.y).toBe(start)
  })

  it('does not record a change that altered nothing', () => {
    const d = doc()
    d.beginChange()
    d.commit()
    expect(d.canUndo).toBe(false)
  })

  it('redoes an undone change, and drops the redo once something new happens', () => {
    const d = doc()
    d.addNode(5, 5)
    d.undo()
    expect(d.canRedo).toBe(true)
    expect(d.redo()).toBe(true)
    expect(d.canRedo).toBe(false)

    d.undo()
    d.addNode(9, 9)
    expect(d.canRedo).toBe(false)
  })
})

describe('export', () => {
  it('round-trips through JSON', () => {
    const d = doc()
    d.addNode(123, -45)
    const restored = fromJson(toJson(d.toSpec()))
    expect(restored.nodes).toHaveLength(d.nodes.length)
    expect(() => new LaneGraph(restored)).not.toThrow()
  })

  it('rejects input that is not a graph', () => {
    expect(() => fromJson('nonsense')).toThrow('Not valid JSON')
    expect(() => fromJson('{"nodes":[]}')).toThrow('nodes')
    expect(() => fromJson('{"nodes":[{"id":"a"}],"edges":[]}')).toThrow('numeric')
  })

  it('emits TypeScript in the shape of the hand-written town', () => {
    const source = toTypeScript(doc().toSpec(), 'BALLYROAD')
    expect(source).toContain("export const BALLYROAD: LaneGraphSpec = {")
    expect(source).toContain("import { twoWay, type LaneGraphSpec } from './laneGraph'")
    expect(source).toContain("id: 'main_e'")
    expect(source).toContain("kind: 'signals'")
    expect(source).toContain('lanes: twoWay(),')
    // Non-default widths keep their argument.
    expect(source).toContain('twoWay(3.2)')
  })
})
