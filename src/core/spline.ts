export interface Point2 {
  x: number
  y: number
}

const EPS = 1e-6

const lerp2 = (a: Point2, b: Point2, u: number): Point2 => ({
  x: a.x + (b.x - a.x) * u,
  y: a.y + (b.y - a.y) * u,
})

/**
 * Centripetal Catmull-Rom. Chosen over the uniform variant because road
 * control points are rarely evenly spaced, and uniform Catmull-Rom produces
 * cusps and overshoot when they are not — which on a road means a kink or a
 * loop in the carriageway.
 *
 * Kept dependency-free so the lane graph can be built and tested headlessly.
 */
function segmentPoint(
  p0: Point2,
  p1: Point2,
  p2: Point2,
  p3: Point2,
  t: number,
  alpha: number,
): Point2 {
  const knot = (ti: number, a: Point2, b: Point2): number =>
    ti + Math.max(Math.pow(Math.hypot(b.x - a.x, b.y - a.y), alpha), EPS)

  const t0 = 0
  const t1 = knot(t0, p0, p1)
  const t2 = knot(t1, p1, p2)
  const t3 = knot(t2, p2, p3)
  const tt = t1 + (t2 - t1) * t

  const a1 = lerp2(p0, p1, (tt - t0) / (t1 - t0))
  const a2 = lerp2(p1, p2, (tt - t1) / (t2 - t1))
  const a3 = lerp2(p2, p3, (tt - t2) / (t3 - t2))
  const b1 = lerp2(a1, a2, (tt - t0) / (t2 - t0))
  const b2 = lerp2(a2, a3, (tt - t1) / (t3 - t1))
  return lerp2(b1, b2, (tt - t1) / (t2 - t1))
}

/**
 * Resample a control polyline into a smooth one with roughly `spacing` metres
 * between points. Endpoints are preserved exactly, which matters because roads
 * must meet their junction nodes precisely.
 */
export function smoothPolyline(points: Point2[], spacing = 4): Point2[] {
  if (points.length < 3) return points.map((p) => ({ ...p }))

  // Duplicated phantom endpoints keep the curve anchored at the real ends.
  const pts = [points[0]!, ...points, points[points.length - 1]!]
  const out: Point2[] = [{ ...points[0]! }]

  for (let i = 1; i < pts.length - 2; i++) {
    const p0 = pts[i - 1]!
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const p3 = pts[i + 2]!
    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const steps = Math.max(2, Math.ceil(chord / spacing))
    for (let k = 1; k <= steps; k++) {
      out.push(segmentPoint(p0, p1, p2, p3, k / steps, 0.5))
    }
  }

  const last = points[points.length - 1]!
  out[out.length - 1] = { ...last }
  return out
}
