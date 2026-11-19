import {
  angleDelta,
  centreLineOffset,
  stopLineAhead,
  withinJunction,
  type JunctionControl,
} from '../world/laneGraph'
import { followingSeconds } from '../sim/conditions'
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
 * Failing to yield where a yield sign applies.
 *
 * Until there was traffic to yield TO, this could only judge approach speed,
 * which is a proxy and was marked as one. Now that there is, it grades the
 * thing itself: pulling out across someone who has priority is a Grade 3,
 * because it is the fault that causes the collision rather than the one that
 * merely risks it. Arriving too fast to have given way if anything HAD been
 * coming is still worth a Grade 2 — the guidelines mark the approach as well
 * as the act.
 */
export function yieldJunctionRule(): Rule {
  let previousDistance: number | null = null
  let hadToGiveWay = false
  return {
    id: 'ie.junction.yield-approach',
    aspect: 'Anticipation and reaction',
    cooldown: 8,
    reset() {
      previousDistance = null
      hadToGiveWay = false
    },
    evaluate(ctx) {
      const loc = ctx.loc
      if (!loc) {
        previousDistance = null
        hadToGiveWay = false
        return
      }
      const line = stopLineAhead(loc, ctx.graph)
      const control = line ? junctionControl(ctx, line.nodeId) : null
      const applies =
        control?.kind === 'yield'
          ? control.yieldEdges.includes(loc.edge.id)
          : control?.kind === 'uncontrolled'
      if (!line || !applies) {
        previousDistance = null
        hadToGiveWay = false
        return
      }

      // Remembered on the approach: at the instant of crossing the line the
      // other vehicle may already have had to brake out of the way, which
      // would make the fault disappear exactly when it was committed.
      if (line.distance > 0 && line.distance < 30 && ctx.world?.mustGiveWay()) {
        hadToGiveWay = true
      }

      if (previousDistance !== null && previousDistance > 0 && line.distance <= 0) {
        if (hadToGiveWay) {
          ctx.report({
            grade: 3,
            message: 'Pulled out across traffic that had priority',
            reference: `${ROTR} — Yield signs and junctions`,
          })
        } else if (ctx.speedKmh > 30) {
          ctx.report({
            grade: 2,
            message: `Entered a yield junction at ${Math.round(ctx.speedKmh)} km/h`,
            reference: `${ROTR} — Yield signs`,
          })
        }
        hadToGiveWay = false
      }
      previousDistance = line.distance
    },
  }
}

/**
 * Following too closely.
 *
 * Graded against the two-second rule, which is what is taught and what the
 * marking guidelines expect to see — and against the four-second rule when it
 * is raining, which is the same rule applied to a road with less grip. Half
 * the required gap is treated as dangerous rather than merely serious, since
 * at that distance no reaction is possible at all.
 *
 * Below walking pace the rule stands down. Closing up in stationary traffic is
 * normal and is not what the two-second rule is about.
 */
export function followingDistanceRule(): Rule {
  let closeFor = 0
  return {
    id: 'ie.traffic.following-distance',
    aspect: 'Anticipation and reaction',
    cooldown: 10,
    reset() {
      closeFor = 0
    },
    evaluate(ctx) {
      const speed = Math.abs(ctx.state.speed)
      const leader = ctx.world?.leader() ?? null
      if (!leader || speed < 3) {
        closeFor = 0
        return
      }

      const seconds = leader.gap / speed
      const wanted = followingSeconds(ctx.conditions)
      if (seconds > wanted) {
        closeFor = Math.max(0, closeFor - ctx.dt * 2)
        return
      }

      closeFor += ctx.dt
      if (closeFor < 1.5) return
      closeFor = 0

      ctx.report({
        grade: seconds < wanted / 2 ? 3 : 2,
        message:
          `Following ${seconds.toFixed(1)} seconds behind the vehicle in front` +
          (wanted > 2 ? ` — ${wanted} seconds is the rule in the wet` : ''),
        reference: `${ROTR} — Safe distance`,
      })
    },
  }
}

