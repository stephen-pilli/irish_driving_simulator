# Irish Driving Simulator

A browser-based trainer for the Irish rules of the road. The goal is not a driving
game: it is a simulator that watches how you drive and tells you which rule you
broke, graded the way the RSA driving test grades faults.

Runs entirely in the browser. No backend, no install, works offline.

## Status: P5 — feature complete against the original plan

Drive around a small Irish town, with traffic, and get marked on it. Fourteen
rules are enforced across nine headings of the test report: speed, road
position, continuous white lines, traffic lights, stop signs, yielding,
following distance, collisions, pedestrian crossings, progress, signals and
observation.

- **Enter** — the post-drive report. Every fault is seekable: pick one and the
  car replays the seconds before it, from the driver's seat, with the same
  traffic and the same lights.
- **P** — the practice library. Eight set-piece situations and the three set
  manoeuvres (turnabout, reversing around a corner, hill start), each the same
  every time, plus **Full test route**: a planned route with an examiner giving
  directions out loud.
- **K** — weather. Rain cuts grip by 30%, which stretches a 100–0 stop from
  about 43 m to about 61 m, and turns the two-second rule into four. Night
  turns the headlights on.
- **V** — mirrors. Interior always, wing mirrors from the driving seat.
- **G** — on-screen controls, for driving without a keyboard.

```bash
npm install
npm run dev      # http://127.0.0.1:5173
npm test         # headless vehicle model tests
npm run build    # typecheck + production bundle
```

### Controls

| Key | Action |
| --- | --- |
| `W` / `S` | Throttle / brake |
| `A` / `D` | Steer |
| `Space` | Handbrake |
| `R` | Reverse (only at a standstill, as in a real car) |
| `N` | Neutral |
| `,` / `.` | Left / right indicator (self-cancelling, as a real stalk is) |
| `1` | Check the mirrors |
| `2` / `3` | Look around, left / right (the blind-spot glance) |
| `C` | Cycle camera — chase, driver's eye, overhead |
| `V` | Mirrors — all, interior only, off |
| `K` | Weather — dry, rain, night, night and rain |
| `P` | Practice library, manoeuvres and the full test route |
| `Enter` | Post-drive report |
| `Escape` | Back out of a replay, the report or the editor |
| `T` | Live tuning panel — handling and camera |
| `E` | Road editor |
| `G` | On-screen controls |
| `M` | Engine sound |
| `Backspace` | Reset, or restart the manoeuvre being practised |

The mirror and glance keys are not decoration. Observation is a heading on the
test report, and the rules check that you looked before moving off and before
turning. Per the RSA guidelines, poor mirror use on a category B car test is
recorded as an **Observation** fault, not a Mirror fault — Mirror faults are
for van, BE and HGV tests — so there is no separate Mirrors heading here.

A gamepad works too: left stick steers, triggers are the pedals.

### How the car drives

A **kinematic bicycle model with a grip ceiling**, not a rigid-body physics engine.
That is a deliberate choice. It is stable at any timestep, has no jitter at a
standstill, is exactly deterministic, and every parameter maps to something a
driving instructor would recognise. What it does not model — weight transfer,
individual tyre slip, oversteer — a rules trainer does not need to grade.

The grip ceiling is what keeps it honest: beyond a set lateral acceleration the
car understeers rather than pivoting on the spot, so full lock at 85 km/h traces a
73 m arc instead of an impossible 3.9 m one.

Measured characteristics of the default car:

| | |
| --- | --- |
| 0–50 / 0–100 km/h | 4.0 s / 9.5 s |
| Braking 50–0 / 100–0 | 10.7 m / 42.8 m |
| Turning circle | 10.9 m kerb to kerb |
| Top speed | 149 km/h |

Those are a modern small hatchback's real figures, which matters: stopping
distances are examinable material, so the sim must not flatter them.

Press `T` to change any of it while driving. Values persist locally, and
**Copy JSON** exports a tuned set to become the new defaults.

### Sense of speed, and the camera

