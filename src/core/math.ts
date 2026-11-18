export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export const DEG = Math.PI / 180
export const RAD = 180 / Math.PI

/** Move `current` toward `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current
  if (Math.abs(d) <= maxDelta) return target
  return current + Math.sign(d) * maxDelta
}

/** Frame-rate independent exponential smoothing. `halfLife` in seconds. */
export function smooth(current: number, target: number, halfLife: number, dt: number): number {
  if (halfLife <= 0) return target
  const t = 1 - Math.pow(0.5, dt / halfLife)
  return current + (target - current) * t
}

export const msToKmh = (ms: number): number => ms * 3.6
export const kmhToMs = (kmh: number): number => kmh / 3.6
