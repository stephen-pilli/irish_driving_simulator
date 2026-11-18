import { clamp } from '../core/math'

/** Rough gearbox, as km/h bands. Only used to shape the engine note. */
const GEAR_BANDS: Array<[number, number]> = [
  [0, 24],
  [16, 48],
  [38, 78],
  [66, 112],
  [98, 170],
]

/**
 * Synthesised engine and wind noise. No samples, no assets — just enough of an
 * aural speed cue that the handling can be judged honestly, since a silent car
 * always feels slower than it is.
 */
export class EngineAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private osc1: OscillatorNode | null = null
  private osc2: OscillatorNode | null = null
  private engineFilter: BiquadFilterNode | null = null
  private engineGain: GainNode | null = null
  private windGain: GainNode | null = null
  private windFilter: BiquadFilterNode | null = null
  private enabled = false

  get isEnabled(): boolean {
    return this.enabled
  }

  /** Must be called from a user gesture, or the context stays suspended. */
  toggle(): boolean {
    if (!this.ctx) this.build()
    this.enabled = !this.enabled
    if (this.ctx) {
      if (this.enabled) void this.ctx.resume()
      const now = this.ctx.currentTime
      this.master?.gain.setTargetAtTime(this.enabled ? 1 : 0, now, 0.05)
    }
    return this.enabled
  }

  private build(): void {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    this.ctx = ctx

    this.master = ctx.createGain()
    this.master.gain.value = 0
    this.master.connect(ctx.destination)

    // Engine: two detuned saws through a moving low-pass.
    this.engineGain = ctx.createGain()
    this.engineGain.gain.value = 0.0
    this.engineFilter = ctx.createBiquadFilter()
    this.engineFilter.type = 'lowpass'
    this.engineFilter.frequency.value = 500
    this.engineFilter.Q.value = 2
    this.engineGain.connect(this.engineFilter).connect(this.master)

    this.osc1 = ctx.createOscillator()
    this.osc1.type = 'sawtooth'
    this.osc2 = ctx.createOscillator()
    this.osc2.type = 'square'
    this.osc2.detune.value = -1198
    this.osc1.connect(this.engineGain)
    this.osc2.connect(this.engineGain)
    this.osc1.start()
    this.osc2.start()

    // Wind / road: band-passed white noise, driven by speed alone.
    const seconds = 2
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    const noise = ctx.createBufferSource()
    noise.buffer = buffer
    noise.loop = true
    this.windFilter = ctx.createBiquadFilter()
    this.windFilter.type = 'bandpass'
    this.windFilter.frequency.value = 600
    this.windFilter.Q.value = 0.7
    this.windGain = ctx.createGain()
    this.windGain.gain.value = 0
    noise.connect(this.windFilter).connect(this.windGain).connect(this.master)
    noise.start()
  }

  update(speedKmh: number, throttle: number): void {
    if (!this.ctx || !this.enabled || !this.osc1 || !this.osc2) return
    const now = this.ctx.currentTime
    const speed = Math.abs(speedKmh)

    let band = GEAR_BANDS[GEAR_BANDS.length - 1]!
    for (const candidate of GEAR_BANDS) {
      if (speed <= candidate[1]) {
        band = candidate
        break
      }
    }
    const frac = clamp((speed - band[0]) / Math.max(band[1] - band[0], 1), 0, 1)
    const rpm = 850 + frac * 5000
    const freq = rpm / 28

    this.osc1.frequency.setTargetAtTime(freq, now, 0.06)
    this.osc2.frequency.setTargetAtTime(freq, now, 0.06)
    this.engineFilter?.frequency.setTargetAtTime(380 + throttle * 2400 + frac * 900, now, 0.08)
    this.engineGain?.gain.setTargetAtTime(0.028 + throttle * 0.05, now, 0.08)

    const windLevel = clamp((speed - 18) / 110, 0, 1)
    this.windGain?.gain.setTargetAtTime(windLevel * 0.1, now, 0.15)
    this.windFilter?.frequency.setTargetAtTime(420 + windLevel * 1100, now, 0.2)
  }
}
