import { msToKmh } from './core/math'
import { startLoop } from './core/loop'
import { Input } from './input/input'
import { CameraRig, DEFAULT_CAMERA_PARAMS } from './render/cameras'
import { CarView } from './render/car'
import { World } from './render/scene'
import { applyAspect } from './render/roadGeometry'
import {
  createState,
  DEFAULT_PARAMS,
  requestReverseToggle,
  stepVehicle,
  turningCircleDiameter,
  type VehicleState,
} from './sim/vehicle'
import { EngineAudio } from './ui/audio'
import { Hud } from './ui/hud'
import { RulesEngine } from './rules/engine'
import { irishRules } from './rules/irish'
import { Tuner } from './ui/tuner'
import { CAMERA_FIELDS, VEHICLE_FIELDS } from './ui/tuningFields'
import { edgePoint, LaneGraph, sampleEdge } from './world/laneGraph'
import { RoadEditor } from './editor/editor'
import { createSignals } from './world/signals'
import { BALLYROAD, START } from './world/town'

const canvas = document.getElementById('viewport') as HTMLCanvasElement
const hudRoot = document.getElementById('hud') as HTMLElement
const tunerRoot = document.getElementById('tuner') as HTMLElement

// The layout is mutable: the editor swaps it out while the app is running.
let graph = new LaneGraph(BALLYROAD)
let signals = createSignals(graph)
const params = Tuner.load('vehicle', DEFAULT_PARAMS)
const cameraParams = Tuner.load('camera', DEFAULT_CAMERA_PARAMS)

const world = new World(canvas, graph)
const rig = new CameraRig(window.innerWidth / window.innerHeight, cameraParams)
const input = new Input()
const hud = new Hud(hudRoot)
const audio = new EngineAudio()
let rules = new RulesEngine(irishRules(), graph, signals)

let car = new CarView(params)
world.scene.add(car.group)

const state: VehicleState = createState()
reset()

const tuner = new Tuner(tunerRoot, () => {
  // Changing the wheelbase changes the model, so rebuild the view in place.
  world.scene.remove(car.group)
  car = new CarView(params)
  world.scene.add(car.group)
})

tuner.addSection(
  'Handling',
  'vehicle',
  params,
  DEFAULT_PARAMS,
  VEHICLE_FIELDS,
  (p) => `Turning circle ${turningCircleDiameter(p).toFixed(1)} m kerb to kerb`,
)
tuner.addSection(
  'Camera',
  'camera',
  cameraParams,
  DEFAULT_CAMERA_PARAMS,
  CAMERA_FIELDS,
  (p) => `${p.height.toFixed(2)} m high, ${p.distance.toFixed(1)} m back, ${p.fov}° FOV — fixed`,
)

const editor = new RoadEditor(
  document.getElementById('editor') as HTMLElement,
  document.getElementById('editor-canvas') as HTMLCanvasElement,
  document.getElementById('editor-panel') as HTMLElement,
  BALLYROAD,
  {
    apply(spec) {
      graph = new LaneGraph(spec)
      signals = createSignals(graph)
      rules = new RulesEngine(irishRules(), graph, signals)
      world.setGraph(graph)
      // The car may now be standing somewhere that is no longer a road.
      if (!graph.locate(state.x, state.y, state.heading)) reset()
    },
    carPose: () => ({ x: state.x, y: state.y, heading: state.heading }),
  },
)

// A layout saved in a previous session replaces the built-in town at boot.
editor.syncToSimulation()

function reset(): void {
  // The editor can delete the road the drive normally starts on, so fall back
  // to the longest road that still exists rather than failing to start.
  const edge =
    graph.edges.get(START.edgeId) ??
    [...graph.edges.values()].sort((a, b) => b.length - a.length)[0]
  if (!edge) return

  const s = Math.min(START.s, edge.length / 2)
  const p = edgePoint(edge, s, edge.laneOffset(0))
  const pose = sampleEdge(edge, s)
  Object.assign(state, createState(p.x, p.y, pose.heading))
  rules.reset()
}

function handleActions(): void {
  for (const action of input.consumeActions()) {
    switch (action) {
      case 'toggleReverse':
        requestReverseToggle(state)
        break
      case 'selectNeutral':
        state.gear = state.gear === 'N' ? 'D' : 'N'
        break
      case 'cycleCamera':
        rig.cycle()
        break
      case 'toggleTuner':
        tuner.toggle()
        break
      case 'toggleEditor':
        if (editor.toggle()) editor.renderPanel()
        break
      case 'toggleAudio':
        audio.toggle()
        break
      case 'reset':
        reset()
        break
    }
  }
}

world.resize()
rig.setAspect(window.innerWidth / window.innerHeight)
window.addEventListener('resize', () => {
  world.resize()
  rig.setAspect(window.innerWidth / window.innerHeight)
})

const loop = startLoop({
  // 120 Hz: fine enough that the steering is smooth, cheap enough to be free.
  fixedDt: 1 / 120,
  update(dt) {
    if (editor.isOpen) return
    const driver = input.sample()
    stepVehicle(state, driver, params, dt)
    for (const controller of signals.values()) controller.update(dt)
    rules.update(state, driver, dt)
  },
  render(frameDt) {
    handleActions()
    // The editor covers the viewport, so there is nothing to draw behind it.
    if (editor.isOpen) return
    const driver = input.driver

    car.setShellVisible(rig.currentMode !== 'bonnet')
    car.update(state, driver.brake > 0 || driver.handbrake, frameDt)
    car.group.updateMatrixWorld(true)
    rig.update(state, car)
    world.followSun(state.x, -state.y)

    for (const head of world.signalHeads) {
      const controller = signals.get(head.nodeId)
      if (controller) applyAspect(head, controller.aspectFor(head.edgeId))
    }
    audio.update(msToKmh(state.speed), driver.throttle)

    const located = graph.locate(state.x, state.y, state.heading)

    hud.update({
      speedKmh: msToKmh(state.speed),
      speedLimit: located && !located.offRoad ? located.speedLimit : null,
      faults: rules.faults,
      verdict: rules.verdict(),
      gear: state.gear,
      throttle: driver.throttle,
      brake: driver.brake,
      handbrake: driver.handbrake,
      steerRad: state.steer,
      latAccel: state.latAccel,
      longAccel: state.longAccel,
      atGripLimit: state.atGripLimit,
      fps: loop.fps,
      odometerKm: state.odometer / 1000,
      camera: rig.currentMode,
      audio: audio.isEnabled,
    })

    world.renderer.render(world.scene, rig.camera)
  },
})

// Dev-only inspection hook: lets the browser console (and automated checks)
// poke at the running simulation without exporting anything to production.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__sim = {
    world,
    rig,
    // Getters, not values: the editor replaces these bindings wholesale, and a
    // snapshot taken at boot would quietly report the pre-edit layout.
    get graph() {
      return graph
    },
    get signals() {
      return signals
    },
    get rules() {
      return rules
    },
    editor,
    state,
    params,
    cameraParams,
    loop,
    get car() {
      return car
    },
    reset,
  }
}
