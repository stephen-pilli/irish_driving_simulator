import { describe, expect, it } from 'vitest'
import type { DriverInput } from '../../input/input'
import { RulesEngine } from '../../rules/engine'
import { irishRules } from '../../rules/irish'
import { LaneGraph, edgePoint, sampleEdge } from '../../world/laneGraph'
import { createSignals } from '../../world/signals'
import { BALLYROAD, START } from '../../world/town'
import { DriveRecorder, replayDrive, restoreSignalPhases, stateAt } from '../recorder'
import { createState, DEFAULT_PARAMS, stepVehicle, type VehicleState } from '../vehicle'

const DT = 1 / 120

function startState(): VehicleState {
  const graph = new LaneGraph(BALLYROAD)
  const edge = graph.edge(START.edgeId)
  const p = edgePoint(edge, START.s, edge.laneOffset(0))
  const pose = sampleEdge(edge, START.s)
  return createState(p.x, p.y, pose.heading)
}

/** A drive with enough throttle, steering and braking to be worth replaying. */
function scriptedInput(step: number): DriverInput {
  const t = step * DT
  if (t < 6) return { throttle: 1, brake: 0, steer: 0, handbrake: false, indicator: 'off' }
  if (t < 9) return { throttle: 1, brake: 0, steer: 0.4, handbrake: false, indicator: 'off' }
  if (t < 12) return { throttle: 0, brake: 0, steer: -0.6, handbrake: false, indicator: 'off' }
  if (t < 15) return { throttle: 0.5, brake: 0, steer: 0, handbrake: false, indicator: 'off' }
  return { throttle: 0, brake: 1, steer: 0, handbrake: false, indicator: 'off' }
}

interface LiveRun {
  recorder: DriveRecorder
  rules: RulesEngine
  final: VehicleState
}

function driveLive(steps = 120 * 20): LiveRun {
  const graph = new LaneGraph(BALLYROAD)
  const signals = createSignals(graph)
  const rules = new RulesEngine(irishRules(), graph, signals)
  const state = startState()
  const recorder = new DriveRecorder()
  recorder.begin(state, DEFAULT_PARAMS, signals, DT)

  for (let step = 0; step < steps; step++) {
    const input = scriptedInput(step)
    recorder.record(input, state)
    stepVehicle(state, input, DEFAULT_PARAMS, DT)
    for (const controller of signals.values()) controller.update(DT)
    rules.update(state, input, DT)
  }

  return { recorder, rules, final: state }
}

describe('recording a drive', () => {
  it('stores input changes rather than one entry per step', () => {
    const { recorder } = driveLive()
    const drive = recorder.finish()!
    expect(drive.steps).toBe(2400)
    // Five scripted phases, so five frames. Anything near 2400 would mean the
    // run-length encoding is not working and a long drive would not fit.
    expect(drive.inputs).toHaveLength(5)
  })

  it('records nothing before a drive has begun', () => {
    expect(new DriveRecorder().finish()).toBeNull()
  })

  it('copies the parameters rather than referencing them', () => {
    const state = startState()
    const params = { ...DEFAULT_PARAMS }
    const recorder = new DriveRecorder()
    recorder.begin(state, params, new Map(), DT)
    recorder.record({ throttle: 1, brake: 0, steer: 0, handbrake: false, indicator: 'off' }, state)

    // The tuning panel mutates the live parameters in place mid-drive.
    params.maxAccel = 99
    expect(recorder.finish()!.params.maxAccel).toBe(DEFAULT_PARAMS.maxAccel)
  })

  it('samples the route for the report map', () => {
    const drive = driveLive().recorder.finish()!
    expect(drive.path.length).toBe(Math.ceil(drive.steps / drive.pathEvery))
    expect(drive.path[0]![0]).toBeCloseTo(startState().x, 6)
  })

  it('records gear changes, which input alone does not describe', () => {
    const state = startState()
    const recorder = new DriveRecorder()
    recorder.begin(state, DEFAULT_PARAMS, new Map(), DT)
    const idle: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, indicator: 'off' }

    recorder.record(idle, state)
    state.gear = 'R'
    recorder.record(idle, state)
    state.gear = 'D'
    recorder.record(idle, state)

    expect(recorder.finish()!.gears).toEqual([
      [1, 'R'],
      [2, 'D'],
    ])
  })
})

describe('replaying a drive', () => {
  it('reproduces the final position exactly', () => {
    const live = driveLive()
    const drive = live.recorder.finish()!
    const replayed = replayDrive(drive)

    expect(replayed.x).toBe(live.final.x)
    expect(replayed.y).toBe(live.final.y)
    expect(replayed.heading).toBe(live.final.heading)
    expect(replayed.speed).toBe(live.final.speed)
    expect(replayed.odometer).toBe(live.final.odometer)
  })

  it('reproduces every fault, with the same grades and timings', () => {
    const live = driveLive()
    const drive = live.recorder.finish()!

    const graph = new LaneGraph(BALLYROAD)
    const signals = createSignals(graph)
    restoreSignalPhases(drive, signals)
    const rules = new RulesEngine(irishRules(), graph, signals)

    replayDrive(drive, ({ state, input }) => {
      for (const controller of signals.values()) controller.update(drive.dt)
      rules.update(state, input, drive.dt)
    })

    expect(rules.faults.length).toBeGreaterThan(0)
    expect(rules.faults).toEqual(live.rules.faults)
    expect(rules.verdict()).toEqual(live.rules.verdict())
  })

  it('diverges if the lights are not put back where they started', () => {
    // Guards the reason restoreSignalPhases exists: without it a replay is not
    // evidence of anything, because the car can meet a different light.
    const drive = driveLive().recorder.finish()!
    const signals = createSignals(new LaneGraph(BALLYROAD))
    const node = [...signals.keys()][0]!

    restoreSignalPhases(drive, signals)
    const restored = signals.get(node)!.phaseSeconds
    signals.get(node)!.setPhaseSeconds(restored + 10)
    expect(signals.get(node)!.phaseSeconds).not.toBeCloseTo(restored, 6)

    restoreSignalPhases(drive, signals)
    expect(signals.get(node)!.phaseSeconds).toBeCloseTo(restored, 6)
  })

  it('does not disturb the recording it replays', () => {
    const drive = driveLive().recorder.finish()!
    const before = JSON.stringify(drive)
    replayDrive(drive)
    replayDrive(drive)
    expect(JSON.stringify(drive)).toBe(before)
  })

  it('replays twice to the same place', () => {
    const drive = driveLive().recorder.finish()!
    expect(replayDrive(drive)).toEqual(replayDrive(drive))
  })

  it('winds back to any moment in the drive', () => {
    const drive = driveLive().recorder.finish()!

    const atStart = stateAt(drive, 0)
    expect(atStart.x).toBeCloseTo(drive.start.x, 9)
    expect(atStart.speed).toBe(0)

    // Six seconds of full throttle, then the brake comes on at fifteen.
    const atSix = stateAt(drive, 6)
    const atTwenty = stateAt(drive, 20)
    expect(atSix.speed).toBeGreaterThan(10)
    expect(atTwenty.speed).toBeLessThan(atSix.speed)

    expect(stateAt(drive, 1e6)).toEqual(replayDrive(drive))
  })
})
