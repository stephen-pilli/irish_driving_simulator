/**
 * The set manoeuvres.
 *
 * On an Irish test the examiner asks for one or two of these and marks them
 * separately from the drive: the turnabout, reversing around a corner, and a
 * start on a hill. They are the exercises where the car is being handled
 * rather than merely driven, and they are the ones candidates practise in a
 * car park because getting them wrong on the road is expensive.
 *
 * Each is a scenario with a grader attached. The grader runs inside the rules
 * engine as an ordinary rule, so a fault it raises is counted, tallied,
 * subject to the no-double-marking rule and printed on the report alongside
 * everything else — there is no second, parallel idea of what a fault is.
 */

import { angleDelta, withinJunction } from '../world/laneGraph'
import type { Rule, RuleContext } from '../rules/types'
import type { Scenario } from './scenarios'

export type ExerciseOutcome = 'inProgress' | 'complete' | 'failed'

export interface Exercise {
  /** Clear state between attempts. */
  reset(): void
  /** Called every simulation step while the manoeuvre is running. */
  update(ctx: RuleContext): ExerciseOutcome
  /** One line for the brief, saying what still has to happen. */
  status(): string
}

export interface ManoeuvreScenario extends Scenario {
  exercise: Exercise
}

const ROTR = 'Rules of the Road'

/**
 * The turnabout: turning the car to face the other way, in a road too narrow
 * to do it in one. Marked on control and on accuracy — mounting the kerb is
 * the fault candidates actually make.
 */
function turnabout(): Exercise {
  let startHeading: number | null = null
  let shuffles = 0
  let lastDirection = 0
  let kerbReported = false
  let done = false

  return {
    reset() {
      startHeading = null
      shuffles = 0
      lastDirection = 0
      kerbReported = false
      done = false
    },
    status() {
      if (done) return 'Turnabout complete.'
      return `Turned ${shuffles} time${shuffles === 1 ? '' : 's'} so far.`
    },
    update(ctx) {
      if (done) return 'complete'
      if (startHeading === null) startHeading = ctx.state.heading

      const direction = Math.sign(ctx.state.speed)
      if (direction !== 0 && lastDirection !== 0 && direction !== lastDirection) shuffles++
      if (direction !== 0) lastDirection = direction

      if (ctx.loc?.offRoad && !kerbReported && Math.abs(ctx.state.speed) > 0.2) {
        kerbReported = true
        ctx.report({
          grade: 2,
          message: 'Mounted the kerb during the turnabout',
          reference: `${ROTR} — Turning the vehicle around`,
        })
      }
      if (!ctx.loc?.offRoad) kerbReported = false

      // Facing the other way, stopped, and still on the road.
      const turned = Math.abs(angleDelta(startHeading + Math.PI, ctx.state.heading)) < 0.45
      if (turned && Math.abs(ctx.state.speed) < 0.3 && ctx.loc && !ctx.loc.offRoad) {
        done = true
        if (shuffles > 4) {
          ctx.report({
            grade: 2,
            message: `Took ${shuffles + 1} moves to turn the car around`,
            reference: `${ROTR} — Turning the vehicle around`,
          })
        }
        return 'complete'
      }
      return 'inProgress'
    },
  }
}

/**
 * Reversing around a corner into a side road on the left, keeping reasonably
 * close to the kerb without touching it.
 */
function reverseAroundCorner(sideRoad: string): Exercise {
  let wideReported = false
  let kerbReported = false
  let done = false
  let reversedDistance = 0

  return {
    reset() {
      wideReported = false
      kerbReported = false
      done = false
      reversedDistance = 0
    },
    status() {
      if (done) return 'Reverse complete.'
      return `${reversedDistance.toFixed(0)} m back into the side road.`
    },
    update(ctx) {
      if (done) return 'complete'
      const loc = ctx.loc
      const reversing = ctx.state.speed < -0.05

      if (!loc) return 'inProgress'

      if (loc.edge.id === sideRoad && reversing) {
        reversedDistance += Math.abs(ctx.state.speed) * ctx.dt
      }

      if (loc.offRoad && !kerbReported && Math.abs(ctx.state.speed) > 0.1) {
        kerbReported = true
        ctx.report({
          grade: 2,
          message: 'Touched the kerb while reversing',
          reference: `${ROTR} — Reversing`,
        })
      }
      if (!loc.offRoad) kerbReported = false

      // Swinging wide into the other side of the road is the classic fault,
      // and it is the one that would meet oncoming traffic. Suppressed in the
      // junction itself, where a wide line is simply how the corner is taken.
      if (
        loc.edge.id === sideRoad &&
        !withinJunction(loc, ctx.graph, 4) &&
        reversedDistance > 3 &&
        !wideReported
      ) {
        const wrongSide = loc.lane.direction !== (loc.withEdge ? 1 : -1)
        if (wrongSide) {
          wideReported = true
          ctx.report({
            grade: 2,
            message: 'Swung wide onto the wrong side of the road while reversing',
            reference: `${ROTR} — Reversing`,
          })
        }
      }

      if (loc.edge.id === sideRoad && reversedDistance > 18 && Math.abs(ctx.state.speed) < 0.3) {
        done = true
        return 'complete'
      }
      return 'inProgress'
    },
  }
}

