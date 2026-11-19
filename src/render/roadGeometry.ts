import * as THREE from 'three'
import {
  approachSpan,
  centreLineOffset,
  edgePoint,
  sampleEdge,
  type Edge,
  type EdgeId,
  type LaneGraph,
} from '../world/laneGraph'

const SURFACE_Y = 0.01
const PAINT_Y = 0.013
const JUNCTION_Y = 0.011

export interface RoadMaterials {
  tarmac: THREE.Material
  paint: THREE.Material
  verge: THREE.Material
}

/**
 * Ribbon between two lateral offsets, over an arc-length span.
 *
 * `height` is the clearance ABOVE the carriageway, not an absolute altitude:
 * the road itself follows the gradient between its two ends, and markings have
 * to ride on top of it rather than hovering over a hill at a fixed height.
 */
function ribbon(
  edge: Edge,
  fromS: number,
  toS: number,
  offsetA: number,
  offsetB: number,
  height: number,
  uvTile = 6,
  step = 2.5,
): THREE.BufferGeometry | null {
  const span = toS - fromS
  if (span <= 0.05) return null

  const segments = Math.max(1, Math.ceil(span / step))
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const vSpan = Math.abs(offsetA - offsetB) / uvTile

  for (let i = 0; i <= segments; i++) {
    const s = fromS + (span * i) / segments
    const a = edgePoint(edge, s, offsetA)
    const b = edgePoint(edge, s, offsetB)
    const y = edge.elevationAt(s) + height
    positions.push(a.x, y, -a.y, b.x, y, -b.y)
    normals.push(0, 1, 0, 0, 1, 0)
    const u = s / uvTile
    uvs.push(u, 0, u, vSpan)
  }
  for (let i = 0; i < segments; i++) {
    const v = i * 2
    indices.push(v, v + 1, v + 3, v, v + 3, v + 2)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(indices)
  geo.computeBoundingSphere()
  return geo
}

/** A broken line, drawn as separate dashes that still follow the curve. */
function dashes(
  edge: Edge,
  fromS: number,
  toS: number,
  offset: number,
  width: number,
  dashLength: number,
  gapLength: number,
): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = []
  for (let s = fromS; s + dashLength < toS; s += dashLength + gapLength) {
    const g = ribbon(edge, s, s + dashLength, offset + width / 2, offset - width / 2, PAINT_Y, 6, 1.5)
    if (g) parts.push(g)
  }
  return parts.length ? mergeGeometries(parts) : null
}

/** Minimal geometry merge — avoids pulling in the examples/ addon. */
function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  let offset = 0

  for (const part of parts) {
    const pos = part.getAttribute('position')
    const nrm = part.getAttribute('normal')
    const uv = part.getAttribute('uv')
    const idx = part.getIndex()
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i))
      normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i))
      uvs.push(uv.getX(i), uv.getY(i))
    }
    if (idx) for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + offset)
    offset += pos.count
    part.dispose()
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(indices)
  geo.computeBoundingSphere()
  return geo
}

function addMesh(
  target: THREE.Group,
  geo: THREE.BufferGeometry | null,
  material: THREE.Material,
  receiveShadow = true,
): void {
  if (!geo) return
  const mesh = new THREE.Mesh(geo, material)
  mesh.receiveShadow = receiveShadow
  target.add(mesh)
}

export interface SignalHead {
  edgeId: EdgeId
  nodeId: string
  lamps: { red: THREE.MeshStandardMaterial; amber: THREE.MeshStandardMaterial; green: THREE.MeshStandardMaterial }
}

export interface TownGeometry {
  group: THREE.Group
  signalHeads: SignalHead[]
}

/**
 * Build every road surface and marking from the lane graph. Nothing here is
 * authored by hand: change the graph and the geometry follows, which is what
 * keeps what the driver sees identical to what the rules engine reads.
 */
