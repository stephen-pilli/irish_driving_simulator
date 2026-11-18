import { msToKmh } from './core/math'
import { startLoop } from './core/loop'
import { Input, type DriverInput } from './input/input'
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
import { DriveRecorder, ReplaySession, restoreSignalPhases } from './sim/recorder'
import { PedestrianSystem } from './sim/pedestrians'
import { DEFAULT_TRAFFIC, TrafficSystem, type PlayerObstacle } from './sim/traffic'
import { TrafficView } from './render/traffic'
import { EngineAudio } from './ui/audio'
import { Hud } from './ui/hud'
import { Report } from './ui/report'
import { ScenarioMenu } from './ui/scenarioMenu'
import { SCENARIOS, type Scenario, type ScenarioWorld } from './scenarios/scenarios'
import { RulesEngine } from './rules/engine'
import type { WorldSense } from './rules/types'
import { irishRules } from './rules/irish'
import { Tuner } from './ui/tuner'
import { CAMERA_FIELDS, VEHICLE_FIELDS } from './ui/tuningFields'
import { edgePoint, LaneGraph, laneForTravel, sampleEdge } from './world/laneGraph'
import { RoadEditor } from './editor/editor'
import { createSignals } from './world/signals'
import { BALLYROAD, START } from './world/town'

const canvas = document.getElementById('viewport') as HTMLCanvasElement
const hudRoot = document.getElementById('hud') as HTMLElement
const tunerRoot = document.getElementById('tuner') as HTMLElement
const replayBanner = document.getElementById('replay') as HTMLElement

/** 120 Hz: fine enough that the steering is smooth, cheap enough to be free. */
const FIXED_DT = 1 / 120

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

let traffic = new TrafficSystem(graph, signals, DEFAULT_TRAFFIC)
let pedestrians = new PedestrianSystem(graph)
const trafficView = new TrafficView(DEFAULT_TRAFFIC.population + 8)

const recorder = new DriveRecorder()
/** Non-null while a recorded drive is being played back instead of driven. */
let replay: ReplaySession | null = null
/** The live drive, parked while a replay borrows the car. */
let liveState: VehicleState | null = null
let liveTraffic: TrafficSystem | null = null
let livePedestrians: PedestrianSystem | null = null
let replayTraffic: TrafficSystem | null = null
let replayPedestrians: PedestrianSystem | null = null

let car = new CarView(params)
world.scene.add(car.group)
world.scene.add(trafficView.group)

const state: VehicleState = createState()
let trafficSeed = DEFAULT_TRAFFIC.seed
reset()

const report = new Report(document.getElementById('report') as HTMLElement, {
  replayFrom: startReplay,
  close: () => report.hide(),
  restart: () => {
    report.hide()
    stopReplay()
    reset()
  },
})

const scenarioMenu = new ScenarioMenu(
  document.getElementById('scenarios') as HTMLElement,
  document.getElementById('brief') as HTMLElement,
  SCENARIOS,
  {
    start: (chosen) => startScenario(chosen),
    freeDrive: () => startScenario(null),
    close: () => scenarioMenu.hide(),
  },
)

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
      // The traffic is positioned on roads that may no longer exist.
      stopReplay()
      traffic = new TrafficSystem(graph, signals, { ...DEFAULT_TRAFFIC, seed: trafficSeed })
      pedestrians = new PedestrianSystem(graph, trafficSeed ^ 0x5f3759df)
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
  // A fresh seed per drive, so the traffic is reproducible within a drive but
  // not identical between drives — the same junction twice should not be the
  // same problem twice.
  trafficSeed = (trafficSeed * 1664525 + 1013904223) >>> 0
  traffic = new TrafficSystem(graph, signals, { ...DEFAULT_TRAFFIC, seed: trafficSeed })
  traffic.clearAround(state.x, state.y, 28)
  pedestrians = new PedestrianSystem(graph, trafficSeed ^ 0x5f3759df)
  recorder.begin(state, params, signals, FIXED_DT, trafficSeed)
}

/** The scenario being practised, or null for an ordinary drive round the town. */
let scenario: Scenario | null = null

/**
 * The handle a scenario is given on the world. Deliberately narrow: a scenario
 * says what the situation IS, and nothing about how the simulation runs.
 */
