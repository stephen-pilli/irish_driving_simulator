import type { EdgeId, JunctionControl, LaneGraph, NodeId } from './laneGraph'

/**
 * Irish traffic light sequence: green, amber, red, red+amber, green. The
 * red+amber phase matters for the rules engine — it means "prepare to go", not
 * "go", so moving off during it is a fault.
 */
export type SignalAspect = 'red' | 'redAmber' | 'amber' | 'green'

/** All-red clearance before the next group is released. */
const ALL_RED_SECONDS = 1.5
/** Red+amber shown to the next group before it goes green. */
const RED_AMBER_SECONDS = 2

interface SignalGroup {
  edges: EdgeId[]
}

export class SignalController {
  readonly nodeId: NodeId
  private readonly groups: SignalGroup[]
  private readonly greenSeconds: number
  private readonly amberSeconds: number
  private readonly groupSeconds: number
  private time = 0

  constructor(
    nodeId: NodeId,
    groups: EdgeId[][],
    greenSeconds: number,
    amberSeconds: number,
    offsetSeconds = 0,
  ) {
    this.nodeId = nodeId
    this.groups = groups.map((edges) => ({ edges }))
    this.greenSeconds = greenSeconds
    this.amberSeconds = amberSeconds
    this.groupSeconds = greenSeconds + amberSeconds + ALL_RED_SECONDS + RED_AMBER_SECONDS
    this.time = offsetSeconds
  }

  get cycleSeconds(): number {
    return this.groupSeconds * this.groups.length
  }

  /**
   * Where the controller is in its cycle. A replay has to put every set of
   * lights back exactly where it was, or a drive that crossed on green the
   * first time can cross on red the second and the replay stops being evidence
   * of anything.
   */
  get phaseSeconds(): number {
    return this.time
  }

  setPhaseSeconds(t: number): void {
    this.time = ((t % this.cycleSeconds) + this.cycleSeconds) % this.cycleSeconds
  }

  update(dt: number): void {
    this.time = (this.time + dt) % this.cycleSeconds
  }

  /** Seconds into the current group's slot, and which group holds it. */
  private phase(): { index: number; t: number } {
    const index = Math.floor(this.time / this.groupSeconds) % this.groups.length
    return { index, t: this.time - index * this.groupSeconds }
  }

  aspectFor(edgeId: EdgeId): SignalAspect {
    const { index, t } = this.phase()
    const active = this.groups[index]
    if (active?.edges.includes(edgeId)) {
      if (t < this.greenSeconds) return 'green'
      if (t < this.greenSeconds + this.amberSeconds) return 'amber'
      return 'red'
    }

    // The group released next shows red+amber during the final run-up.
    const next = this.groups[(index + 1) % this.groups.length]
    if (next?.edges.includes(edgeId) && t >= this.groupSeconds - RED_AMBER_SECONDS) {
      return 'redAmber'
    }
    return 'red'
  }

  /** Seconds until this edge's signal next changes. Useful for traffic AI. */
  secondsToChange(edgeId: EdgeId): number {
    const current = this.aspectFor(edgeId)
    for (let ahead = 0.1; ahead < this.cycleSeconds; ahead += 0.1) {
      const saved = this.time
      this.time = (this.time + ahead) % this.cycleSeconds
      const aspect = this.aspectFor(edgeId)
      this.time = saved
      if (aspect !== current) return ahead
    }
    return this.cycleSeconds
  }
}

/** Build a controller for every signalised junction in the graph. */
export function createSignals(graph: LaneGraph): Map<NodeId, SignalController> {
  const out = new Map<NodeId, SignalController>()
  for (const node of graph.nodes.values()) {
    const control: JunctionControl | undefined = node.junction?.control
    if (control?.kind !== 'signals') continue
    out.set(
      node.id,
      new SignalController(node.id, control.groups, control.greenSeconds, control.amberSeconds),
    )
  }
  return out
}