export function buildTownGeometry(graph: LaneGraph, materials: RoadMaterials): TownGeometry {
  const group = new THREE.Group()
  const surfaces: THREE.BufferGeometry[] = []
  const paintParts: THREE.BufferGeometry[] = []
  const vergeParts: THREE.BufferGeometry[] = []
  const signalHeads: SignalHead[] = []

  for (const edge of graph.edges.values()) {
    const from = edge.startTrim
    const to = edge.length - edge.endTrim
    if (to <= from) continue

    const surface = ribbon(edge, from, to, edge.halfWidth, -edge.halfWidth, SURFACE_Y)
    if (surface) surfaces.push(surface)

    const vergeL = ribbon(edge, from, to, edge.halfWidth + 0.9, edge.halfWidth, 0)
    const vergeR = ribbon(edge, from, to, -edge.halfWidth, -edge.halfWidth - 0.9, 0)
    if (vergeL) vergeParts.push(vergeL)
    if (vergeR) vergeParts.push(vergeR)

    // Continuous white edge lines.
    const edgeLineL = ribbon(edge, from, to, edge.halfWidth - 0.12, edge.halfWidth - 0.24, PAINT_Y)
    const edgeLineR = ribbon(edge, from, to, -edge.halfWidth + 0.24, -edge.halfWidth + 0.12, PAINT_Y)
    if (edgeLineL) paintParts.push(edgeLineL)
    if (edgeLineR) paintParts.push(edgeLineR)

    // Centre line, in whatever form the graph says it takes.
    const centre = centreLineOffset(edge)
    if (centre !== null && edge.centreLine !== 'none') {
      if (edge.centreLine === 'broken') {
        const g = dashes(edge, from, to, centre, 0.12, 4, 8)
        if (g) paintParts.push(g)
      } else if (edge.centreLine === 'continuous') {
        const g = ribbon(edge, from, to, centre + 0.06, centre - 0.06, PAINT_Y)
        if (g) paintParts.push(g)
      } else {
        for (const side of [0.19, -0.07]) {
          const g = ribbon(edge, from, to, centre + side, centre + side - 0.12, PAINT_Y)
          if (g) paintParts.push(g)
        }
      }
    }
  }

  // Pedestrian crossings. The bars of a zebra run ALONG the direction of
  // traffic, not across it — you step over them rather than along them.
  for (const edge of graph.edges.values()) {
    for (const crossing of edge.crossings) {
      const halfLength = 1.6
      const barWidth = 0.5
      const span = edge.halfWidth - 0.3
      for (let offset = -span; offset < span - barWidth; offset += barWidth * 2) {
        const bar = ribbon(
          edge,
          crossing - halfLength,
          crossing + halfLength,
          offset + barWidth,
          offset,
          PAINT_Y,
          6,
          0.8,
        )
        if (bar) paintParts.push(bar)
      }
    }
  }

  // Junction surfaces, and the stop lines on their approaches.
  for (const node of graph.nodes.values()) {
    const junction = node.junction
    if (!junction) continue

    const disc = new THREE.CircleGeometry(junction.radius + 1.5, 28)
    disc.rotateX(-Math.PI / 2)
    disc.translate(node.x, (node.z ?? 0) + JUNCTION_Y, -node.y)
    // CircleGeometry's UVs are 0..1 across the disc; rescale so the surface
    // matches the roads it joins rather than stretching one tile over it.
    const uv = disc.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) * junction.radius * 2) / 6, (uv.getY(i) * junction.radius * 2) / 6)
    }
    surfaces.push(disc)

    const control = junction.control
    const marked =
      control.kind === 'stop'
        ? control.stopEdges
        : control.kind === 'yield'
          ? control.yieldEdges
          : control.kind === 'signals'
            ? control.groups.flat()
            : []

    for (const edgeId of marked) {
      const edge = graph.edges.get(edgeId)
      if (!edge) continue
      const atEnd = edge.to === node.id
      if (!atEnd && edge.from !== node.id) continue

      const span = approachSpan(edge, node.id)
      if (!span) continue

      // The stop line sits just before the junction surface begins.
      const s = atEnd ? edge.length - edge.endTrim - 0.9 : edge.startTrim + 0.9
      const thickness = control.kind === 'stop' || control.kind === 'signals' ? 0.3 : 0.2
      const bar = ribbon(edge, s - thickness / 2, s + thickness / 2, span[0], span[1], PAINT_Y, 6, 0.5)
      if (bar) paintParts.push(bar)

      if (control.kind === 'signals') {
        signalHeads.push(createSignalHead(group, edge, node.id, s, span))
      } else if (control.kind === 'stop' || control.kind === 'yield') {
        // On the driver's left, which in Ireland is the outer edge of their
        // own side of the road.
        const lateral = atEnd ? span[0] + 1.3 : -(span[0] + 1.3)
        addSign(
          group,
          edge,
          atEnd,
          s,
          lateral,
          control.kind === 'stop' ? SIGN_FACES.stop() : SIGN_FACES.yield(),
          0.95,
          1.9,
        )
      }
    }
  }

  // Roundabout islands. The ring itself is ordinary road geometry, generated
  // from the circulatory edges like any other one-way street; only the raised
  // middle needs drawing by hand.
  for (const node of graph.nodes.values()) {
    if (!node.island) continue
    const r = node.island.radius

    // One solid disc for the island and an open tube for the kerb around it.
    // A capped cylinder under a separate top face put two surfaces a centimetre
    // apart, and at any distance the depth buffer picked the wrong one, so the
    // island rendered as a grey slab instead of as planting.
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.18, 40), materials.verge)
    body.position.set(node.x, (node.z ?? 0) + 0.09, -node.y)
    body.receiveShadow = true
    group.add(body)

    const kerb = new THREE.Mesh(
      new THREE.CylinderGeometry(r + 0.02, r + 0.02, 0.2, 40, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.9, side: THREE.DoubleSide }),
    )
    kerb.position.set(node.x, (node.z ?? 0) + 0.1, -node.y)
    kerb.castShadow = true
    group.add(kerb)
  }

  // Speed limit signs, wherever the limit actually changes. Signing every road
  // would be noise; signing a change is what a real road does.
  for (const node of graph.nodes.values()) {
    for (const edgeId of node.edges) {
      const edge = graph.edges.get(edgeId)
      if (!edge || edge.circulatoryOf) continue

      const others = node.edges
        .filter((id) => id !== edgeId)
        .map((id) => graph.edges.get(id))
        .filter((e): e is Edge => e !== undefined && e.circulatoryOf === undefined)
      if (others.length === 0) continue
      // Signed when every road you could have come from had a different limit.
      if (others.some((other) => other.speedLimit === edge.speedLimit)) continue

      // A limit sign faces the traffic ENTERING the road, which is the traffic
      // travelling away from this junction. Facing it the other way signs the
      // limit at drivers who are leaving it, which is worse than no sign.
      const entering = edge.from === node.id
      const s = entering ? edge.startTrim + 9 : edge.length - edge.endTrim - 9
      if (s <= 1 || s >= edge.length - 1) continue

      // On that driver's left: positive lateral when travelling with the edge.
      const lateral = entering ? edge.halfWidth + 1.1 : -(edge.halfWidth + 1.1)
      addSign(group, edge, entering, s, lateral, SIGN_FACES.limit(edge.speedLimit), 0.8, 1.85)
    }
  }

  addMesh(group, surfaces.length ? mergeGeometries(surfaces) : null, materials.tarmac)
  addMesh(group, vergeParts.length ? mergeGeometries(vergeParts) : null, materials.verge)
  addMesh(group, paintParts.length ? mergeGeometries(paintParts) : null, materials.paint)

  return { group, signalHeads }
}

