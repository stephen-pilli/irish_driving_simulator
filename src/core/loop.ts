export interface LoopHandle {
  stop(): void
  /** Smoothed frames per second. */
  readonly fps: number
}

export interface LoopOptions {
  /** Fixed simulation step in seconds. */
  fixedDt: number
  /** Advance the simulation by exactly `fixedDt`. May be called 0..n times per frame. */
  update(dt: number): void
  /** Draw a frame. `frameDt` is real elapsed wall time since the last frame. */
  render(frameDt: number): void
  /** Safety valve: never run more than this many sim steps in one frame. */
  maxSubSteps?: number
}

/**
 * Fixed-timestep simulation with a decoupled render. Keeping the sim on a fixed
 * step is what makes the vehicle model deterministic, which later buys us free
 * replay and headless rule tests.
 */
export function startLoop(opts: LoopOptions): LoopHandle {
  const maxSubSteps = opts.maxSubSteps ?? 8
  let accumulator = 0
  let last = performance.now()
  let raf = 0
  let running = true
  let fps = 60

  const frame = (now: number) => {
    if (!running) return
    raf = requestAnimationFrame(frame)

    // Clamp: a backgrounded tab or a stall must not produce a huge catch-up burst.
    const frameDt = Math.min((now - last) / 1000, 0.25)
    last = now
    fps += (1 / Math.max(frameDt, 1e-4) - fps) * 0.1

    accumulator += frameDt
    let steps = 0
    while (accumulator >= opts.fixedDt && steps < maxSubSteps) {
      opts.update(opts.fixedDt)
      accumulator -= opts.fixedDt
      steps++
    }
    if (steps === maxSubSteps) accumulator = 0

    opts.render(frameDt)
  }

  raf = requestAnimationFrame(frame)

  return {
    stop() {
      running = false
      cancelAnimationFrame(raf)
    },
    get fps() {
      return fps
    },
  }
}
