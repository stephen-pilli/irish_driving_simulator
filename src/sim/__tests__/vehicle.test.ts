import { describe, expect, it } from 'vitest'
import { followingSeconds, gripFor } from '../conditions'
import { DEG } from '../../core/math'
import type { DriverInput } from '../../input/input'
import {
  createState,
  DEFAULT_PARAMS,
  requestReverseToggle,
  stepVehicle,
  turningCircleDiameter,
  type VehicleParams,
  type VehicleState,
} from '../vehicle'

const DT = 1 / 120

const input = (over: Partial<DriverInput> = {}): DriverInput => ({
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  indicator: 'off',
  ...over,
})

/** Run the sim until `done`, or until `maxSeconds` elapse. Returns seconds taken. */
function run(
  s: VehicleState,
  i: DriverInput,
  done: (s: VehicleState) => boolean,
  maxSeconds = 60,
  p: VehicleParams = DEFAULT_PARAMS,
): number {
  let t = 0
  while (t < maxSeconds) {
    stepVehicle(s, i, p, DT)
    t += DT
    if (done(s)) return t
  }
  return t
}

const kmh = (s: VehicleState) => s.speed * 3.6

describe('longitudinal', () => {
  it('does not creep when stationary with no input', () => {
    const s = createState()
    run(s, input(), () => false, 3)
    expect(s.speed).toBe(0)
    expect(s.odometer).toBe(0)
  })

  it('reaches 100 km/h in a time appropriate to a driving-school car', () => {
    const s = createState()
    const t = run(s, input({ throttle: 1 }), (v) => kmh(v) >= 100)
    expect(t).toBeGreaterThan(9)
    expect(t).toBeLessThan(18)
  })

  it('brakes to a stop within the quoted grip budget, not beyond it', () => {
    // Stopping distances are taught material, so the sim must not flatter them
    // by stacking engine braking and drag on top of the tyres' limit.
    for (const speed of [50, 80, 100]) {
      const s = createState()
      run(s, input({ throttle: 1 }), (v) => kmh(v) >= speed)
      const start = s.odometer
      run(s, input({ brake: 1 }), (v) => v.speed <= 0)

      const distance = s.odometer - start
      const theoretical = Math.pow(speed / 3.6, 2) / (2 * DEFAULT_PARAMS.maxBrakeDecel)
      expect(distance).toBeLessThanOrEqual(theoretical * 1.02)
      expect(distance).toBeGreaterThan(theoretical * 0.9)
    }
  })

  it('comes to rest under braking without rolling backwards', () => {
    const s = createState()
    run(s, input({ throttle: 1 }), (v) => kmh(v) >= 30)
    run(s, input({ brake: 1 }), () => false, 10)
    expect(s.speed).toBe(0)
  })

  it('coasts to a stop on engine braking and drag alone', () => {
    const s = createState()
    run(s, input({ throttle: 1 }), (v) => kmh(v) >= 50)
    const t = run(s, input(), (v) => v.speed <= 0, 120)
    expect(s.speed).toBe(0)
    // Far longer than braking, but not indefinite.
    expect(t).toBeGreaterThan(10)
  })
})

