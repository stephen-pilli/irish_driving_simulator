import {
  centreLineOffset,
  stopLineAhead,
  withinJunction,
  type JunctionControl,
} from '../world/laneGraph'
import type { Rule, RuleContext } from './types'

const ROTR = 'Rules of the Road'

function junctionControl(ctx: RuleContext, nodeId: string): JunctionControl | null {
  return ctx.graph.nodes.get(nodeId)?.junction?.control ?? null
}

/**
 * Exceeding the speed limit.
 *
 * A brief overshoot is not marked — the guidelines ignore faults at the bottom
 * of the scale — so a sustained excess is required before anything is
 * recorded. A large excess is dangerous rather than merely serious.
 */
export function speedLimitRule(): Rule {
  let overFor = 0
  return {
    id: 'ie.speed.exceed-limit',
    aspect: 'Speed',
    cooldown: 12,
    reset() {
      overFor = 0
    },
    evaluate(ctx) {
      if (!ctx.loc) {
        overFor = 0
        return
      }
      const limit = ctx.loc.speedLimit
      const over = ctx.speedKmh - limit

      // Dangerous is proportional, not a flat margin. Irish limits run from 30
      // to 120 km/h, so a fixed "+20 km/h" would treat 50 in a 30 zone — nearly
      // double, outside a school — as no worse than 120 on a motorway.
      const dangerous = ctx.speedKmh > limit * 1.5 || over > 25

      if (dangerous) {
        ctx.report({
          grade: 3,
          message: `${Math.round(ctx.speedKmh)} km/h in a ${limit} km/h zone`,
          reference: `${ROTR} — Speed limits`,
        })
        overFor = 0
        return
      }

      if (over > 5) {
        overFor += ctx.dt
        if (overFor >= 2) {
          ctx.report({
            grade: 2,
            message: `${Math.round(ctx.speedKmh)} km/h in a ${limit} km/h zone`,
            reference: `${ROTR} — Speed limits`,
          })
          overFor = 0
        }
      } else {
        overFor = Math.max(0, overFor - ctx.dt)
      }
    },
  }
}

/**
 * Driving on the wrong side of the road.
 *
 * Suppressed near junctions, where crossing the centre line to turn is normal
 * and the lane model stops describing what the driver is actually doing.
 */
export function keepLeftRule(): Rule {
  let wrongFor = 0
  return {
    id: 'ie.position.keep-left',
    aspect: 'Road position',
    cooldown: 8,
    reset() {
      wrongFor = 0
    },
    evaluate(ctx) {
      const loc = ctx.loc
      if (!loc || ctx.speedKmh < 2 || withinJunction(loc, ctx.graph, 10)) {
        wrongFor = 0
        return
      }

      const expected = loc.withEdge ? 1 : -1
      if (loc.lane.direction !== expected) {
        wrongFor += ctx.dt
        if (wrongFor >= 1.5) {
          ctx.report({
            grade: 2,
            message: 'Driving on the wrong side of the road',
            reference: `${ROTR} — Driving on the left`,
          })
          wrongFor = 0
        }
      } else {
        wrongFor = 0
      }
    },
  }
}

/**
 * Crossing a continuous white centre line.
 *
 * Graded 3: the marking guidelines place "ignoring traffic controls" in the
 * dangerous category, and a continuous white line is a traffic control.
 */
export function continuousWhiteLineRule(): Rule {
  let acrossFor = 0
  return {
    id: 'ie.markings.continuous-white-line',
    aspect: 'Overtaking',
    cooldown: 10,
    reset() {
      acrossFor = 0
    },
    evaluate(ctx) {
      const loc = ctx.loc
      if (!loc || withinJunction(loc, ctx.graph, 8)) {
        acrossFor = 0
        return
      }
      if (loc.edge.centreLine !== 'continuous' && loc.edge.centreLine !== 'doubleContinuous') {
        acrossFor = 0
        return
      }

      const centre = centreLineOffset(loc.edge)
      if (centre === null) return

      // Lanes running with the edge sit on the positive side of the centre
      // line, because in Ireland your lanes are the ones on your left.
      const expectedSide = loc.withEdge ? 1 : -1
      const offset = loc.lateral - centre
      const crossed = Math.sign(offset) === -expectedSide && Math.abs(offset) > 0.3

      if (crossed) {
        acrossFor += ctx.dt
        if (acrossFor >= 0.4) {
          ctx.report({
            grade: 3,
            message: 'Crossed a continuous white line',
            reference: `${ROTR} — Traffic lanes and road markings`,
          })
          acrossFor = 0
        }
      } else {
        acrossFor = 0
      }
    },
  }
}