Speed is carried by **surface optical flow**, which is the strongest cue a real
driver has. An untextured carriageway produces none of it, so the road ribbons
carry real UVs and a seamlessly tiling tarmac texture with anisotropic filtering
— without the filtering it aliases into a shimmer at exactly the distances you
read speed from.

The camera itself is deliberately plain: **fixed height, fixed distance, fixed
field of view, rigidly attached to the car.** No heading lag, no speed-dependent
field of view, no lateral drift under cornering, no road vibration. Those are
racing-game devices; every one of them makes the car feel more exciting and road
position harder to judge, and road position is the thing being taught.

The aim is an *honest* sense of speed, not an exaggerated one. A learner taught
to feel 50 km/h as though it were 100 has been taught wrong.

## The lane graph

The world is a **lane graph**: a semantic description of roads, lanes,
priorities, markings, speed limits and junction control. Every road surface,
lane marking, stop line and traffic light in the scene is generated from it.

Nothing is authored as geometry, which is the point — the rules engine and the
renderer read the same structure, so what you see and what you are graded on
cannot drift apart. Changing a road from `broken` to `continuous` changes both
the paint on the road and whether crossing it is a fault.

Localisation (which lane am I in, how far from its centre, facing which way,
what is the limit here) runs every simulation step against a uniform spatial
grid, and is what every rule is written against.

## The rules engine

Rules are small, independent units that observe the car each step and report
faults. Faults are graded 1 to 3 and tallied per aspect of driving, following
the RSA's marking guidelines. A test is failed by any one of:

| | |
| --- | --- |
| Grade 3 faults | 1 or more |
| The same Grade 2 fault under one aspect | 4 or more |
| Grade 2 faults under one heading | 6 or more |
| Grade 2 faults overall | 9 or more |

Grade 1 faults are recorded but do not count. Faults are not double-marked: a
lesser fault raised in the same moment and aspect as a Grade 3 is dropped, since
the Grade 3 is the more useful thing to tell the driver.

Thresholds are from the RSA's *Making Your Mark — Marking Guidelines for the
Driving Test*; the speed limits are from the Department of Transport's 2025
changes. Both are cited in the source where they are used.

The rules implemented so far: speed limits, keeping left, leaving the
carriageway, crossing a continuous white line, obeying traffic lights (including
moving off on red-and-amber), stopping at stop signs, and approaching a yield at
a speed that allows yielding.

## The road editor

Press `E`. The drive pauses and a plan view of the lane graph takes over.

Authoring a town by hand works for a dozen roads and not for a hundred, and a
full test route needs a lot more than a dozen. The editor is a plan view
because a plan is how you judge the way a network connects; the 3D view is for
judging what it is like to drive, which is why edits apply to the running world
immediately and `E` puts you straight back behind the wheel.

| | |
| --- | --- |
| Drag | Pan, or move the selected junction or bend |
| Wheel | Zoom |
| Double-click | New junction, or a new bend on a road |
| Shift-click | Join to the selected junction |
| Delete | Remove the selection |
| `Ctrl+Z` | Undo (a whole drag is one undo) |
| `F` | Fit the view |

Roads are coloured by speed limit and junctions carry a glyph for their control
(**S**ignals, **Y**ield, **H**alt). Selecting a road or junction opens its
properties: category and limit, centre line, lane width, one-way, junction type,
which approaches must stop or yield, and the signal phase groups.

**Edits export as TypeScript** in the same shape as the hand-written town, so a
layout stays a reviewable source file rather than becoming opaque saved state.
Work in progress is kept in `localStorage` and **Revert** restores the original.

A layout is only pushed to the simulation once it is valid. Problems — a
junction controlling a road that no longer exists, a node joined to nothing,
signals with too few phase groups — are listed in the panel, and the drive keeps
the last good layout until they are fixed. Deleting a road also scrubs it from
every junction control that named it, because a stale reference would silently
disable a stop line and nothing would notice until someone drove through it.

## Architecture