function scenarioWorld(): ScenarioWorld {
  return {
    graph,
    traffic,
    pedestrians,
    signals,
    placeCar(edgeId, s, options = {}) {
      const edge = graph.edges.get(edgeId)
      if (!edge) return
      const backwards = options.backwards ?? false
      const lane = backwards ? edge.lanes.length - 1 : 0
      const at = Math.max(0, Math.min(edge.length, s))
      const p = edgePoint(edge, at, edge.laneOffset(lane))
      const pose = sampleEdge(edge, at)
      Object.assign(state, createState(p.x, p.y, pose.heading + (backwards ? Math.PI : 0)))
      state.speed = (options.speedKmh ?? 0) / 3.6
    },
    add(kind, edgeId, direction, s, speedKmh) {
      traffic.spawn(kind, edgeId, direction, s, speedKmh / 3.6)
    },
    setSignal(nodeId, edgeId, aspect) {
      signals.get(nodeId)?.forceAspect(edgeId, aspect)
    },
    setPedestrian(edgeId, s, pedestrianState) {
      pedestrians.force(graph, edgeId, s, pedestrianState)
    },
  }
}

function startScenario(next: Scenario | null): void {
  stopReplay()
  report.hide()
  scenarioMenu.hide()
  scenario = next

  reset()
  if (next) {
    next.setUp(scenarioWorld())
    // The car has just been moved, so the recording has to start from where it
    // actually is rather than from wherever reset() left it.
    rules.reset()
    recorder.begin(state, params, signals, FIXED_DT, trafficSeed)
  }
  scenarioMenu.showBrief(next)
}

/**
 * Hand the car over to a recording. The live drive is parked rather than
 * discarded, so watching a fault back does not cost the driver their progress.
 */
function startReplay(seconds: number): void {
  const drive = recorder.finish()
  if (!drive) return
  if (!replay) {
    liveState = { ...state }
    liveTraffic = traffic
    livePedestrians = pedestrians
  }

  // The replay gets its own traffic, rebuilt from the seed the drive ran with
  // and stepped alongside the car from the very beginning — including through
  // the seek. Anything less and the car brakes for vehicles that are not there.
  replayTraffic = new TrafficSystem(graph, signals, { ...DEFAULT_TRAFFIC, seed: drive.trafficSeed })
  // Cleared around the same point as the live drive was, or the replay starts
  // with vehicles the drive never had.
  replayTraffic.clearAround(drive.start.x, drive.start.y, 28)
  replayPedestrians = new PedestrianSystem(graph, drive.trafficSeed ^ 0x5f3759df)
  restoreSignalPhases(drive, signals, 0)

  replay = new ReplaySession(drive, (replayedState, dt) => {
    if (replayTraffic && replayPedestrians) {
      stepWorld(replayTraffic, replayPedestrians, replayedState, dt)
    }
  })
  replay.seek(seconds)
  restoreSignalPhases(drive, signals, seconds)
  Object.assign(state, replay.state)
  if (replayTraffic) traffic = replayTraffic
  if (replayPedestrians) pedestrians = replayPedestrians
  report.hide()
}

function stopReplay(): void {
  if (!replay) return
  replay = null
  replayTraffic = null
  replayPedestrians = null
  if (liveTraffic) traffic = liveTraffic
  if (livePedestrians) pedestrians = livePedestrians
  liveTraffic = null
  livePedestrians = null
  if (liveState) {
    Object.assign(state, liveState)
    liveState = null
  }
}

function openReport(): void {
  stopReplay()
  report.show(rules, recorder.finish())
}

/**
 * The player, described the way the traffic model describes its own vehicles.
 * Returns null when the car is nowhere near a road, in which case the traffic
 * simply cannot see it — which is the honest answer.
 */
function playerObstacle(state: VehicleState): PlayerObstacle | null {
  const loc = graph.locate(state.x, state.y, state.heading)
  if (!loc) return null
  const direction: 1 | -1 = loc.withEdge ? 1 : -1
  const laneIndex = laneForTravel(loc.edge, direction)
  return {
    x: state.x,
    y: state.y,
    heading: state.heading,
    speed: state.speed,
    length: 4.2,
    width: 1.8,
    edgeId: loc.edge.id,
    direction,
    laneIndex: laneIndex >= 0 ? laneIndex : loc.laneIndex,
    s: loc.s,
  }
}

/**
 * What the rules are allowed to perceive. Built fresh each step from the live
 * traffic, so a rule can never hold on to a road user that has since moved on.
 */
