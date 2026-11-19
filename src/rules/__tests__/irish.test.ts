import { describe, expect, it } from 'vitest'
import { ScriptedDrive } from './harness'

describe('a clean drive', () => {
  it('records no faults when driven properly', () => {
    const drive = new ScriptedDrive()
      .place('main_e', 140, { laneIndex: 0, speedKmh: 45 })
      .run(5)
    expect(drive.faults).toEqual([])
    expect(drive.engine.verdict().passed).toBe(true)
  })
})

describe('speed limits', () => {
  it('marks a sustained excess as a grade 2 fault', () => {
    const drive = new ScriptedDrive()
      .place('main_e', 100, { laneIndex: 0, speedKmh: 70 })
      .run(4)

    const faults = drive.faultsOf('ie.speed.exceed-limit')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(2)
    expect(faults[0]!.message).toContain('50 km/h zone')
  })

  it('does not mark a momentary excess', () => {
    const drive = new ScriptedDrive()
      .place('main_e', 100, { laneIndex: 0, speedKmh: 58 })
      .run(1.2)
    expect(drive.faultsOf('ie.speed.exceed-limit')).toEqual([])
  })

  it('does not mark driving at the limit', () => {
    const drive = new ScriptedDrive()
      .place('main_e', 100, { laneIndex: 0, speedKmh: 50 })
      .run(6)
    expect(drive.faultsOf('ie.speed.exceed-limit')).toEqual([])
  })

  it('treats a large excess as dangerous', () => {
    const drive = new ScriptedDrive()
      .place('main_e', 100, { laneIndex: 0, speedKmh: 80 })
      .run(0.5)

    const faults = drive.faultsOf('ie.speed.exceed-limit')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(3)
    expect(drive.engine.verdict().passed).toBe(false)
  })

  it('reads the limit from the road, not from a global constant', () => {
    // The same 48 km/h means two different things: unremarkable on the 50
    // main street, and 60% over the limit on the 30 residential street.
    const main = new ScriptedDrive().place('main_e', 100, { laneIndex: 0, speedKmh: 48 }).run(4)
    expect(main.faultsOf('ie.speed.exceed-limit')).toEqual([])

    const residential = new ScriptedDrive()
      .place('residential', 100, { laneIndex: 0, speedKmh: 48 })
      .run(4)
    const faults = residential.faultsOf('ie.speed.exceed-limit')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(3)
    expect(faults[0]!.message).toContain('30 km/h zone')
  })
})

describe('road position', () => {
  it('marks sustained driving on the wrong side of the road', () => {
    const drive = new ScriptedDrive()
      .place('main_e', 100, { lateral: -1.75, speedKmh: 40 })
      .run(2.5)

    const faults = drive.faultsOf('ie.position.keep-left')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(2)
  })

  it('does not mark correct road position', () => {
    const drive = new ScriptedDrive()
      .place('main_e', 100, { lateral: 1.75, speedKmh: 40 })
      .run(5)
    expect(drive.faultsOf('ie.position.keep-left')).toEqual([])
  })

  it('marks leaving the carriageway', () => {
    const drive = new ScriptedDrive()
      .place('main_e', 100, { lateral: 6, speedKmh: 40 })
      .run(1.5)

    const faults = drive.faultsOf('ie.position.off-carriageway')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(2)
  })

  it('allows crossing the centre line where it is broken', () => {
    const drive = new ScriptedDrive()
      .place('main_e', 100, { lateral: -1.75, speedKmh: 40 })
      .run(1)
    expect(drive.faultsOf('ie.markings.continuous-white-line')).toEqual([])
  })

  it('treats crossing a continuous white line as dangerous', () => {
    const drive = new ScriptedDrive()
      .place('town_south', 120, { lateral: -1.75, speedKmh: 40 })
      .run(1)

    const faults = drive.faultsOf('ie.markings.continuous-white-line')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(3)
    expect(drive.engine.verdict().passed).toBe(false)
  })
})