```
src/
  core/     fixed-timestep loop, maths, spline, deterministic RNG
  sim/      vehicle model (+ headless tests)
  world/    lane graph, the town, traffic signals
  rules/    rules engine, fault grading, the Irish rule set (+ tests)
  editor/   the road editor: document, plan view, serialiser (+ tests)
  render/   Three.js scene, procedural road geometry, car, camera rig
  input/    keyboard and gamepad
  ui/       HUD and test report, tuning panel, engine audio
```

The simulation, the lane graph and the rules engine are all deterministic and
free of DOM and Three.js dependencies. That is what makes the headless tests
possible: a drive can be scripted along the lane graph and the exact faults
asserted, in milliseconds and with no renderer. Rule tests move the car along
the graph directly rather than through the vehicle model, so they fail when a
rule is wrong rather than when the handling changes.

`npm test` runs 67 tests across the vehicle model, the grading thresholds, the
rules themselves, and the editor's document and hit testing.

## Roadmap

- **P0 — driving feel.** Vehicle model, cameras, HUD, live tuning.
- **P1 — world and first rules.** Lane graph, procedural geometry, junctions,
  traffic lights, the rules engine and the first seven Irish rules.
- **P2 — the report.** Post-drive report screen with a fault timeline,
  deterministic replay, and roundabouts. *Done.*
- **P3 — traffic.** IDM traffic, junction priority, pedestrians and cyclists,
  and the corner-case scenario library. *Done.*
- **P4 — test mode.** Manoeuvres (turnabout, reversing around a corner, hill
  start), a full route with examiner voice prompts, pass/fail verdict. *Done.*
- **P5 — polish.** Mirrors, night and rain, touch controls, signs. *Done, with
  one deliberate omission — see below.*

### On the Blender art pass

P5 originally said "Blender art pass". It was not done, and that is a decision
rather than an omission.

Modelled assets would have bought a better-looking car and better-looking
buildings. Against that: an asset pipeline, export and licensing to manage,
and megabytes of download for a trainer whose value is entirely in whether it
notices you crossed a continuous white line. The same effort went into **road
signs** instead — stop, yield and speed-limit signs generated from the lane
graph and placed where the rule they describe applies — because a rules trainer
where the rules are invisible is a memory test.

The art remains deliberately plain. If that changes, the renderer already takes
everything it draws from the lane graph, so new models are a swap rather than a
rewrite.

### Conditions and grip

Rain is not a filter over the picture. It changes the numbers:

| | Dry | Wet |
| --- | --- | --- |
| Grip | 100% | 70% |
| 100–0 km/h | ~43 m | ~61 m |
| Following distance | 2 seconds | 4 seconds |

Both are what is taught, and both are checked by tests. Gradients work the same
way: the residential street climbs at about 7%, gravity acts along the road,
and the parking brake holds the car until you ask for drive — which is what
makes a hill start a hill start rather than a reaction test.

### Known gaps

- **The editor cannot place signs or road furniture**, only roads and junction
  control. Yellow boxes and bus lanes have no representation yet, and pedestrian
  crossings can be authored in the town file but not drawn in the editor.
- **Collisions are detected against other road users only.** You can still
  drive through buildings, and the traffic drives through you rather than being
  dented by you.
- **Traffic does not overtake or change lanes.** It follows, gives way and
  turns; a cyclist on a single-lane road will be sat behind rather than passed.
- **Observation is modelled as a keypress.** The mirror and glance keys record
  that you looked, not that you saw. A simulator cannot tell the difference
  without eye tracking, and pretending otherwise would be worse than saying so.
- **The examiner's route is a walk of the network**, not a route designed by
  anyone. It avoids cul-de-sacs, never ends on a roundabout and will not send
  you round one twice, but it has no sense of a sensible test route.
- **Speech depends on the browser.** The directions are always on screen; the
  voice uses the platform's speech synthesiser, which is missing on some
  systems and needs a user gesture on others.
- **Speed limit rollout.** Rural local roads are correct at 60 km/h. The urban
  30 km/h and national secondary 80 km/h phases were still rolling out and
  should be confirmed before being taught as fact.

## Licence and attribution

Not affiliated with or endorsed by the RSA. Rules content will be paraphrased
with citations to the *Rules of the Road*, never reproduced.