describe('steering', () => {
  it('traces the geometric turning radius at manoeuvring speed', () => {
    const s = createState()
    const i = input({ throttle: 0.18, steer: 1 })
    run(s, i, (v) => Math.abs(v.steer) >= DEFAULT_PARAMS.maxSteerDeg * DEG - 1e-6 && kmh(v) > 6, 12)

    const expected = DEFAULT_PARAMS.wheelbase / Math.tan(Math.abs(s.steer))
    const actual = Math.abs(s.speed / s.yawRate)
    expect(s.atGripLimit).toBe(false)
    expect(actual).toBeCloseTo(expected, 1)
  })

  it('quotes a kerb-to-kerb circle matching a real small hatchback', () => {
    // A VW Golf is about 10.9 m; anything near 7 m would mean we were
    // measuring the rear axle rather than the outer front wheel.
    expect(turningCircleDiameter(DEFAULT_PARAMS)).toBeGreaterThan(10)
    expect(turningCircleDiameter(DEFAULT_PARAMS)).toBeLessThan(12)
  })

  it('understeers instead of pivoting when grip runs out', () => {
    const s = createState()
    run(s, input({ throttle: 1 }), (v) => kmh(v) >= 90)
    // Hold the lock on long enough for the wheel to actually reach it, or the
    // comparison below is made against a steering angle of nearly zero.
    run(s, input({ throttle: 0.35, steer: 1 }), () => false, 2)

    expect(s.atGripLimit).toBe(true)
    expect(Math.abs(s.latAccel)).toBeLessThanOrEqual(DEFAULT_PARAMS.maxLatAccel + 1e-6)

    const actual = Math.abs(s.speed / s.yawRate)
    const unlimited = DEFAULT_PARAMS.wheelbase / Math.tan(Math.abs(s.steer))
    expect(actual).toBeGreaterThan(unlimited * 5)
  })

  it('self-centres the wheel when the steering is released', () => {
    const s = createState()
    run(s, input({ throttle: 0.3, steer: 1 }), (v) => Math.abs(v.steer) > 0.4, 5)
    run(s, input({ throttle: 0.3 }), (v) => v.steer === 0, 3)
    expect(s.steer).toBe(0)
  })
})

describe('gearbox', () => {
  it('refuses to shift between drive and reverse while moving', () => {
    const s = createState()
    run(s, input({ throttle: 1 }), (v) => kmh(v) >= 20)
    expect(requestReverseToggle(s)).toBe(false)
    expect(s.gear).toBe('D')

    run(s, input({ brake: 1 }), (v) => v.speed <= 0)
    expect(requestReverseToggle(s)).toBe(true)
    expect(s.gear).toBe('R')
  })

  it('caps reverse at a manoeuvring speed and still steers', () => {
    const s = createState()
    requestReverseToggle(s)
    run(s, input({ throttle: 1, steer: 1 }), () => false, 12)

    expect(s.speed).toBeLessThan(0)
    expect(Math.abs(kmh(s))).toBeLessThanOrEqual(DEFAULT_PARAMS.maxReverseKmh + 0.01)
    // Reversing with left lock must swing the tail the opposite way.
    expect(s.yawRate).toBeLessThan(0)
  })

  it('coasts in neutral without driving', () => {
    const s = createState()
    s.gear = 'N'
    run(s, input({ throttle: 1 }), () => false, 5)
    expect(s.speed).toBe(0)
  })
})

describe('determinism', () => {
  it('produces an identical trajectory for identical inputs', () => {
    const drive = (): VehicleState => {
      const s = createState(10, -5, 0.7)
      const i = input({ throttle: 0.8, steer: 0.4 })
      run(s, i, () => false, 20)
      return s
    }
    const a = drive()
    const b = drive()
    expect(a).toEqual(b)
  })
})

