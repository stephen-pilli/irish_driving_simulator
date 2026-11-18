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
