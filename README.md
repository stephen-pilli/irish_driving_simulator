# Irish Driving Simulator

A browser-based trainer for the Irish rules of the road. The goal is not a driving
game: it is a simulator that watches how you drive and tells you which rule you
broke, graded the way the RSA driving test grades faults.

Runs entirely in the browser. No backend, no install, works offline.

## Status: P1 — the town and the first rules

Drive around a small Irish town and get marked on it. Speed limits, road
position, continuous white lines, traffic lights, stop signs and yields are all
enforced, and faults are graded the way the RSA grades them.

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
| `C` | Cycle camera — chase, driver's eye, overhead |
| `T` | Live tuning panel — handling and camera |
| `E` | Road editor |
| `M` | Engine sound |
| `Backspace` | Reset to the start |

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
  deterministic replay, and roundabouts.
- **P3 — traffic.** IDM traffic, junction priority, pedestrians and cyclists,
  and the corner-case scenario library.
- **P4 — test mode.** Manoeuvres (turnabout, reversing around a corner, hill
  start), a full route with examiner voice prompts, pass/fail verdict.
- **P5 — polish.** Blender art pass, mirrors, night and rain, touch controls.

### Known gaps

- **No traffic.** Nothing else moves, which limits several rules: the yield rule
  can only judge approach speed, because there is nothing to yield to. It is
  marked in the source as a proxy to be replaced in P3.
- **The editor cannot place signs or road furniture**, only roads and junction
  control. Yellow boxes, bus lanes and crossings have no representation yet.
- **No collision detection.** You can still drive through buildings.
- **No observation rules.** Mirror and blind-spot checks need mirrors and a
  glance input, which is P5 work, and they are a large part of the real test.
- **Speed limit rollout.** Rural local roads are correct at 60 km/h. The urban
  30 km/h and national secondary 80 km/h phases were still rolling out and
  should be confirmed before being taught as fact.

## Licence and attribution

Not affiliated with or endorsed by the RSA. Rules content will be paraphrased
with citations to the *Rules of the Road*, never reproduced.