/** Hitting something. There is no gentler reading of this one. */
export function collisionRule(): Rule {
  return {
    id: 'ie.traffic.collision',
    aspect: 'Anticipation and reaction',
    cooldown: 5,
    evaluate(ctx) {
      if ((ctx.world?.collisions() ?? 0) === 0) return
      ctx.report({
        grade: 3,
        message: 'Collision with another road user',
        reference: `${ROTR} — Anticipation and reaction`,
      })
    },
  }
}

/**
 * Not yielding at a pedestrian crossing.
 *
 * The test is whether the car could still be stopped. Judging it on speed
 * alone would mark a driver who is already committed and braking as hard as
 * the tyres allow, which is not a fault but the correct response to a
 * pedestrian who stepped out late.
 */
export function pedestrianCrossingRule(): Rule {
  return {
    id: 'ie.pedestrian.crossing',
    aspect: 'Traffic controls',
    cooldown: 8,
    evaluate(ctx) {
      const speed = Math.abs(ctx.state.speed)
      if (speed < 1.5) return

      const ahead = ctx.world?.pedestrianAhead(40) ?? null
      if (!ahead) return

      // Comfortable braking, not an emergency stop: the distance in which the
      // car SHOULD have been brought to rest by a driver who was looking.
      const stoppingDistance = (speed * speed) / (2 * 4.5) + speed * 0.7
      if (ahead.distance > stoppingDistance) return

      ctx.report({
        grade: ahead.onCrossing ? 3 : 2,
        message: ahead.onCrossing
          ? 'Did not yield to a pedestrian on a crossing'
          : 'Did not yield to a pedestrian waiting at a crossing',
        reference: `${ROTR} — Pedestrian crossings`,
      })
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

/**
 * Watches a car through a junction and reports which way it went.
 *
 * Both the signalling rule and the junction observation rule need the same
 * thing — "did this car actually turn here, and which way" — and neither can
 * know it until the junction is behind them. Keeping one watcher means the two
 * rules cannot disagree about what the driver just did.
 */
interface TurnWatcher {
  /** Call every step. Returns the completed turn on the step it finishes. */
  update(ctx: RuleContext): CompletedTurn | null
  reset(): void
}

interface CompletedTurn {
  nodeId: string
  /** Signed heading change through the junction (rad); positive is left. */
  change: number
  direction: 'left' | 'right' | 'ahead'
  /** Everything recorded on the approach, before the stop line was crossed. */
  approach: {
    indicator: 'off' | 'left' | 'right'
    sinceMirror: number
    sinceLeftGlance: number
    sinceRightGlance: number
    speedKmh: number
  }
}

/** Anything less than this is following the road, not turning. */
const TURN_RADIANS = 0.6

function turnWatcher(): TurnWatcher {
  // Two rules read this watcher in the same step, and the completed turn is
  // reported once. Without caching per step, whichever rule asked first
  // consumed the answer and the other never saw the turn at all.
  let lastT = -1
  let lastResult: CompletedTurn | null = null

  let armedNode: string | null = null
  let headingAtLine = 0
  let approach: CompletedTurn['approach'] | null = null
  let previousDistance: number | null = null
  let signalledSide: 'off' | 'left' | 'right' = 'off'
  let signalledAt = -Infinity

  const watcher: TurnWatcher = {
    reset() {
      armedNode = null
      approach = null
      previousDistance = null
      signalledSide = 'off'
      signalledAt = -Infinity
      lastT = -1
      lastResult = null
    },
    update(ctx) {
      if (ctx.t === lastT) return lastResult
      lastT = ctx.t
      lastResult = advance(ctx)
      return lastResult
    },
  }

  function advance(ctx: RuleContext): CompletedTurn | null {
      // Remember the most recent signal, so a stalk cancelled a moment before
      // the line still counts as having been given.
      if (ctx.input.indicator !== 'off') {
        signalledSide = ctx.input.indicator
        signalledAt = ctx.t
      }

      const loc = ctx.loc
      if (!loc) {
        armedNode = null
        previousDistance = null
        return null
      }

      // Waiting for the car to clear a junction it has entered.
      if (armedNode && approach) {
        const stillThere = withinJunction(loc, ctx.graph, 6)
        if (!stillThere) {
          const change = angleDelta(headingAtLine, ctx.state.heading)
          const nodeId = armedNode
          const recorded = approach
          armedNode = null
          approach = null
          return {
            nodeId,
            change,
            direction:
              Math.abs(change) < TURN_RADIANS ? 'ahead' : change > 0 ? 'left' : 'right',
            approach: recorded,
          }
        }
        return null
      }

      const line = stopLineAhead(loc, ctx.graph)
      if (!line) {
        previousDistance = null
        return null
      }

      if (previousDistance !== null && previousDistance > 0 && line.distance <= 0) {
        armedNode = line.nodeId
        headingAtLine = ctx.state.heading
        approach = {
          // A signal given within the last five seconds is a signal given.
          indicator: ctx.t - signalledAt < 5 ? signalledSide : 'off',
          sinceMirror: ctx.observations.sinceMirror,
          sinceLeftGlance: ctx.observations.sinceLeftGlance,
          sinceRightGlance: ctx.observations.sinceRightGlance,
          speedKmh: ctx.speedKmh,
        }
      }
      previousDistance = line.distance
      return null
  }

  return watcher
}

/**
 * Signals: missing, misleading, or left on.
 *
 * The RSA guidelines ask for a correct signal, given in good time, and
 * cancelled afterwards; all three failures are marked. Judged after the
 * junction rather than before it, because until the car has turned there is no
 * way to know what it should have signalled — the alternative is to read the
 * route, and a driver who ignores the examiner's direction and turns the other
 * way has still signalled correctly for the turn they made.
 */
export function signalRule(watcher: TurnWatcher): Rule {
  let onFor = 0
  return {
    id: 'ie.signals.use',
    aspect: 'Signals',
    cooldown: 8,
    reset() {
      onFor = 0
      // The watcher is shared, and this rule owns clearing it between drives.
      watcher.reset()
    },
    evaluate(ctx) {
      // Left on, going straight on. The stalk self-cancels through a turn, so
      // this only fires when the signal was never going to be cancelled by one.
      if (ctx.input.indicator !== 'off' && ctx.speedKmh > 8) {
        onFor += ctx.dt
        if (onFor > 22) {
          onFor = 0
          ctx.report({
            grade: 2,
            message: `Left the ${ctx.input.indicator} indicator on`,
            reference: `${ROTR} — Signals`,
          })
        }
      } else {
        onFor = 0
      }

      const turn = watcher.update(ctx)
      if (!turn || turn.direction === 'ahead') return

      if (turn.approach.indicator === 'off') {
        ctx.report({
          grade: 2,
          message: `Turned ${turn.direction} without signalling`,
          reference: `${ROTR} — Signals`,
        })
      } else if (turn.approach.indicator !== turn.direction) {
        ctx.report({
          grade: 2,
          message: `Signalled ${turn.approach.indicator} and turned ${turn.direction}`,
          reference: `${ROTR} — Signals`,
        })
      }
    },
  }
}

/**
 * Observation at junctions, and before moving off.
 *
 * Recorded under Observation rather than under any heading of its own: the RSA
 * guidelines put poor mirror use on a category B car test under Observation,
 * and keep Mirror faults for van, BE and HGV tests.
 *
 * The guidelines also accept effective use of the rear-view mirrors for most
 * purposes but ask for a look around — a glance over the shoulder — before
 * moving off from the kerb, so moving off wants both.
 */
export function observationRule(watcher: TurnWatcher): Rule {
  let stoppedFor = 0
  let wasStopped = false
  return {
    id: 'ie.observation.checks',
    aspect: 'Observation',
    cooldown: 6,
    reset() {
      stoppedFor = 0
      wasStopped = false
    },
    evaluate(ctx) {
      // --- Moving off ------------------------------------------------------
      if (ctx.speedKmh < 1) {
        stoppedFor += ctx.dt
        if (stoppedFor > 1.5) wasStopped = true
      } else {
        if (wasStopped && ctx.speedKmh > 4 && ctx.state.speed > 0) {
          wasStopped = false
          const mirror = ctx.observations.sinceMirror < 6
          const glance = ctx.observations.sinceRightGlance < 6
          if (!mirror && !glance) {
            ctx.report({
              grade: 2,
              message: 'Moved off without checking the mirrors or looking around',
              reference: `${ROTR} — Moving off`,
            })
          } else if (!glance) {
            ctx.report({
              grade: 2,
              message: 'Moved off without a look around for the blind spot',
              reference: `${ROTR} — Moving off`,
            })
          } else if (!mirror) {
            ctx.report({
              grade: 2,
              message: 'Moved off without checking the mirrors',
              reference: `${ROTR} — Moving off`,
            })
          }
        }
        stoppedFor = 0
      }

      // --- At a junction ---------------------------------------------------
      const turn = watcher.update(ctx)
      if (!turn || turn.direction === 'ahead') return
      if (turn.approach.sinceMirror < 7) return

      ctx.report({
        grade: 2,
        message: `Turned ${turn.direction} without checking the mirrors`,
        reference: `${ROTR} — Observation`,
      })
    },
  }
}

/**
 * Making no progress.
 *
 * The marking guidelines have a heading for this, and candidates lose tests on
 * it: hesitating at a junction that is clear, or holding up traffic by
 * crawling, is marked just as sitting too close is. Both branches here check
 * that there is actually nothing in the way first, because being stopped
 * behind a queue or behind a red light is not hesitation, it is driving.
 */
export function progressRule(): Rule {
  let stoppedFor = 0
  let crawlingFor = 0
  return {
    id: 'ie.progress.hesitation',
    aspect: 'Progress',
    cooldown: 15,
    reset() {
      stoppedFor = 0
      crawlingFor = 0
    },
    evaluate(ctx) {
      const loc = ctx.loc
      if (!loc) {
        stoppedFor = 0
        crawlingFor = 0
        return
      }

      const leader = ctx.world?.leader() ?? null
      const blockedBehind = leader !== null && leader.gap < 14
      const blockedByPerson = (ctx.world?.pedestrianAhead(18) ?? null) !== null
      const givingWay = ctx.world?.mustGiveWay() ?? false

      // Held at a red light is not hesitation either.
      const line = stopLineAhead(loc, ctx.graph)
      const control = line ? junctionControl(ctx, line.nodeId) : null
      let heldByLights = false
      if (line && control?.kind === 'signals' && line.distance > -2 && line.distance < 14) {
        const aspect = ctx.signals.get(line.nodeId)?.aspectFor(loc.edge.id)
        heldByLights = aspect === 'red' || aspect === 'redAmber'
      }

      const excused = blockedBehind || blockedByPerson || givingWay || heldByLights

      if (ctx.speedKmh < 1 && !excused) {
        stoppedFor += ctx.dt
        if (stoppedFor >= 9) {
          stoppedFor = 0
          ctx.report({
            grade: 2,
            message: 'Undue hesitation — stopped with the road clear',
            reference: `${ROTR} — Progress`,
          })
        }
      } else {
        stoppedFor = 0
      }

      // Crawling. Only on roads where there is room to make progress, and only
      // with nothing ahead to be held up by.
      const limit = loc.speedLimit
      const tooSlow = limit >= 50 && ctx.speedKmh > 1 && ctx.speedKmh < limit * 0.5
      if (tooSlow && !excused && !(leader && leader.gap < 45) && !withinJunction(loc, ctx.graph, 25)) {
        crawlingFor += ctx.dt
        if (crawlingFor >= 14) {
          crawlingFor = 0
          ctx.report({
            grade: 2,
            message: `Holding up traffic at ${Math.round(ctx.speedKmh)} km/h in a ${limit} zone`,
            reference: `${ROTR} — Progress`,
          })
        }
      } else {
        crawlingFor = Math.max(0, crawlingFor - ctx.dt * 2)
      }
    },
  }
}

/** Every rule the engine grades against. */
export function irishRules(): Rule[] {
  return [
    speedLimitRule(),
    keepLeftRule(),
    continuousWhiteLineRule(),
    trafficSignalRule(),
    stopJunctionRule(),
    yieldJunctionRule(),
    carriagewayRule(),
    followingDistanceRule(),
    collisionRule(),
    pedestrianCrossingRule(),
    progressRule(),
    // Both read the same watcher, so they cannot disagree about which way the
    // car went through a junction.
    ...(() => {
      const watcher = turnWatcher()
      return [signalRule(watcher), observationRule(watcher)]
    })(),
  ]
}