describe('traffic lights', () => {
  it('fails a driver who crosses the stop line on red', () => {
    // At the start of the cycle the main street is green, so the side road
    // approaching the same junction is red.
    const drive = new ScriptedDrive()
      .place('town_south', 45, { speedKmh: 30, backwards: true })
      .runUntilPast(12)

    const faults = drive.faultsOf('ie.signals.obey')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(3)
    expect(faults[0]!.message).toContain('red light')
  })

  it('passes a driver who crosses on green', () => {
    const drive = new ScriptedDrive()
      .place('main_e', 45, { speedKmh: 30, backwards: true })
      .runUntilPast(12)
    expect(drive.faultsOf('ie.signals.obey')).toEqual([])
  })

  it('marks moving off on red and amber', () => {
    const drive = new ScriptedDrive()
    const controller = drive.signals.get('n_cross')!
    // Wind the cycle to the red+amber run-up for the side road.
    const groupSeconds = controller.cycleSeconds / 2
    controller.update(groupSeconds - 1)

    expect(controller.aspectFor('town_south')).toBe('redAmber')

    drive.place('town_south', 19, { speedKmh: 12, backwards: true }).run(0.2)
    const faults = drive.faultsOf('ie.signals.obey')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(2)
  })
})

describe('junction control', () => {
  it('fails a driver who rolls through a stop sign', () => {
    const drive = new ScriptedDrive()
      .place('town_south', 235, { laneIndex: 0, speedKmh: 30 })
      .runUntilPast(250)

    const faults = drive.faultsOf('ie.junction.stop-sign')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(3)
  })

  it('passes a driver who actually stops', () => {
    const drive = new ScriptedDrive().place('town_south', 235, { laneIndex: 0, speedKmh: 30 })
    drive.run(1.2) // roll up to the line
    drive.setSpeed(0).run(1.5) // come to rest
    drive.setSpeed(20).runUntilPast(250)

    expect(drive.faultsOf('ie.junction.stop-sign')).toEqual([])
  })

  it('marks entering a yield junction too fast to give way', () => {
    const drive = new ScriptedDrive()
      .place('north_link', 40, { speedKmh: 45, backwards: true })
      .runUntilPast(10)

    const faults = drive.faultsOf('ie.junction.yield-approach')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(2)
  })

  it('passes a driver who slows for a yield', () => {
    const drive = new ScriptedDrive()
      .place('north_link', 40, { speedKmh: 20, backwards: true })
      .runUntilPast(10)
    expect(drive.faultsOf('ie.junction.yield-approach')).toEqual([])
  })
})