/**
 * The hill start. The car is held on the parking brake; the fault is rolling
 * back when it is released, and a long roll back is dangerous rather than
 * merely untidy because of whatever is waiting behind.
 */
function hillStart(): Exercise {
  let highestPoint: number | null = null
  let rollback = 0
  let settledFor = 0
  let reported = false
  let done = false

  /** Over this, a roll-back is dangerous rather than merely untidy. */
  const SERIOUS = 1.5

  return {
    reset() {
      highestPoint = null
      rollback = 0
      settledFor = 0
      reported = false
      done = false
    },
    status() {
      if (done) return `Away, after rolling back ${rollback.toFixed(2)} m.`
      if (rollback > 0.02) return `Rolled back ${rollback.toFixed(2)} m.`
      return 'Hold it on the brake, then pull away without rolling back.'
    },
    update(ctx) {
      if (done) return 'complete'
      const loc = ctx.loc
      if (!loc) return 'inProgress'

      // Distance travelled DOWN the slope from the furthest point reached.
      const along = loc.withEdge ? loc.s : -loc.s
      if (highestPoint === null || along > highestPoint) highestPoint = along
      const previous = rollback
      rollback = Math.max(rollback, highestPoint - along)
      settledFor = rollback > previous + 1e-6 ? 0 : settledFor + ctx.dt

      // Graded once the roll-back has finished, not the instant it passes the
      // threshold. Marked at 0.3 m the grade is fixed before anyone knows how
      // far the car is going to go, so an eight-metre roll back down the hill
      // was recorded as the same untidy-but-harmless fault as a nudge.
      const over = rollback > 0.3
      const finished = settledFor > 0.6 || rollback > SERIOUS
      if (!reported && over && finished) {
        reported = true
        ctx.report({
          grade: rollback > SERIOUS ? 3 : 2,
          message: `Rolled back ${rollback.toFixed(1)} m on the hill start`,
          reference: `${ROTR} — Moving off`,
        })
      }

      if (ctx.speedKmh > 15 && ctx.state.speed > 0) {
        done = true
        return 'complete'
      }
      return 'inProgress'
    },
  }
}

export const MANOEUVRES: ManoeuvreScenario[] = [
  {
    id: 'turnabout',
    title: 'Turnabout',
    brief:
      'Turn the car round to face the other way, using forward and reverse. The road is ' +
      'narrower than your turning circle, so it will take more than one move. Do not ' +
      'touch the kerb.',
    reference: 'Rules of the Road — Turning the vehicle around',
    exercise: turnabout(),
    setUp(world) {
      world.traffic.clear()
      world.placeCar('town_south', 120, { speedKmh: 0 })
    },
  },

  {
    id: 'reverse-around-corner',
    title: 'Reversing around a corner',
    brief:
      'You have just passed the residential street on your left. Reverse back and round ' +
      'into it, staying on your own side and close to the kerb without touching it.',
    reference: 'Rules of the Road — Reversing',
    exercise: reverseAroundCorner('residential'),
    setUp(world) {
      world.traffic.clear()
      world.placeCar('main_e', 20, { speedKmh: 0 })
    },
  },

  {
    id: 'hill-start',
    title: 'Hill start',
    brief:
      'You are stopped facing up the residential hill with the parking brake on. Pull ' +
      'away without rolling back — the brake releases as soon as you ask for drive, so ' +
      'the throttle has to be there first.',
    reference: 'Rules of the Road — Moving off',
    exercise: hillStart(),
    setUp(world) {
      world.traffic.clear()
      world.placeCar('residential', 55, { speedKmh: 0 })
      world.holdOnParkBrake()
    },
  },
]

/**
 * The rule that grades whichever manoeuvre is running.
 *
 * A rule rather than a separate mechanism, so manoeuvre faults are counted and
 * printed exactly like every other fault. Graded under "Vehicle controls",
 * which is where the marking guidelines put handling faults in a manoeuvre.
 */
export function manoeuvreRule(
  active: () => Exercise | null,
  onOutcome?: (outcome: ExerciseOutcome) => void,
): Rule {
  return {
    id: 'ie.manoeuvre.control',
    aspect: 'Vehicle controls',
    cooldown: 4,
    evaluate(ctx) {
      const exercise = active()
      if (!exercise) return
      onOutcome?.(exercise.update(ctx))
    },
  }
}

export function manoeuvreById(id: string): ManoeuvreScenario | undefined {
  return MANOEUVRES.find((m) => m.id === id)
}
