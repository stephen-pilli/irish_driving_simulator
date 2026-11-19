/**
 * On-screen controls, for driving without a keyboard.
 *
 * Steering is a strip rather than a pair of buttons. Two buttons give the same
 * on/off steering the arrow keys do, and on a trainer that is a real loss: the
 * whole point of the lane-position rules is judging a line, and you cannot
 * judge a line with a switch. A finger sliding along a strip gives the
 * proportional input a wheel would.
 *
 * Everything here feeds the ordinary input layer rather than the simulation,
 * so a touch drive records, replays and is graded exactly like any other.
 */

import type { Input } from '../input/input'

export class TouchControls {
  private readonly root: HTMLElement
  private readonly steerStrip: HTMLElement
  private readonly steerKnob: HTMLElement
  private steerPointer: number | null = null
  visible = false

  constructor(
    root: HTMLElement,
    private readonly input: Input,
  ) {
    this.root = root
    root.innerHTML = `
      <div class="touch-left">
        <div class="touch-strip" data-steer><i data-knob></i></div>
        <span class="touch-label">Steering</span>
      </div>
      <div class="touch-right">
        <div class="touch-row">
          <button class="touch-small" data-key="KeyR" data-tap>R</button>
          <button class="touch-small" data-key="Comma" data-tap>&#9664;</button>
          <button class="touch-small" data-key="Period" data-tap>&#9654;</button>
          <button class="touch-small" data-key="Digit1" data-tap>Mirror</button>
        </div>
        <div class="touch-row">
          <button class="touch-pedal brake" data-key="KeyS">Brake</button>
          <button class="touch-pedal" data-key="KeyW">Go</button>
        </div>
        <button class="touch-small wide" data-key="Space">Handbrake</button>
      </div>
    `
    this.steerStrip = root.querySelector('[data-steer]')!
    this.steerKnob = root.querySelector('[data-knob]')!
    this.root.hidden = true

    for (const button of root.querySelectorAll<HTMLElement>('[data-key]')) {
      const code = button.getAttribute('data-key')!
      const tap = button.hasAttribute('data-tap')

      button.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        button.setPointerCapture(e.pointerId)
        button.classList.add('held')
        if (tap) this.tap(code)
        else this.input.setVirtualKey(code, true)
      })
      const release = (): void => {
        button.classList.remove('held')
        if (!tap) this.input.setVirtualKey(code, false)
      }
      button.addEventListener('pointerup', release)
      button.addEventListener('pointercancel', release)
      button.addEventListener('pointerleave', release)
    }

    this.steerStrip.addEventListener('pointerdown', (e) => this.onSteer(e, true))
    this.steerStrip.addEventListener('pointermove', (e) => this.onSteer(e, false))
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      this.steerStrip.addEventListener(type, () => this.endSteer())
    }
  }

  /** Tap buttons map to the same one-shot actions the keyboard produces. */
  private tap(code: string): void {
    switch (code) {
      case 'KeyR':
        this.input.pushAction('toggleReverse')
        break
      case 'Comma':
        this.input.pushAction('indicateLeft')
        break
      case 'Period':
        this.input.pushAction('indicateRight')
        break
      case 'Digit1':
        this.input.pushAction('mirrorCheck')
        break
    }
  }

  private onSteer(e: PointerEvent, start: boolean): void {
    if (start) {
      this.steerPointer = e.pointerId
      this.steerStrip.setPointerCapture(e.pointerId)
    }
    if (this.steerPointer !== e.pointerId) return
    e.preventDefault()

    const rect = this.steerStrip.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / Math.max(rect.width, 1)
    // Left of centre steers left, which is positive in the simulation.
    const steer = Math.max(-1, Math.min(1, (0.5 - fraction) * 2))
    this.input.setVirtualSteer(steer)
    this.steerKnob.style.left = `${(1 - (steer + 1) / 2) * 100}%`
  }

  private endSteer(): void {
    this.steerPointer = null
    this.input.setVirtualSteer(null)
    this.steerKnob.style.left = '50%'
  }

  toggle(): boolean {
    this.visible = !this.visible
    this.root.hidden = !this.visible
    // The instruments have to move out of the way of a thumb, and the layout
    // for that lives in CSS rather than being computed here.
    document.body.classList.toggle('touch-on', this.visible)
    if (!this.visible) this.input.releaseVirtual()
    return this.visible
  }

  /** Shown automatically on anything with a touchscreen. */
  showIfTouch(): void {
    if (navigator.maxTouchPoints > 0 && !this.visible) this.toggle()
  }
}
