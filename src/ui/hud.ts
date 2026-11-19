import { RAD } from '../core/math'
import type { CameraMode } from '../render/cameras'
import type { Fault, Verdict } from '../rules/types'
import type { Gear } from '../sim/vehicle'

export interface HudInfo {
  speedKmh: number
  speedLimit: number | null
  gear: Gear
  throttle: number
  brake: number
  handbrake: boolean
  parkBrake: boolean
  steerRad: number
  latAccel: number
  longAccel: number
  atGripLimit: boolean
  fps: number
  odometerKm: number
  camera: CameraMode
  audio: boolean
  faults: Fault[]
  verdict: Verdict
}

const G = 9.81
const MAX_VISIBLE_FAULTS = 6

export class Hud {
  private readonly speed: HTMLElement
  private readonly limit: HTMLElement
  private readonly gear: HTMLElement
  private readonly bars: Record<'throttle' | 'brake' | 'steer', HTMLElement>
  private readonly grip: HTMLElement
  private readonly stats: HTMLElement
  private readonly faultList: HTMLElement
  private readonly tally: HTMLElement
  private renderedFaults = 0

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hud-cluster">
        <div class="hud-limit" data-limit-wrap><span data-limit>—</span></div>
        <div class="hud-speed"><span data-speed>0</span><small>km/h</small></div>
        <div class="hud-gear" data-gear>D</div>
        <div class="hud-pedals">
          <div class="hud-bar"><label>Throttle</label><div class="hud-track"><i data-throttle></i></div></div>
          <div class="hud-bar"><label>Brake</label><div class="hud-track brake"><i data-brake></i></div></div>
          <div class="hud-bar"><label>Steering</label><div class="hud-track centred"><i data-steer></i></div></div>
        </div>
        <div class="hud-grip" data-grip></div>
      </div>
      <div class="hud-stats" data-stats></div>
      <div class="hud-report">
        <header><strong>Test report</strong><span data-tally></span></header>
        <ol data-faults></ol>
      </div>
    `
    this.speed = root.querySelector('[data-speed]')!
    this.limit = root.querySelector('[data-limit]')!
    this.gear = root.querySelector('[data-gear]')!
    this.bars = {
      throttle: root.querySelector('[data-throttle]')!,
      brake: root.querySelector('[data-brake]')!,
      steer: root.querySelector('[data-steer]')!,
    }
    this.grip = root.querySelector('[data-grip]')!
    this.stats = root.querySelector('[data-stats]')!
    this.faultList = root.querySelector('[data-faults]')!
    this.tally = root.querySelector('[data-tally]')!
  }

  update(info: HudInfo): void {
    this.speed.textContent = Math.abs(Math.round(info.speedKmh)).toString()
    this.limit.textContent = info.speedLimit === null ? '—' : String(info.speedLimit)

    // Turn the roundel red once the driver is meaningfully over the limit.
    const over = info.speedLimit !== null && info.speedKmh > info.speedLimit + 5
    this.limit.parentElement?.classList.toggle('over', over)

    const held = info.handbrake || info.parkBrake
    this.gear.textContent = held ? 'P' : info.gear
    this.gear.classList.toggle('warn', held)

    this.bars.throttle.style.width = `${info.throttle * 100}%`
    this.bars.brake.style.width = `${info.brake * 100}%`
    const steerPct = (info.steerRad * RAD) / 34
    this.bars.steer.style.width = `${Math.abs(steerPct) * 50}%`
    this.bars.steer.style.left = steerPct < 0 ? '50%' : `${50 - Math.abs(steerPct) * 50}%`

    const latG = Math.abs(info.latAccel) / G
    this.grip.textContent = info.atGripLimit
      ? `GRIP LIMIT — ${latG.toFixed(2)} g lateral`
      : `${latG.toFixed(2)} g lateral`
    this.grip.classList.toggle('alert', info.atGripLimit)

    this.stats.textContent = [
      `${info.fps.toFixed(0)} fps`,
      `${info.odometerKm.toFixed(2)} km`,
      `cam: ${info.camera}`,
      `sound: ${info.audio ? 'on' : 'off'}`,
    ].join('   ·   ')

    this.updateReport(info)
  }

  /** Only touches the DOM when a fault is actually added. */
  private updateReport(info: HudInfo): void {
    const { verdict, faults } = info
    this.tally.textContent = verdict.passed
      ? `${verdict.grade2} grade 2 · ${verdict.grade3} grade 3`
      : 'FAILED'
    this.tally.classList.toggle('failed', !verdict.passed)

    if (faults.length === this.renderedFaults) return
    this.renderedFaults = faults.length

    const recent = faults.slice(-MAX_VISIBLE_FAULTS).reverse()
    this.faultList.replaceChildren(
      ...recent.map((fault) => {
        const li = document.createElement('li')
        li.className = `fault grade-${fault.grade}`
        const minutes = Math.floor(fault.t / 60)
        const seconds = Math.floor(fault.t % 60)
        li.innerHTML =
          `<b>G${fault.grade}</b>` +
          `<span>${fault.message}</span>` +
          `<em>${minutes}:${seconds.toString().padStart(2, '0')}</em>`
        return li
      }),
    )
  }
}
