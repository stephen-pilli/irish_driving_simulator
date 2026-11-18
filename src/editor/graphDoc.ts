import type {
  EdgeId,
  EdgeSpec,
  JunctionControl,
  LaneGraphSpec,
  NodeId,
  NodeSpec,
  Vec2,
} from '../world/laneGraph'

export type Selection =
  | { kind: 'none' }
  | { kind: 'node'; id: NodeId }
  | { kind: 'edge'; id: EdgeId }
  | { kind: 'via'; id: EdgeId; index: number }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * A mutable, undoable lane graph.
 *
 * Deliberately separate from both the renderer and the LaneGraph used by the
 * simulation: this is the authoring document, and it can hold states the
 * simulation would reject (a dangling edge mid-drag, for instance). It is
 * compiled into a LaneGraph only when it is valid.
 */
export class GraphDoc {
  private spec: LaneGraphSpec
  private readonly undoStack: string[] = []
  private readonly redoStack: string[] = []
  private pendingSnapshot: string | null = null

  constructor(initial: LaneGraphSpec) {
    this.spec = clone(initial)
  }

  get nodes(): NodeSpec[] {
    return this.spec.nodes
  }

  get edges(): EdgeSpec[] {
    return this.spec.edges
  }

  toSpec(): LaneGraphSpec {
    return clone(this.spec)
  }

  load(spec: LaneGraphSpec): void {
    this.commit()
    this.spec = clone(spec)
  }

  node(id: NodeId): NodeSpec | undefined {
    return this.spec.nodes.find((n) => n.id === id)
  }

  edge(id: EdgeId): EdgeSpec | undefined {
    return this.spec.edges.find((e) => e.id === id)
  }

  // --- Undo -------------------------------------------------------------

  /**
   * Record the state before a change. Dragging calls this once at the start of
   * the gesture rather than on every mouse move, so one drag is one undo.
   */
  beginChange(): void {
    if (this.pendingSnapshot === null) this.pendingSnapshot = JSON.stringify(this.spec)
  }

  /** Close the current change, pushing it onto the undo stack if it altered anything. */
  commit(): void {
    if (this.pendingSnapshot === null) return
    if (this.pendingSnapshot !== JSON.stringify(this.spec)) {
      this.undoStack.push(this.pendingSnapshot)
      this.redoStack.length = 0
      if (this.undoStack.length > 100) this.undoStack.shift()
    }
    this.pendingSnapshot = null
  }