function senses(
  state: VehicleState,
  trafficSystem: TrafficSystem,
  pedestrianSystem: PedestrianSystem,
): WorldSense | null {
  const player = playerObstacle(state)
  if (!player) return null

  return {
    leader: () => trafficSystem.leaderForPlayer(player),
    collisions: () => trafficSystem.collisionsWith(player).length,
    pedestrianAhead: (within) => {
      const edge = graph.edge(player.edgeId)
      let nearest: { distance: number; onCrossing: boolean } | null = null
      for (const crossing of edge.crossings) {
        const distance =
          player.direction === 1 ? crossing - player.s : player.s - crossing
        if (distance < 0 || distance > within) continue
        if (!pedestrianSystem.activeAt(edge.id, crossing)) continue
        const onCrossing = pedestrianSystem.people.some(
          (p) => p.edgeId === edge.id && p.s === crossing && p.state === 'crossing',
        )
        if (!nearest || distance < nearest.distance) nearest = { distance, onCrossing }
      }
      return nearest
    },
    mustGiveWay: () => {
      const loc = graph.locate(state.x, state.y, state.heading)
      if (!loc) return false
      // Anyone with priority heading for the same junction, close enough that
      // pulling out in front of them would make them brake.
      for (const user of trafficSystem.users) {
        if (user.edgeId === player.edgeId) continue
        const userEdge = graph.edge(user.edgeId)
        const userAhead = user.direction === 1 ? userEdge.to : userEdge.from
        if (userAhead !== loc.aheadNode) continue
        const distance =
          user.direction === 1 ? userEdge.length - user.s : user.s
        if (distance / Math.max(user.speed, 1.5) < 4) return true
        if (user.inJunction) return true
      }
      return false
    },
  }
}

/**
 * One step of the live drive. Factored out of the loop so that the dev hook
 * can advance the simulation without a frame — otherwise the only way to reach
 * a situation worth looking at is to sit there driving to it in real time.
 */
function stepSimulation(driver: DriverInput, dt: number): void {
  // Recorded before the step, so the input is paired with the state it acted on.
  recorder.record(driver, state)
  stepVehicle(state, driver, params, dt)
  for (const controller of signals.values()) controller.update(dt)
  stepWorld(traffic, pedestrians, state, dt)
  rules.update(state, driver, dt, senses(state, traffic, pedestrians))
}

/** Advance the other road users around a given car. */
function stepWorld(
  trafficSystem: TrafficSystem,
  pedestrianSystem: PedestrianSystem,
  around: VehicleState,
  dt: number,
): void {
  pedestrianSystem.update(graph, dt)
  trafficSystem.setBlockages(pedestrianSystem.blockages())
  trafficSystem.update(dt, playerObstacle(around))
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
      case 'toggleScenarios':
        if (scenarioMenu.isOpen) scenarioMenu.hide()
        else {
          report.hide()
          stopReplay()
          scenarioMenu.toggle()
        }
        break
      case 'toggleReport':
        if (report.isOpen) report.hide()
        else openReport()
        break
      case 'cancel':
        if (scenarioMenu.isOpen) scenarioMenu.hide()
        else if (replay) stopReplay()
        else if (report.isOpen) report.hide()
        else if (editor.isOpen) editor.toggle()
        break
      case 'reset':
        // Restarts the scenario being practised, not the whole town drive.
        startScenario(scenario)
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
  fixedDt: FIXED_DT,
  update(dt) {
    if (editor.isOpen || report.isOpen || scenarioMenu.isOpen) return

    if (replay) {
      // A replay is the recorded drive re-run, not a video: the same vehicle
      // model, the same inputs, the same lights.
      if (!replay.advance()) {
        stopReplay()
        return
      }
      Object.assign(state, replay.state)
      for (const controller of signals.values()) controller.update(dt)
      return
    }


    stepSimulation(input.sample(), dt)
  },
  render(frameDt) {
    handleActions()
    // The editor, the report and the scenario list all cover the viewport.
    if (editor.isOpen || report.isOpen || scenarioMenu.isOpen) return
    const driver = replay ? replay.input : input.driver

    replayBanner.hidden = !replay
    if (replay) {
      replayBanner.textContent =
        `REPLAY  ${replay.seconds.toFixed(1)}s of ${replay.totalSeconds.toFixed(1)}s` +
        `  ·  Esc to return to your drive`
    }

    car.setShellVisible(rig.currentMode !== 'bonnet')
    car.update(state, driver.brake > 0 || driver.handbrake, frameDt)
    car.group.updateMatrixWorld(true)
    rig.update(state, car)
    world.followSun(state.x, -state.y)

    for (const head of world.signalHeads) {
      const controller = signals.get(head.nodeId)
      if (controller) applyAspect(head, controller.aspectFor(head.edgeId))
    }
    trafficView.update(traffic)
    trafficView.updatePedestrians(pedestrians.people)
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
    scenarioMenu,
    startScenario,
    get scenario() {
      return scenario
    },
    get traffic() {
      return traffic
    },
    get pedestrians() {
      return pedestrians
    },
    recorder,
    report,
    openReport,
    startReplay,
    /** Run the live drive forward without waiting for frames. */
    advance(seconds: number, driver: Partial<DriverInput> = {}) {
      const d: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, ...driver }
      const steps = Math.round(seconds / FIXED_DT)
      for (let i = 0; i < steps; i++) stepSimulation(d, FIXED_DT)
    },
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
