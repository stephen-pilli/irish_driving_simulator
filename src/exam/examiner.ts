/**
 * The examiner: gives the directions, and decides when the route is done.
 *
 * Directions arrive twice — a warning far enough out to act on, and a
 * reminder at the junction — because that is how they are given on a test and
 * because a single prompt is either too early to remember or too late to use.
 *
 * Speech is optional and best-effort. The browser's speech synthesiser is not
 * available everywhere, needs a user gesture on some platforms, and reads
 * road names badly; the text on screen is the real channel and the voice is a
 * convenience on top of it.
 */

import { mulberry32 } from '../core/rng'
import type { LaneGraph, Localisation } from '../world/laneGraph'
import { stopLineAhead } from '../world/laneGraph'
import { instructionText, planRoute, RouteProgress } from './route'

/** Distance at which the direction is first given. */
const WARN_METRES = 75
/** Distance at which it is repeated. */
const REMIND_METRES = 22

export interface ExaminerPrompt {
  text: string
  /** Seconds since the prompt was given, for fading it out. */
  age: number
}

export class Examiner {
  readonly progress: RouteProgress
  prompt: ExaminerPrompt | null = null
  finished = false
  private readonly rand: () => number
  private warnedFor: string | null = null
  private remindedFor: string | null = null
  private speak = true

  constructor(
    private readonly graph: LaneGraph,
    startEdgeId: string,
    towardsNode: string,
    legs = 10,
    seed = 4242,
  ) {
    this.rand = mulberry32(seed)
    this.progress = new RouteProgress(graph, planRoute(graph, startEdgeId, towardsNode, legs, this.rand))
  }

  setVoice(on: boolean): void {
    this.speak = on
    if (!on) globalThis.speechSynthesis?.cancel()
  }

  get voiceOn(): boolean {
    return this.speak
  }

  /** Legs still to drive. */
  get remaining(): number {
    return this.progress.remaining
  }

  update(loc: Localisation | null, dt: number): void {
    if (this.prompt) this.prompt.age += dt
    if (this.finished || !loc) return

    const changed = this.progress.update(loc.edge.id, this.rand)
    if (changed) {
      this.warnedFor = null
      this.remindedFor = null
    }

    const leg = this.progress.leg
    const instruction = leg?.instruction
    if (!leg || !instruction) return

    // Distance to the junction this instruction is about.
    const line = stopLineAhead(loc, this.graph)
    const distance = line ? line.distance : loc.distanceToEnd

    const key = `${leg.edgeId}:${instruction.kind}`
    if (distance <= WARN_METRES && distance > REMIND_METRES && this.warnedFor !== key) {
      this.warnedFor = key
      this.say(instructionText(instruction, true))
    } else if (distance <= REMIND_METRES && distance > -4 && this.remindedFor !== key) {
      this.remindedFor = key
      this.say(instructionText(instruction, false))
    }

    if (instruction.kind === 'finish' && distance <= 0) this.finished = true
  }

  /** The route is over once the car has stopped at the end of the last leg. */
  checkFinish(speedKmh: number): boolean {
    if (!this.finished) return false
    return speedKmh < 1
  }

  private say(text: string): void {
    this.prompt = { text, age: 0 }
    if (!this.speak) return
    try {
      const synth = globalThis.speechSynthesis
      if (!synth) return
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = 1.02
      utterance.pitch = 1
      // Prefer an Irish or British voice if the platform has one; the default
      // American voice reads "yield" and road numbers oddly.
      const voices = synth.getVoices()
      const preferred =
        voices.find((v) => v.lang === 'en-IE') ??
        voices.find((v) => v.lang === 'en-GB') ??
        voices.find((v) => v.lang.startsWith('en'))
      if (preferred) utterance.voice = preferred
      synth.cancel()
      synth.speak(utterance)
    } catch {
      /* speech is a convenience; the text on screen is the real channel */
    }
  }
}