describe('other road users', () => {
  it('marks following closer than two seconds', () => {
    const drive = new ScriptedDrive()
    drive.place('main_e', 40, { speedKmh: 50 })
    // 50 km/h is 13.9 m/s, so two seconds is 27.8 m and one second is 13.9 m.
    // Twenty metres sits between the two: serious, not dangerous.
    drive.world = { ...drive.world, leader: () => ({ gap: 20, speed: 13.9, kind: 'car' }) }
    drive.run(4)

    const faults = drive.faultsOf('ie.traffic.following-distance')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(2)
    expect(faults[0]!.message).toContain('1.4 seconds')
  })

  it('treats under one second as dangerous', () => {
    const drive = new ScriptedDrive()
    drive.place('main_e', 40, { speedKmh: 50 })
    drive.world = { ...drive.world, leader: () => ({ gap: 6, speed: 13.9, kind: 'car' }) }
    drive.run(4)
    expect(drive.faultsOf('ie.traffic.following-distance')[0]!.grade).toBe(3)
  })

  it('accepts a two-second gap', () => {
    const drive = new ScriptedDrive()
    drive.place('main_e', 40, { speedKmh: 50 })
    drive.world = { ...drive.world, leader: () => ({ gap: 40, speed: 13.9, kind: 'car' }) }
    drive.run(8)
    expect(drive.faultsOf('ie.traffic.following-distance')).toHaveLength(0)
  })

  it('does not mark closing up in stationary traffic', () => {
    const drive = new ScriptedDrive()
    drive.place('main_e', 40, { speedKmh: 4 })
    drive.world = { ...drive.world, leader: () => ({ gap: 2, speed: 0, kind: 'car' }) }
    drive.run(8)
    expect(drive.faultsOf('ie.traffic.following-distance')).toHaveLength(0)
  })

  it('marks a collision as dangerous', () => {
    const drive = new ScriptedDrive()
    drive.place('main_e', 40, { speedKmh: 30 })
    drive.world = { ...drive.world, collisions: () => 1 }
    drive.run(1)

    const faults = drive.faultsOf('ie.traffic.collision')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(3)
    expect(drive.engine.verdict().passed).toBe(false)
  })

  it('marks pulling out across traffic with priority', () => {
    const drive = new ScriptedDrive()
    drive.place('north_link', 150, { speedKmh: 25, backwards: true })
    drive.world = { ...drive.world, mustGiveWay: () => true }
    drive.runUntilPast(5, 30)

    const faults = drive.faultsOf('ie.junction.yield-approach')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(3)
    expect(faults[0]!.message).toContain('priority')
  })

  it('does not mark a yield junction when the road is clear', () => {
    const drive = new ScriptedDrive()
    drive.place('north_link', 150, { speedKmh: 25, backwards: true })
    drive.runUntilPast(5, 30)
    expect(drive.faultsOf('ie.junction.yield-approach')).toHaveLength(0)
  })

  it('marks driving at a pedestrian on a crossing', () => {
    const drive = new ScriptedDrive()
    drive.place('residential', 120, { speedKmh: 30 })
    drive.world = {
      ...drive.world,
      pedestrianAhead: () => ({ distance: 9, onCrossing: true }),
    }
    drive.run(1)

    const faults = drive.faultsOf('ie.pedestrian.crossing')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.grade).toBe(3)
  })

  it('marks not yielding to someone waiting, less severely', () => {
    const drive = new ScriptedDrive()
    drive.place('residential', 120, { speedKmh: 30 })
    drive.world = {
      ...drive.world,
      pedestrianAhead: () => ({ distance: 9, onCrossing: false }),
    }
    drive.run(1)
    expect(drive.faultsOf('ie.pedestrian.crossing')[0]!.grade).toBe(2)
  })

  it('does not mark a crossing the car can still stop short of', () => {
    const drive = new ScriptedDrive()
    drive.place('residential', 60, { speedKmh: 30 })
    drive.world = {
      ...drive.world,
      pedestrianAhead: () => ({ distance: 38, onCrossing: true }),
    }
    drive.run(1)
    expect(drive.faultsOf('ie.pedestrian.crossing')).toHaveLength(0)
  })

  it('does not mark a car already stopped at a crossing', () => {
    const drive = new ScriptedDrive()
    drive.place('residential', 120, { speedKmh: 0 })
    drive.world = {
      ...drive.world,
      pedestrianAhead: () => ({ distance: 3, onCrossing: true }),
    }
    drive.run(3)
    expect(drive.faultsOf('ie.pedestrian.crossing')).toHaveLength(0)
  })
})