  private change<T>(fn: () => T): T {
    this.beginChange()
    const result = fn()
    this.commit()
    return result
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  undo(): boolean {
    this.commit()
    const previous = this.undoStack.pop()
    if (previous === undefined) return false
    this.redoStack.push(JSON.stringify(this.spec))
    this.spec = JSON.parse(previous) as LaneGraphSpec
    return true
  }

  redo(): boolean {
    const next = this.redoStack.pop()
    if (next === undefined) return false
    this.undoStack.push(JSON.stringify(this.spec))
    this.spec = JSON.parse(next) as LaneGraphSpec
    return true
  }

  // --- Identifiers ------------------------------------------------------

  private freshId(prefix: string, taken: Set<string>): string {
    for (let i = 1; ; i++) {
      const id = `${prefix}${i}`
      if (!taken.has(id)) return id
    }
  }

  // --- Nodes ------------------------------------------------------------

  addNode(x: number, y: number): NodeId {
    return this.change(() => {
      const id = this.freshId('n_', new Set(this.spec.nodes.map((n) => n.id)))
      this.spec.nodes.push({ id, x: Math.round(x), y: Math.round(y) })
      return id
    })
  }

  moveNode(id: NodeId, x: number, y: number): void {
    const node = this.node(id)
    if (!node) return
    node.x = Math.round(x)
    node.y = Math.round(y)
  }

  updateNode(id: NodeId, patch: Partial<Omit<NodeSpec, 'id'>>): void {
    this.change(() => {
      const node = this.node(id)
      if (node) Object.assign(node, patch)
    })
  }

  /** Turn a junction back into a plain bend in the road. */
  clearJunction(id: NodeId): void {
    this.change(() => {
      const node = this.node(id)
      if (node) delete node.junction
    })
  }

  /** Remove a node and every edge touching it. */
  deleteNode(id: NodeId): void {
    this.change(() => {
      const doomed = this.spec.edges.filter((e) => e.from === id || e.to === id).map((e) => e.id)
      this.spec.nodes = this.spec.nodes.filter((n) => n.id !== id)
      this.spec.edges = this.spec.edges.filter((e) => !doomed.includes(e.id))
      for (const edgeId of doomed) this.forgetEdgeReferences(edgeId)
    })
  }

  // --- Edges ------------------------------------------------------------

  addEdge(from: NodeId, to: NodeId): EdgeId | null {
    if (from === to) return null
    if (!this.node(from) || !this.node(to)) return null
    const duplicate = this.spec.edges.some(
      (e) => (e.from === from && e.to === to) || (e.from === to && e.to === from),
    )
    if (duplicate) return null

    return this.change(() => {
      const id = this.freshId('e_', new Set(this.spec.edges.map((e) => e.id)))
      this.spec.edges.push({ id, from, to, category: 'urban', centreLine: 'broken' })
      return id
    })
  }

  updateEdge(id: EdgeId, patch: Partial<Omit<EdgeSpec, 'id' | 'from' | 'to'>>): void {
    this.change(() => {
      const edge = this.edge(id)
      if (edge) Object.assign(edge, patch)
    })
  }

  /** Drop an explicit limit so the road falls back to its category default. */
  clearSpeedLimit(id: EdgeId): void {
    this.change(() => {
      const edge = this.edge(id)
      if (edge) delete edge.speedLimit
    })
  }

  deleteEdge(id: EdgeId): void {
    this.change(() => {
      this.spec.edges = this.spec.edges.filter((e) => e.id !== id)
      this.forgetEdgeReferences(id)
    })
  }

  /**
   * Junction controls name the edges they govern, so deleting an edge has to
   * scrub it from every control that mentions it. Left behind, a stale name
   * silently disables a stop line or strands a signal group with no approach,
   * and nothing would flag it until someone drove through the junction.
   */
  private forgetEdgeReferences(edgeId: EdgeId): void {
    for (const node of this.spec.nodes) {
      const control = node.junction?.control
      if (!control) continue

      if (control.kind === 'yield') {
        control.yieldEdges = control.yieldEdges.filter((e) => e !== edgeId)
      } else if (control.kind === 'stop') {
        control.stopEdges = control.stopEdges.filter((e) => e !== edgeId)
      } else if (control.kind === 'signals') {
        control.groups = control.groups
          .map((group) => group.filter((e) => e !== edgeId))
          .filter((group) => group.length > 0)
        // A signalised junction needs at least two groups to alternate between.
        if (control.groups.length < 2 && node.junction) {
          node.junction.control = { kind: 'uncontrolled' }
        }
      }
    }
  }

  // --- Shape points -----------------------------------------------------

  addVia(edgeId: EdgeId, index: number, point: Vec2): void {
    this.change(() => {
      const edge = this.edge(edgeId)
      if (!edge) return
      const via = edge.via ?? []
      via.splice(Math.max(0, Math.min(via.length, index)), 0, {
        x: Math.round(point.x),
        y: Math.round(point.y),
      })
      edge.via = via
    })
  }

  moveVia(edgeId: EdgeId, index: number, point: Vec2): void {
    const edge = this.edge(edgeId)
    const via = edge?.via?.[index]
    if (!via) return
    via.x = Math.round(point.x)
    via.y = Math.round(point.y)
  }

  deleteVia(edgeId: EdgeId, index: number): void {
    this.change(() => {
      const edge = this.edge(edgeId)
      if (!edge?.via) return
      edge.via.splice(index, 1)
      if (edge.via.length === 0) delete edge.via
    })
  }

  // --- Validation -------------------------------------------------------

  /**
   * Problems that would make the graph undrivable. Reported in the panel
   * rather than thrown, so a half-finished layout can still be worked on.
   */
  problems(): string[] {
    const issues: string[] = []
    const nodeIds = new Set(this.spec.nodes.map((n) => n.id))
    const edgeIds = new Set(this.spec.edges.map((e) => e.id))
    const connected = new Set<NodeId>()

    for (const edge of this.spec.edges) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        issues.push(`${edge.id}: joins a node that no longer exists`)
      }
      connected.add(edge.from)
      connected.add(edge.to)
    }

    for (const node of this.spec.nodes) {
      if (!connected.has(node.id)) issues.push(`${node.id}: not joined to any road`)

      const control = node.junction?.control
      if (!control) continue
      const named =
        control.kind === 'yield'
          ? control.yieldEdges
          : control.kind === 'stop'
            ? control.stopEdges
            : control.kind === 'signals'
              ? control.groups.flat()
              : []
      for (const id of named) {
        if (!edgeIds.has(id)) issues.push(`${node.id}: controls unknown road ${id}`)
      }
      if (control.kind === 'signals' && control.groups.length < 2) {
        issues.push(`${node.id}: signals need at least two groups`)
      }
    }

    return issues
  }

  /** Edges touching a node, for building junction controls in the panel. */
  edgesAt(nodeId: NodeId): EdgeSpec[] {
    return this.spec.edges.filter((e) => e.from === nodeId || e.to === nodeId)
  }
}

export const DEFAULT_JUNCTION_CONTROL: Record<string, JunctionControl> = {
  uncontrolled: { kind: 'uncontrolled' },
  yield: { kind: 'yield', yieldEdges: [] },
  stop: { kind: 'stop', stopEdges: [] },
  signals: { kind: 'signals', groups: [], greenSeconds: 14, amberSeconds: 3 },
}