/** A sign face drawn to a canvas, so the artwork lives in code with the rules. */
function signTexture(draw: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.clearRect(0, 0, size, size)
    draw(ctx, size)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function polygon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, sides: number, rotation: number): void {
  ctx.beginPath()
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2
    const x = cx + Math.cos(a) * r
    const y = cy + Math.sin(a) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

const SIGN_FACES = {
  stop: () =>
    signTexture((ctx, size) => {
      polygon(ctx, size / 2, size / 2, size * 0.46, 8, Math.PI / 8)
      ctx.fillStyle = '#c1121f'
      ctx.fill()
      ctx.lineWidth = size * 0.035
      ctx.strokeStyle = '#ffffff'
      ctx.stroke()
      ctx.fillStyle = '#ffffff'
      ctx.font = `bold ${size * 0.28}px Helvetica, Arial, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('STOP', size / 2, size / 2)
    }),
  yield: () =>
    signTexture((ctx, size) => {
      // An Irish yield sign is a downward triangle with a red border.
      polygon(ctx, size / 2, size * 0.54, size * 0.48, 3, Math.PI / 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.lineWidth = size * 0.08
      ctx.strokeStyle = '#c1121f'
      ctx.stroke()
      ctx.fillStyle = '#1a1a1a'
      ctx.font = `bold ${size * 0.15}px Helvetica, Arial, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('YIELD', size / 2, size * 0.45)
    }),
  limit: (kmh: number) =>
    signTexture((ctx, size) => {
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size * 0.46, 0, Math.PI * 2)
      ctx.fillStyle = '#f4f4f0'
      ctx.fill()
      ctx.lineWidth = size * 0.11
      ctx.strokeStyle = '#c1121f'
      ctx.stroke()
      ctx.fillStyle = '#15171a'
      ctx.font = `bold ${size * 0.4}px Helvetica, Arial, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(kmh), size / 2, size * 0.52)
    }),
}

/**
 * A sign on a post, facing the driver who has to read it.
 *
 * Placed from the lane graph like everything else, so a junction that gives
 * way has a sign saying so and a road whose limit changes is signed where it
 * changes. A rules trainer where the rules are invisible is a memory test.
 */
function addSign(
  target: THREE.Group,
  edge: Edge,
  nodeIsEnd: boolean,
  s: number,
  lateral: number,
  texture: THREE.Texture,
  faceSize: number,
  height: number,
): void {
  const p = edgePoint(edge, s, lateral)
  const pose = sampleEdge(edge, s)

  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.05, height, 7),
    new THREE.MeshStandardMaterial({ color: 0x6f757c, roughness: 0.75, metalness: 0.3 }),
  )
  const base = edge.elevationAt(s)
  post.position.set(p.x, base + height / 2, -p.y)
  post.castShadow = true
  target.add(post)

  const y = base + height + faceSize / 2 - 0.08
  // Face back down the road the driver is coming up.
  const facing = pose.heading + (nodeIsEnd ? -Math.PI / 2 : Math.PI / 2)

  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(faceSize, faceSize),
    new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      roughness: 0.6,
      side: THREE.FrontSide,
    }),
  )
  face.position.set(p.x, y, -p.y)
  face.rotation.y = facing
  face.castShadow = true
  target.add(face)

  // A plain back. Double-siding the face instead makes a sign readable, and
  // mirror-reversed, from the side it is not meant for.
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(faceSize * 0.98, faceSize * 0.98),
    new THREE.MeshStandardMaterial({ color: 0x5c6269, roughness: 0.85 }),
  )
  back.position.set(p.x - Math.sin(facing) * 0.012, y, -p.y - Math.cos(facing) * 0.012)
  back.rotation.y = facing + Math.PI
  target.add(back)
}

/** Primary signal on the left of the approach, as in Ireland. */
function createSignalHead(
  target: THREE.Group,
  edge: Edge,
  nodeId: string,
  s: number,
  span: [number, number],
): SignalHead {
  const atEnd = edge.to === nodeId
  const outer = span[0]
  const lateral = atEnd ? outer + 1.1 : -(outer + 1.1)
  const p = edgePoint(edge, s, lateral)
  const pose = sampleEdge(edge, s)

  const pole = new THREE.Group()
  pole.position.set(p.x, edge.elevationAt(s), -p.y)
  // Face the oncoming driver.
  pole.rotation.y = pose.heading + (atEnd ? Math.PI : 0)

  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.08, 3, 8),
    new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.8 }),
  )
  post.position.y = 1.5
  post.castShadow = true
  pole.add(post)

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 1.0, 0.26),
    new THREE.MeshStandardMaterial({ color: 0x20242a, roughness: 0.85 }),
  )
  head.position.y = 3.15
  head.castShadow = true
  pole.add(head)

  const lamp = (colour: number, y: number): THREE.MeshStandardMaterial => {
    const material = new THREE.MeshStandardMaterial({
      color: colour,
      emissive: colour,
      emissiveIntensity: 0,
    })
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.11, 14), material)
    mesh.position.set(0, y, 0.14)
    head.add(mesh)
    return material
  }

  const lamps = {
    red: lamp(0xff2a1f, 3.47),
    amber: lamp(0xffa51f, 3.15),
    green: lamp(0x24d05a, 2.83),
  }

  target.add(pole)
  return { edgeId: edge.id, nodeId, lamps }
}

/** Drive the lamp emissives from a signal aspect. */
export function applyAspect(head: SignalHead, aspect: string): void {
  head.lamps.red.emissiveIntensity = aspect === 'red' || aspect === 'redAmber' ? 3 : 0
  head.lamps.amber.emissiveIntensity = aspect === 'amber' || aspect === 'redAmber' ? 3 : 0
  head.lamps.green.emissiveIntensity = aspect === 'green' ? 3 : 0
}