describe('signals', () => {
  /**
   * Westbound on the main street, turning into the residential road.
   *
   * Facing west, north is on the RIGHT, so this is a right turn however much
   * "turning off the main road into a side street" sounds like a left one.
   * The stop line sits just inside the junction radius, so the approach has to
   * run past it rather than up to it.
   */
  function turnRightAtTheCrossroads(drive: ScriptedDrive): void {
    drive.place('main_e', 60, { speedKmh: 25, backwards: true })
    drive.runUntilPast(10, 20)
    drive.place('residential', 24, { speedKmh: 25 })
    drive.run(2)
  }

  it('marks turning without signalling', () => {
    const drive = new ScriptedDrive()
    turnRightAtTheCrossroads(drive)
    const faults = drive.faultsOf('ie.signals.use')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.message).toContain('without signalling')
    expect(faults[0]!.aspect).toBe('Signals')
  })

  it('accepts a correct signal', () => {
    const drive = new ScriptedDrive()
    drive.input.indicator = 'right'
    turnRightAtTheCrossroads(drive)
    expect(drive.faultsOf('ie.signals.use')).toHaveLength(0)
  })

  it('marks a misleading signal', () => {
    const drive = new ScriptedDrive()
    drive.input.indicator = 'left'
    turnRightAtTheCrossroads(drive)
    const faults = drive.faultsOf('ie.signals.use')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.message).toContain('Signalled left and turned right')
  })

  it('does not ask for a signal to follow the road straight on', () => {
    const drive = new ScriptedDrive()
    drive.place('main_e', 60, { speedKmh: 30, backwards: true })
    drive.runUntilPast(10, 20)
    drive.place('main_w', 300, { speedKmh: 30, backwards: true })
    drive.run(2)
    expect(drive.faultsOf('ie.signals.use')).toHaveLength(0)
  })

  it('marks an indicator left on down a long road', () => {
    const drive = new ScriptedDrive()
    drive.input.indicator = 'left'
    drive.place('regional', 20, { speedKmh: 60 })
    drive.run(24)
    expect(drive.faultsOf('ie.signals.use')[0]!.message).toContain('indicator on')
  })
})

describe('observation', () => {
  it('marks moving off with no mirrors and no look around', () => {
    const drive = new ScriptedDrive()
    drive.place('regional', 40, { speedKmh: 0 })
    drive.run(3)
    drive.setSpeed(12)
    drive.run(1)

    const faults = drive.faultsOf('ie.observation.checks')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.message).toContain('mirrors or looking around')
    expect(faults[0]!.aspect).toBe('Observation')
  })

  it('accepts moving off after a mirror check and a look around', () => {
    const drive = new ScriptedDrive()
    drive.place('regional', 40, { speedKmh: 0 })
    drive.run(3)
    drive.observations = { sinceMirror: 1, sinceLeftGlance: 99, sinceRightGlance: 1 }
    drive.setSpeed(12)
    drive.run(1)
    expect(drive.faultsOf('ie.observation.checks')).toHaveLength(0)
  })

  it('still marks moving off with mirrors but no look around', () => {
    const drive = new ScriptedDrive()
    drive.place('regional', 40, { speedKmh: 0 })
    drive.run(3)
    drive.observations = { sinceMirror: 1, sinceLeftGlance: 99, sinceRightGlance: 99 }
    drive.setSpeed(12)
    drive.run(1)
    expect(drive.faultsOf('ie.observation.checks')[0]!.message).toContain('blind spot')
  })

  it('marks turning at a junction without a mirror check', () => {
    const drive = new ScriptedDrive()
    drive.place('main_e', 60, { speedKmh: 25, backwards: true })
    drive.runUntilPast(10, 20)
    drive.place('residential', 24, { speedKmh: 25 })
    drive.run(2)
    expect(drive.faultsOf('ie.observation.checks')[0]!.message).toContain('without checking the mirrors')
  })

  it('accepts a turn made after a mirror check', () => {
    const drive = new ScriptedDrive()
    drive.observations = { sinceMirror: 2, sinceLeftGlance: 2, sinceRightGlance: 2 }
    drive.place('main_e', 60, { speedKmh: 25, backwards: true })
    drive.runUntilPast(10, 20)
    drive.place('residential', 24, { speedKmh: 25 })
    drive.run(2)
    expect(drive.faultsOf('ie.observation.checks')).toHaveLength(0)
  })
})
