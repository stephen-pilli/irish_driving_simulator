/**
 * Light and weather, and what they change.
 *
 * Not decoration. A wet road is the single biggest change to the numbers a
 * driver is supposed to have internalised: grip falls, so stopping distances
 * grow, and the two-second rule becomes four. Teaching those figures only in
 * the dry would be teaching half of them.
 *
 * Night is less about physics and more about what can be seen, which is the
 * other half of the same point.
 */

export interface Conditions {
  night: boolean
  /** 0 is dry, 1 is heavy rain. */
  rain: number
}

export const DRY_DAY: Conditions = { night: false, rain: 0 }

/** The settings the K key cycles through, in order. */
export const CONDITION_CYCLE: Array<{ name: string; conditions: Conditions }> = [
  { name: 'Dry day', conditions: { night: false, rain: 0 } },
  { name: 'Rain', conditions: { night: false, rain: 0.75 } },
  { name: 'Night', conditions: { night: true, rain: 0 } },
  { name: 'Night, raining', conditions: { night: true, rain: 0.85 } },
]

/**
 * Available grip as a fraction of dry grip.
 *
 * A wet road gives roughly 70% of dry grip on a decent surface, which pushes a
 * 100-0 km/h stop from about 43 m to about 61 m. That is the figure the whole
 * thing exists to teach, so it is worth being the number that comes out.
 */
export function gripFor(conditions: Conditions): number {
  return 1 - 0.3 * Math.min(1, Math.max(0, conditions.rain))
}

/** How many seconds of gap the two-second rule asks for in these conditions. */
export function followingSeconds(conditions: Conditions): number {
  return conditions.rain > 0.2 ? 4 : 2
}
