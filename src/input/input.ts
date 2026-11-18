import { clamp } from '../core/math'

export type Action =
  | 'toggleReverse'
  | 'selectNeutral'
  | 'cycleCamera'
  | 'toggleTuner'
  | 'toggleEditor'
  | 'toggleAudio'
  | 'toggleReport'
  | 'cancel'
  | 'reset'

export interface DriverInput {
  /** 0..1 */
  throttle: number
  /** 0..1 */
  brake: number
  /** -1 (full right) .. +1 (full left) */
  steer: number
  handbrake: boolean
}

const KEY_ACTIONS: Record<string, Action> = {
  KeyR: 'toggleReverse',
  KeyN: 'selectNeutral',
  KeyC: 'cycleCamera',
  KeyT: 'toggleTuner',
  KeyE: 'toggleEditor',
  KeyM: 'toggleAudio',
  Enter: 'toggleReport',
  Escape: 'cancel',
  Backspace: 'reset',
}

const DEADZONE = 0.12

/**
 * Key events coming from a form field belong to that field, not to the car.
 * Without this, typing a speed limit into the editor panel would also toggle
 * reverse, change camera and close the editor.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

function applyDeadzone(v: number): number {
  const a = Math.abs(v)
  if (a < DEADZONE) return 0
  return Math.sign(v) * ((a - DEADZONE) / (1 - DEADZONE))
}

/**
 * Keyboard + Gamepad driver input. Produces raw targets only — the rate at
 * which the steering wheel actually turns is a property of the car, not the
 * input device, so that lives in the vehicle model.
 */
export class Input {
  readonly driver: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false }
  private readonly down = new Set<string>()
  private readonly pending: Action[] = []
  private gamepadConnected = false

  constructor(private readonly target: EventTarget = window) {
    this.target.addEventListener('keydown', this.onKeyDown as EventListener)
    this.target.addEventListener('keyup', this.onKeyUp as EventListener)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('gamepadconnected', this.onGamepad)
    window.addEventListener('gamepaddisconnected', this.onGamepad)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (isTypingTarget(e.target)) return
    // Stop Backspace navigating back and the arrow keys scrolling the page.
    if (e.code === 'Backspace' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
    if (!e.repeat) {
      const action = KEY_ACTIONS[e.code]
      if (action) this.pending.push(action)
    }
    this.down.add(e.code)
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code)
  }

  /** Losing focus mid-corner must not leave the throttle stuck on. */
  private onBlur = (): void => {
    this.down.clear()
  }

  private onGamepad = (): void => {
    this.gamepadConnected = navigator.getGamepads().some((g) => g !== null)
  }

  private held(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c))
  }

  /** Drain the edge-triggered actions queued since the last call. */
  consumeActions(): Action[] {
    if (this.pending.length === 0) return []
    return this.pending.splice(0, this.pending.length)
  }

  sample(): DriverInput {
    const d = this.driver
    d.throttle = this.held('KeyW', 'ArrowUp') ? 1 : 0
    d.brake = this.held('KeyS', 'ArrowDown') ? 1 : 0
    d.steer = (this.held('KeyA', 'ArrowLeft') ? 1 : 0) - (this.held('KeyD', 'ArrowRight') ? 1 : 0)
    d.handbrake = this.held('Space')

    if (this.gamepadConnected) this.mixGamepad(d)

    d.throttle = clamp(d.throttle, 0, 1)
    d.brake = clamp(d.brake, 0, 1)
    d.steer = clamp(d.steer, -1, 1)
    return d
  }

  /** Analog input wins where present, so a wheel or pad overrides the keys. */
  private mixGamepad(d: DriverInput): void {
    const pad = navigator.getGamepads().find((g) => g !== null && g.connected)
    if (!pad) return

    const steerAxis = applyDeadzone(pad.axes[0] ?? 0)
    if (steerAxis !== 0) d.steer = -steerAxis

    const rt = pad.buttons[7]?.value ?? 0
    const lt = pad.buttons[6]?.value ?? 0
    if (rt > 0.02) d.throttle = rt
    if (lt > 0.02) d.brake = lt
    if (pad.buttons[0]?.pressed) d.handbrake = true
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown as EventListener)
    this.target.removeEventListener('keyup', this.onKeyUp as EventListener)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('gamepadconnected', this.onGamepad)
    window.removeEventListener('gamepaddisconnected', this.onGamepad)
  }
}