describe('slopes', () => {
  const dt = 1 / 120
  const idle: DriverInput = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
    indicator: 'off',
  }

  /** Run the model on a constant gradient and return the final state. */
  function onSlope(
    gradient: number,
    input: DriverInput,
    seconds: number,
    start: Partial<VehicleState> = {},
  ): VehicleState {
    const state = { ...createState(), ...start }
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      stepVehicle(state, input, DEFAULT_PARAMS, dt, gradient)
    }
    return state
  }

  it('behaves exactly as before on the flat', () => {
    const withArg = onSlope(0, { ...idle, throttle: 1 }, 6)
    const state = createState()
    for (let i = 0; i < Math.round(6 / dt); i++) {
      stepVehicle(state, { ...idle, throttle: 1 }, DEFAULT_PARAMS, dt)
    }
    expect(withArg.speed).toBeCloseTo(state.speed, 12)
    expect(withArg.x).toBeCloseTo(state.x, 12)
  })

  it('rolls back on a hill when nothing is holding it', () => {
    const state = onSlope(0.1, idle, 3)
    // Gravity along a 10% slope is about 0.98 m/s^2, less rolling resistance
    // and what engine braking is left at these speeds.
    expect(state.speed).toBeLessThan(-1)
    expect(state.speed).toBeGreaterThan(-3)
  })

  it('is held by the handbrake on a hill', () => {
    const state = onSlope(0.12, { ...idle, handbrake: true }, 5)
    expect(state.speed).toBe(0)
    expect(state.x).toBe(0)
  })

  it('is held by the footbrake on a hill', () => {
    const state = onSlope(0.12, { ...idle, brake: 1 }, 5)
    expect(state.speed).toBe(0)
  })

  it('stays put on a gradient too shallow to overcome rolling resistance', () => {
    // Rolling resistance is 0.15 m/s^2, which is about a 1.5% slope.
    const state = onSlope(0.01, idle, 8)
    expect(state.speed).toBe(0)
  })

  it('climbs more slowly than it accelerates on the flat', () => {
    const flat = onSlope(0, { ...idle, throttle: 1 }, 8)
    const hill = onSlope(0.1, { ...idle, throttle: 1 }, 8)
    expect(hill.speed).toBeLessThan(flat.speed)
    expect(hill.speed).toBeGreaterThan(0)
  })

  it('rolls back before the engine catches, which is what a hill start is', () => {
    // Handbrake released on a 10% gradient with not quite enough throttle to
    // hold it, then more. Gravity is 0.98 m/s^2 here and a fifth of throttle
    // is 0.72, so the car goes backwards first and forwards afterwards.
    const state = createState()
    let lowest = 0
    for (let i = 0; i < Math.round(1.5 / dt); i++) {
      stepVehicle(state, { ...idle, throttle: 0.2 }, DEFAULT_PARAMS, dt, 0.1)
      lowest = Math.min(lowest, state.x)
    }
    expect(lowest).toBeLessThan(-0.05)
    expect(state.speed).toBeLessThan(0)

    for (let i = 0; i < Math.round(2 / dt); i++) {
      stepVehicle(state, { ...idle, throttle: 0.9 }, DEFAULT_PARAMS, dt, 0.1)
    }
    expect(state.speed).toBeGreaterThan(1)
  })

  it('runs away downhill out of gear', () => {
    // In neutral there is no engine braking to hold it, which is exactly why
    // coasting down a hill out of gear is the thing you are told not to do.
    const state = onSlope(-0.08, idle, 20, { gear: 'N' })
    expect(state.speed).toBeGreaterThan(5)
  })

  it('is held back by engine braking downhill in gear', () => {
    const inGear = onSlope(-0.08, idle, 20)
    const neutral = onSlope(-0.08, idle, 20, { gear: 'N' })
    expect(inGear.speed).toBeLessThan(neutral.speed)
  })
})

describe('grip', () => {
  const dt = 1 / 120

  /** Distance to stop from `kmh` with a given grip fraction. */
  function stoppingDistance(kmh: number, grip: number): number {
    const state = createState()
    state.speed = kmh / 3.6
    const start = state.x
    for (let i = 0; i < 120 * 20 && state.speed > 0; i++) {
      stepVehicle(state, input({ brake: 1 }), DEFAULT_PARAMS, dt, 0, grip)
    }
    return state.x - start
  }

  it('leaves dry braking exactly as it was', () => {
    expect(stoppingDistance(100, 1)).toBeCloseTo(stoppingDistance(100, 1), 10)
    // The documented dry figure.
    expect(stoppingDistance(100, 1)).toBeGreaterThan(40)
    expect(stoppingDistance(100, 1)).toBeLessThan(46)
  })

  it('stretches wet braking by about half', () => {
    const dry = stoppingDistance(100, 1)
    const wet = stoppingDistance(100, gripFor({ night: false, rain: 1 }))
    expect(wet / dry).toBeGreaterThan(1.3)
    expect(wet / dry).toBeLessThan(1.6)
  })

  it('lowers the cornering limit in the wet', () => {
    const corner = (grip: number): number => {
      const state = createState()
      state.speed = 22
      for (let i = 0; i < 120 * 3; i++) {
        stepVehicle(state, input({ steer: 1 }), DEFAULT_PARAMS, dt, 0, grip)
      }
      return Math.abs(state.latAccel)
    }
    expect(corner(0.7)).toBeLessThan(corner(1) - 1)
  })

  it('asks for four seconds of gap in the wet and two in the dry', () => {
    expect(followingSeconds({ night: false, rain: 0 })).toBe(2)
    expect(followingSeconds({ night: true, rain: 0 })).toBe(2)
    expect(followingSeconds({ night: false, rain: 0.8 })).toBe(4)
  })
})
