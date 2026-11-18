import type { EdgeSpec, Lane, LaneGraphSpec, NodeSpec } from '../world/laneGraph'

const q = (s: string): string => `'${s.replace(/'/g, "\\'")}'`
const num = (n: number): string => String(Math.round(n * 1000) / 1000)

/** Recognise the common lane patterns so the output reads like hand-written code. */
function lanesExpression(lanes: Lane[] | undefined): string | null {
  if (!lanes) return null
  const isTwoWay =
    lanes.length === 2 &&
    lanes[0]!.direction === 1 &&
    lanes[1]!.direction === -1 &&
    lanes[0]!.kind === 'general' &&
    lanes[1]!.kind === 'general' &&
    lanes[0]!.width === lanes[1]!.width
  if (isTwoWay) {
    const width = lanes[0]!.width
    return width === 3.5 ? 'twoWay()' : `twoWay(${num(width)})`
  }
  const parts = lanes.map(
    (l) => `{ direction: ${l.direction}, width: ${num(l.width)}, kind: ${q(l.kind)} }`,
  )
  return `[${parts.join(', ')}]`
}

function nodeSource(node: NodeSpec): string {
  const parts = [`id: ${q(node.id)}`, `x: ${num(node.x)}`, `y: ${num(node.y)}`]
  if (node.junction) {
    const c = node.junction.control
    let control: string
    switch (c.kind) {
      case 'yield':
        control = `{ kind: 'yield', yieldEdges: [${c.yieldEdges.map(q).join(', ')}] }`
        break
      case 'stop':
        control = `{ kind: 'stop', stopEdges: [${c.stopEdges.map(q).join(', ')}] }`
        break
      case 'signals': {
        const groups = c.groups.map((g) => `[${g.map(q).join(', ')}]`).join(', ')
        control =
          `{\n          kind: 'signals',\n` +
          `          groups: [${groups}],\n` +
          `          greenSeconds: ${num(c.greenSeconds)},\n` +
          `          amberSeconds: ${num(c.amberSeconds)},\n        }`
        break
      }
      default:
        control = `{ kind: 'uncontrolled' }`
    }
    parts.push(`junction: {\n        radius: ${num(node.junction.radius)},\n        control: ${control},\n      }`)
  }
  return `    { ${parts.join(', ')} },`
}

function edgeSource(edge: EdgeSpec): string {
  const lines = [
    `      id: ${q(edge.id)},`,
    `      from: ${q(edge.from)},`,
    `      to: ${q(edge.to)},`,
    `      category: ${q(edge.category)},`,
  ]
  if (edge.speedLimit !== undefined) lines.push(`      speedLimit: ${num(edge.speedLimit)},`)
  if (edge.via?.length) {
    const via = edge.via.map((p) => `        { x: ${num(p.x)}, y: ${num(p.y)} },`).join('\n')
    lines.push(`      via: [\n${via}\n      ],`)
  }
  const lanes = lanesExpression(edge.lanes)
  if (lanes) lines.push(`      lanes: ${lanes},`)
  if (edge.centreLine) lines.push(`      centreLine: ${q(edge.centreLine)},`)
  return `    {\n${lines.join('\n')}\n    },`
}

/**
 * Emit the graph as a TypeScript module in the same shape as town.ts, so an
 * edited layout can be pasted straight back into the source and reviewed as a
 * normal diff rather than living as opaque saved state.
 */
export function toTypeScript(spec: LaneGraphSpec, constantName = 'TOWN'): string {
  const usesTwoWay = spec.edges.some((e) => lanesExpression(e.lanes)?.startsWith('twoWay'))
  const imports = usesTwoWay
    ? `import { twoWay, type LaneGraphSpec } from './laneGraph'`
    : `import type { LaneGraphSpec } from './laneGraph'`

  return [
    `${imports}`,
    ``,
    `/** Exported from the in-browser road editor. */`,
    `export const ${constantName}: LaneGraphSpec = {`,
    `  nodes: [`,
    ...spec.nodes.map(nodeSource),
    `  ],`,
    ``,
    `  edges: [`,
    ...spec.edges.map(edgeSource),
    `  ],`,
    `}`,
    ``,
  ].join('\n')
}

export function toJson(spec: LaneGraphSpec): string {
  return JSON.stringify(spec, null, 2)
}

/** Parse a saved layout, rejecting anything that is not recognisably a graph. */
export function fromJson(text: string): LaneGraphSpec {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Not valid JSON')
  }

  const spec = parsed as Partial<LaneGraphSpec>
  if (!Array.isArray(spec.nodes) || !Array.isArray(spec.edges)) {
    throw new Error('Expected an object with "nodes" and "edges" arrays')
  }
  for (const node of spec.nodes) {
    if (typeof node?.id !== 'string' || !Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      throw new Error('Every node needs an id and numeric x and y')
    }
  }
  for (const edge of spec.edges) {
    if (typeof edge?.id !== 'string' || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      throw new Error('Every road needs an id, from and to')
    }
  }
  return { nodes: spec.nodes, edges: spec.edges }
}