/** Driving through a red light, and moving off before green. */
export function trafficSignalRule(): Rule {
  let previousDistance: number | null = null
  return {
    id: 'ie.signals.obey',
    aspect: 'Traffic controls',
    cooldown: 6,
    reset() {
      previousDistance = null
    },
    evaluate(ctx) {
      const loc = ctx.loc
      if (!loc) {
        previousDistance = null
        return
      }
      const line = stopLineAhead(loc, ctx.graph)
      if (!line || junctionControl(ctx, line.nodeId)?.kind !== 'signals') {
        previousDistance = null
        return
      }

      const controller = ctx.signals.get(line.nodeId)
      if (!controller) return
      const aspect = controller.aspectFor(loc.edge.id)

      // Red and amber together means prepare to move, not move.
      if (aspect === 'redAmber' && line.distance > 0 && line.distance < 12 && ctx.speedKmh > 4) {
        ctx.report({
          grade: 2,
          message: 'Moved off on red and amber, before the green',
          reference: `${ROTR} — Traffic lights`,
        })
      }

      // Crossing the stop line this step.
      if (previousDistance !== null && previousDistance > 0 && line.distance <= 0) {
        if (aspect === 'red' || aspect === 'redAmber') {
          ctx.report({
            grade: 3,
            message: 'Crossed the stop line against a red light',
            reference: `${ROTR} — Traffic lights`,
          })
        }
      }
      previousDistance = line.distance
    },
  }
}

/** A stop sign requires the car to come to rest, not merely slow down. */
export function stopJunctionRule(): Rule {
  let stopped = false
  let previousDistance: number | null = null
  return {
    id: 'ie.junction.stop-sign',
    aspect: 'Traffic controls',
    cooldown: 6,
    reset() {
      stopped = false
      previousDistance = null
    },
    evaluate(ctx) {
      const loc = ctx.loc
      if (!loc) {
        previousDistance = null
        return
      }
      const line = stopLineAhead(loc, ctx.graph)
      const control = line ? junctionControl(ctx, line.nodeId) : null
      if (!line || control?.kind !== 'stop' || !control.stopEdges.includes(loc.edge.id)) {
        previousDistance = null
        stopped = false
        return
      }

      if (line.distance > 0 && line.distance < 7 && ctx.speedKmh < 0.6) stopped = true

      if (previousDistance !== null && previousDistance > 0 && line.distance <= 0) {
        if (!stopped) {
          ctx.report({
            grade: 3,
            message: 'Did not stop at a stop sign',
            reference: `${ROTR} — Stop signs`,
          })
        }
        stopped = false
      }
      previousDistance = line.distance
    },
  }
}

/**
 * Approaching a yield-controlled junction too fast to give way.
 *
 * A proxy, and an honest one only until there is traffic to yield TO: with an
 * empty junction, approach speed is all that can be judged. Once P3 adds
 * traffic this should check gap acceptance instead.
 */
export function yieldJunctionRule(): Rule {
  let previousDistance: number | null = null
  return {
    id: 'ie.junction.yield-approach',
    aspect: 'Anticipation and reaction',
    cooldown: 8,
    reset() {
      previousDistance = null
    },
    evaluate(ctx) {
      const loc = ctx.loc
      if (!loc) {
        previousDistance = null
        return
      }
      const line = stopLineAhead(loc, ctx.graph)
      const control = line ? junctionControl(ctx, line.nodeId) : null
      if (!line || control?.kind !== 'yield' || !control.yieldEdges.includes(loc.edge.id)) {
        previousDistance = null
        return
      }

      if (previousDistance !== null && previousDistance > 0 && line.distance <= 0 && ctx.speedKmh > 30) {
        ctx.report({
          grade: 2,
          message: `Entered a yield junction at ${Math.round(ctx.speedKmh)} km/h`,
          reference: `${ROTR} — Yield signs`,
        })
      }
      previousDistance = line.distance
    },
  }
}

/** Letting the car leave the carriageway altogether. */
export function carriagewayRule(): Rule {
  let offFor = 0
  return {
    id: 'ie.position.off-carriageway',
    aspect: 'Road position',
    cooldown: 8,
    reset() {
      offFor = 0
    },
    evaluate(ctx) {
      const loc = ctx.loc
      if (!loc || ctx.speedKmh < 2 || withinJunction(loc, ctx.graph, 6)) {
        offFor = 0
        return
      }
      if (loc.offRoad) {
        offFor += ctx.dt
        if (offFor >= 0.8) {
          ctx.report({
            grade: 2,
            message: 'Left the carriageway',
            reference: `${ROTR} — Road position`,
          })
          offFor = 0
        }
      } else {
        offFor = Math.max(0, offFor - ctx.dt * 2)
      }
    },
  }
}

/** The P1 rule set. */
export function irishRules(): Rule[] {
  return [
    speedLimitRule(),
    keepLeftRule(),
    continuousWhiteLineRule(),
    trafficSignalRule(),
    stopJunctionRule(),
    yieldJunctionRule(),
    carriagewayRule(),
  ]
}
