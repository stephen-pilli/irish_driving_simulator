/**
 * Drawing the traffic.
 *
 * Everything is instanced and nothing here holds state of its own: the view is
 * rebuilt from the simulation's road users every frame. If the picture and the
 * model ever disagree it is the picture that is wrong, and this way it cannot
 * be.
 */

import * as THREE from 'three'
import type { Pedestrian } from '../sim/pedestrians'
import { KIND_PROFILES, type RoadUser, type TrafficSystem } from '../sim/traffic'

/** How many people on foot can be drawn at once. */
const WALKER_CAPACITY = 64

/** Body colours, chosen to read as traffic rather than as a toy box. */
const CAR_COLOURS = [0xb8bfc6, 0x2d3a4a, 0x8c1f1f, 0x1f4030, 0xd8d8d2, 0x33435c, 0x5a5f66]
const VAN_COLOURS = [0xe8e8e4, 0xdfe3e6, 0xc9ced3]

function tinted(palette: number[], tint: number): THREE.Color {
  return new THREE.Color(palette[Math.floor(tint * palette.length) % palette.length]!)
}

export class TrafficView {
  readonly group = new THREE.Group()
  private readonly bodies: THREE.InstancedMesh
  private readonly cabins: THREE.InstancedMesh
  private readonly riders: THREE.InstancedMesh
  private readonly walkers: THREE.InstancedMesh
  private readonly dummy = new THREE.Object3D()
  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity)

    this.bodies = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.08 }),
      this.capacity,
    )
    this.cabins = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x39434f, roughness: 0.4, metalness: 0.15 }),
      this.capacity,
    )
    this.riders = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xe8c33a, roughness: 0.75 }),
      this.capacity,
    )
    this.walkers = new THREE.InstancedMesh(
      new THREE.CapsuleGeometry(0.22, 0.9, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0xcf6a4a, roughness: 0.85 }),
      WALKER_CAPACITY,
    )

    for (const mesh of [this.bodies, this.cabins, this.riders, this.walkers]) {
      mesh.castShadow = true
      mesh.receiveShadow = true
      // The traffic moves every frame, so there is no point in Three trying to
      // cull it against a bounding volume computed once at the start.
      mesh.frustumCulled = false
      this.group.add(mesh)
    }
  }

  update(traffic: TrafficSystem): void {
    let bodyCount = 0
    let cabinCount = 0
    let riderCount = 0

    for (const user of traffic.users) {
      if (bodyCount >= this.capacity) break
      const profile = KIND_PROFILES[user.kind]

      if (user.kind === 'cyclist') {
        this.setBox(this.bodies, bodyCount, user, profile.length, 0.55, 0.3, 0.55)
        this.bodies.setColorAt(bodyCount, new THREE.Color(0x24282d))
        bodyCount++

        this.setBox(this.riders, riderCount, user, 0.45, 1.05, 0.5, 1.25)
        riderCount++
        continue
      }

      const height = user.kind === 'van' ? 2.3 : 1.42
      this.setBox(this.bodies, bodyCount, user, profile.length, height, profile.width, height / 2)
      this.bodies.setColorAt(
        bodyCount,
        tinted(user.kind === 'van' ? VAN_COLOURS : CAR_COLOURS, user.tint),
      )
      bodyCount++

      // A glasshouse set back from the nose, which is most of what tells a car
      // apart from a crate at the distances this is seen from.
      const cabinLength = user.kind === 'van' ? profile.length * 0.3 : profile.length * 0.46
      this.setBox(
        this.cabins,
        cabinCount,
        user,
        cabinLength,
        user.kind === 'van' ? 0.5 : 0.62,
        profile.width * 0.92,
        height + (user.kind === 'van' ? 0.08 : 0.28),
        user.kind === 'van' ? profile.length * 0.22 : -profile.length * 0.08,
      )
      cabinCount++
    }

    this.bodies.count = bodyCount
    this.cabins.count = cabinCount
    this.riders.count = riderCount
    this.bodies.instanceMatrix.needsUpdate = true
    this.cabins.instanceMatrix.needsUpdate = true
    this.riders.instanceMatrix.needsUpdate = true
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true
  }

  /** People on foot, drawn only while they are at or on a crossing. */
  updatePedestrians(people: readonly Pedestrian[]): void {
    let count = 0
    for (const person of people) {
      if (person.state === 'away' || count >= WALKER_CAPACITY) continue
      this.dummy.position.set(person.x, 0.9, -person.y)
      this.dummy.rotation.set(0, 0, 0)
      this.dummy.scale.setScalar(1)
      this.dummy.updateMatrix()
      this.walkers.setMatrixAt(count, this.dummy.matrix)
      count++
    }
    this.walkers.count = count
    this.walkers.instanceMatrix.needsUpdate = true
  }

  /** Place one box on a road user. Local +X is forwards, matching the car. */
  private setBox(
    mesh: THREE.InstancedMesh,
    index: number,
    user: RoadUser,
    length: number,
    height: number,
    width: number,
    centreHeight: number,
    forwardOffset = 0,
  ): void {
    const d = this.dummy
    d.position.set(
      user.x + Math.cos(user.heading) * forwardOffset,
      centreHeight,
      -(user.y + Math.sin(user.heading) * forwardOffset),
    )
    d.rotation.set(0, user.heading, 0)
    d.scale.set(length, height, width)
    d.updateMatrix()
    mesh.setMatrixAt(index, d.matrix)
  }

  dispose(): void {
    for (const mesh of [this.bodies, this.cabins, this.riders, this.walkers]) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  }
}
