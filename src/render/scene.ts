import * as THREE from 'three'
import { mulberry32 } from '../core/rng'
import { edgePoint, sampleEdge, type Edge, type LaneGraph } from '../world/laneGraph'
import { buildTownGeometry, type SignalHead } from './roadGeometry'

const SKY = 0xc4d8ef

function noiseTexture(base: [number, number, number], spread: number, size = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  const rand = mulberry32(99)
  for (let i = 0; i < size * size; i++) {
    const n = (rand() - 0.5) * spread
    img.data[i * 4 + 0] = Math.max(0, Math.min(255, base[0] + n))
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, base[1] + n))
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, base[2] + n))
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/**
 * Seamlessly tiling tarmac. Built from wrapped value-noise lattices at two
 * scales plus per-pixel grain: the coarse scale stays visible at a distance
 * (which is where the speed cue comes from) while the grain keeps the surface
 * from looking like plastic up close.
 */
function tarmacTexture(size = 256): THREE.CanvasTexture {
  const rand = mulberry32(7)

  const lattice = (n: number): ((x: number, y: number) => number) => {
    const values = new Float32Array(n * n)
    for (let i = 0; i < values.length; i++) values[i] = rand()
    const at = (gx: number, gy: number): number =>
      values[(((gy % n) + n) % n) * n + (((gx % n) + n) % n)] ?? 0
    return (x: number, y: number) => {
      const fx = x * n
      const fy = y * n
      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      const tx = fx - x0
      const ty = fy - y0
      const a = at(x0, y0)
      const b = at(x0 + 1, y0)
      const c = at(x0, y0 + 1)
      const d = at(x0 + 1, y0 + 1)
      return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty
    }
  }

  const coarse = lattice(8)
  const medium = lattice(26)

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const value =
        128 + (coarse(u, v) - 0.5) * 40 + (medium(u, v) - 0.5) * 28 + (rand() - 0.5) * 16
      const i = (y * size + x) * 4
      const c = Math.max(0, Math.min(255, value))
      img.data[i] = c
      img.data[i + 1] = c + 1
      img.data[i + 2] = c + 3
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

const isBuiltUp = (edge: Edge): boolean =>
  edge.category === 'urban' || edge.category === 'urbanCore'

export class World {
  readonly scene = new THREE.Scene()
  readonly renderer: THREE.WebGLRenderer
  readonly sun: THREE.DirectionalLight
  signalHeads: SignalHead[] = []
  graph: LaneGraph
  private townGroup: THREE.Group | null = null
  private groundMesh: THREE.Mesh | null = null
  private roadsideGroup: THREE.Group | null = null
  private readonly tarmac: THREE.Material
  private readonly paint: THREE.Material
  private readonly verge: THREE.Material

  constructor(canvas: HTMLCanvasElement, graph: LaneGraph) {
    this.graph = graph
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.scene.background = new THREE.Color(SKY)
    this.scene.fog = new THREE.Fog(SKY, 260, 1150)
    this.scene.add(new THREE.HemisphereLight(0x9ec4ea, 0x4c6b3c, 1.1))

    // A soft, low Irish sun. The shadow camera is small and follows the car,
    // which is the only way to get crisp shadows over a town-sized area.
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.0)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.camera.left = -55
    this.sun.shadow.camera.right = 55
    this.sun.shadow.camera.top = 55
    this.sun.shadow.camera.bottom = -55
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 280
    this.sun.shadow.bias = -0.0008
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)

    const tarmacTex = tarmacTexture()
    tarmacTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
    this.tarmac = new THREE.MeshStandardMaterial({
      map: tarmacTex,
      color: 0xdcdee2,
      roughness: 0.95,
      side: THREE.DoubleSide,
    })
    this.paint = new THREE.MeshStandardMaterial({
      color: 0xf2f2ee,
      roughness: 0.6,
      side: THREE.DoubleSide,
    })
    this.verge = new THREE.MeshStandardMaterial({
      color: 0x59502f,
      roughness: 1,
      side: THREE.DoubleSide,
    })

    this.setGraph(graph)
  }

  /**
   * Swap in a new road layout. Called every time the editor applies a change,
   * so the old geometry has to be released rather than merely detached — an
   * afternoon of editing would otherwise leak hundreds of buffers.
   */
  setGraph(graph: LaneGraph): void {
    this.graph = graph

    for (const group of [this.townGroup, this.roadsideGroup]) {
      if (!group) continue
      this.scene.remove(group)
      group.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose()
          // Shared road materials are reused across rebuilds; only dispose the
          // ones created per-rebuild, such as the signal lamps.
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          for (const material of materials) {
            if (material !== this.tarmac && material !== this.paint && material !== this.verge) {
              material.dispose()
            }
          }
        }
      })
    }

    const town = buildTownGeometry(graph, {
      tarmac: this.tarmac,
      paint: this.paint,
      verge: this.verge,
    })
    this.townGroup = town.group
    this.signalHeads = town.signalHeads
    this.scene.add(town.group)

    this.roadsideGroup = this.buildRoadside()
    this.scene.add(this.roadsideGroup)

    this.buildGround()
  }

  /**
   * The ground, as a mesh that follows the roads.
   *
   * It used to be one flat plane, which was fine while every road was at sea
   * level. The moment a road climbs, a flat field leaves it floating on a
   * ribbon of tarmac in mid-air, so the ground is now sampled from the lane
   * graph: level with the carriageway alongside it, easing back to the datum
   * further out.
   *
   * Sized to the town rather than to the horizon. A grid big enough to reach
   * the far plane at a useful resolution would be hundreds of thousands of
   * vertices for scenery nobody looks at.
   */
  private buildGround(): void {
    if (this.groundMesh) {
      this.scene.remove(this.groundMesh)
      this.groundMesh.geometry.dispose()
    }

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const edge of this.graph.edges.values()) {
      for (const point of edge.points) {
        minX = Math.min(minX, point.x)
        maxX = Math.max(maxX, point.x)
        minY = Math.min(minY, point.y)
        maxY = Math.max(maxY, point.y)
      }
    }
    if (!Number.isFinite(minX)) {
      minX = maxX = minY = maxY = 0
    }

    const margin = 900
    const width = maxX - minX + margin * 2
    const depth = maxY - minY + margin * 2
    const step = 12
    const cols = Math.max(2, Math.round(width / step))
    const rows = Math.max(2, Math.round(depth / step))

    const geo = new THREE.PlaneGeometry(width, depth, cols, rows)
    geo.rotateX(-Math.PI / 2)
    geo.translate((minX + maxX) / 2, -0.02, -(minY + maxY) / 2)

    const position = geo.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i)
      // Render Z is the negated simulation Y.
      const y = -position.getZ(i)
      position.setY(i, this.graph.terrainElevation(x, y) - 0.02)
    }
    geo.computeVertexNormals()

    const uv = geo.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) * width) / 8, (uv.getY(i) * depth) / 8)
    }

    const tex = noiseTexture([92, 124, 74], 26)
    const ground = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }),
    )
    ground.receiveShadow = true
    this.groundMesh = ground
    this.scene.add(ground)
  }

  /**
   * Roadside detail, placed from the lane graph. It is not decoration: a built
   * -up street has to LOOK built up, because the speed a driver chooses is cued
   * by how enclosed the road feels as much as by the signs.
   */
  private buildRoadside(): THREE.Group {
    const group = new THREE.Group()
    const rand = mulberry32(1337)
    const dummy = new THREE.Object3D()

    const buildings = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.85 }),
      600,
    )
    const hedges = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x3f5c2e, roughness: 1 }),
      1400,
    )
    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.22, 0.3, 3, 6),
      new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 }),
      300,
    )
    const canopies = new THREE.InstancedMesh(
      new THREE.ConeGeometry(2.6, 6.5, 8),
      new THREE.MeshStandardMaterial({ color: 0x2f5424, roughness: 1 }),
      300,
    )
    buildings.castShadow = hedges.castShadow = trunks.castShadow = canopies.castShadow = true

    const palette = [0xd8d2c6, 0xc9bfae, 0xe2ddd2, 0xb9a893, 0xcfd6d8]
    let bi = 0
    let hi = 0
    let ti = 0

    for (const edge of this.graph.edges.values()) {
      // A roundabout's circulatory carriageway is an ordinary road as far as
      // the rest of the engine is concerned, which means the roadside pass
      // would happily line the island with houses.
      if (edge.circulatoryOf) continue

      const from = edge.startTrim + 4
      const to = edge.length - edge.endTrim - 4
      const builtUp = isBuiltUp(edge)
      const step = builtUp ? 13 : 6

      for (let s = from; s < to; s += step) {
        const pose = sampleEdge(edge, s + step / 2)
        // Everything roadside stands on the road's own ground, not on the datum.
        const ground = edge.elevationAt(s + step / 2)
        for (const side of [1, -1]) {
          if (builtUp) {
            if (rand() < 0.22 || bi >= buildings.count) continue
            const width = 7 + rand() * 5
            const depth = 7 + rand() * 4
            const height = 4.5 + rand() * 4.5
            const p = edgePoint(edge, s + step / 2, side * (edge.halfWidth + 3 + depth / 2))
            dummy.position.set(p.x, ground + height / 2, -p.y)
            dummy.rotation.set(0, pose.heading, 0)
            dummy.scale.set(width, height, depth)
            dummy.updateMatrix()
            buildings.setMatrixAt(bi, dummy.matrix)
            buildings.setColorAt(bi, new THREE.Color(palette[bi % palette.length]!))
            bi++
          } else {
            if (rand() < 0.16 || hi >= hedges.count) continue
            const height = 0.9 + rand() * 0.7
            const p = edgePoint(edge, s + step / 2, side * (edge.halfWidth + 2.4))
            dummy.position.set(p.x, ground + height / 2, -p.y)
            dummy.rotation.set(0, pose.heading, 0)
            dummy.scale.set(step + 0.4, height, 1.2)
            dummy.updateMatrix()
            hedges.setMatrixAt(hi++, dummy.matrix)
          }
        }

        // Trees only out of town, set well back.
        if (!builtUp && rand() < 0.22 && ti < trunks.count) {
          const side = rand() < 0.5 ? 1 : -1
          const p = edgePoint(edge, s, side * (edge.halfWidth + 10 + rand() * 26))
          const scale = 0.75 + rand() * 0.6
          dummy.rotation.set(0, rand() * Math.PI * 2, 0)
          dummy.scale.setScalar(scale)
          dummy.position.set(p.x, edge.elevationAt(s) + 1.5 * scale, -p.y)
          dummy.updateMatrix()
          trunks.setMatrixAt(ti, dummy.matrix)
          dummy.position.set(p.x, edge.elevationAt(s) + 5.6 * scale, -p.y)
          dummy.updateMatrix()
          canopies.setMatrixAt(ti, dummy.matrix)
          ti++
        }
      }
    }

    // Roundabout islands: a tree and a ring of low planting, which is both
    // what they usually hold and what makes the island read as solid rather
    // than as a hole in the road.
    for (const node of this.graph.nodes.values()) {
      if (!node.island) continue
      const r = node.island.radius

      const islandGround = node.z ?? 0
      if (ti < trunks.count) {
        dummy.position.set(node.x, islandGround + 1.5, -node.y)
        dummy.rotation.set(0, rand() * Math.PI, 0)
        dummy.scale.setScalar(1.15)
        dummy.updateMatrix()
        trunks.setMatrixAt(ti, dummy.matrix)
        dummy.position.y = islandGround + 5.6
        dummy.updateMatrix()
        canopies.setMatrixAt(ti, dummy.matrix)
        ti++
      }

      const count = Math.max(6, Math.round(r * 0.9))
      for (let i = 0; i < count && hi < hedges.count; i++) {
        const angle = (i / count) * Math.PI * 2
        const ring = r * 0.62
        dummy.position.set(
          node.x + Math.cos(angle) * ring,
          islandGround + 0.4,
          -(node.y + Math.sin(angle) * ring),
        )
        dummy.rotation.set(0, -angle, 0)
        dummy.scale.set(1.6, 0.8, 1.6)
        dummy.updateMatrix()
        hedges.setMatrixAt(hi, dummy.matrix)
        hi++
      }
    }

    buildings.count = bi
    hedges.count = hi
    trunks.count = canopies.count = ti
    if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true
    group.add(buildings, hedges, trunks, canopies)
    return group
  }

  /** Keep the shadow volume centred on the car. */
  followSun(x: number, z: number): void {
    this.sun.position.set(x - 48, 70, z + 38)
    this.sun.target.position.set(x, 0, z)
  }

  resize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false)
  }
}
