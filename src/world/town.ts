import { generalLane, twoWay, type LaneGraphSpec } from './laneGraph'

/**
 * Ballyroad: a small fictional Irish town, authored as a lane graph.
 *
 * Deliberately fictional rather than a real place — a recognisable location
 * would set an expectation of accuracy that the layout cannot meet, and the
 * point here is rule coverage, not cartography.
 *
 * Laid out to exercise specific rules rather than to look like a map:
 *  - a signalised crossroads in the centre
 *  - a yield-controlled T-junction on the east side
 *  - a stop-controlled T-junction to the south
 *  - a 30 km/h residential street, a 50 km/h town road, a 60 km/h rural local
 *    road and an 80 km/h regional road, so speed changes are unavoidable
 *  - a continuous white centre line on the southern road, where overtaking
 *    must not happen
 *  - a three-arm roundabout in the north-east corner
 *  - pedestrian crossings on the main street and the residential road
 */
export const BALLYROAD: LaneGraphSpec = {
  nodes: [
    { id: 'n_west', x: -320, y: 0 },
    {
      id: 'n_cross',
      x: 0,
      y: 0,
      junction: {
        radius: 13,
        control: {
          kind: 'signals',
          // Main street runs first, then the side roads.
          groups: [
            ['main_w', 'main_e'],
            ['residential', 'town_south'],
          ],
          greenSeconds: 14,
          amberSeconds: 3,
        },
      },
    },
    { id: 'n_north', x: 0, y: 240 },
    {
      id: 'n_east',
      x: 300,
      y: 0,
      junction: {
        radius: 11,
        // Traffic coming down the north link gives way to the main road.
        control: { kind: 'yield', yieldEdges: ['north_link'] },
      },
    },
    {
      id: 'n_south',
      x: 0,
      y: -260,
      junction: {
        radius: 11,
        // Traffic coming out of town must stop before the regional road.
        control: { kind: 'stop', stopEdges: ['town_south'] },
      },
    },
    {
      id: 'n_ne',
      x: 300,
      y: 200,
      // Expanded by the graph into a clockwise circulatory carriageway with a
      // yield-controlled entry on each of its three arms.
      junction: { radius: 20, control: { kind: 'roundabout' } },
    },
    { id: 'n_ne_east', x: 470, y: 240 },
    { id: 'n_rural_end', x: 520, y: -200 },
    { id: 'n_se', x: 260, y: -260 },
    { id: 'n_sw', x: -260, y: -260 },
  ],

  edges: [
    {
      id: 'main_w',
      from: 'n_west',
      to: 'n_cross',
      category: 'urban',
      lanes: twoWay(),
      centreLine: 'broken',
      crossings: [250],
    },
    {
      id: 'main_e',
      from: 'n_cross',
      to: 'n_east',
      category: 'urban',
      lanes: twoWay(),
      centreLine: 'broken',
    },
    {
      id: 'residential',
      from: 'n_cross',
      to: 'n_north',
      category: 'urbanCore',
      lanes: twoWay(3.1),
      centreLine: 'broken',
      // Two crossings on the residential street, which is where a 30 km/h
      // limit and people on foot are supposed to go together.
      crossings: [70, 165],
    },
    {
      id: 'town_south',
      from: 'n_cross',
      to: 'n_south',
      category: 'urban',
      lanes: twoWay(),
      // No overtaking: the rule engine treats this as uncrossable.
      centreLine: 'continuous',
    },
    {
      id: 'north_link',
      from: 'n_east',
      to: 'n_ne',
      category: 'urban',
      lanes: twoWay(),
      centreLine: 'broken',
    },
    {
      id: 'north_east_link',
      from: 'n_north',
      to: 'n_ne',
      category: 'urban',
      via: [
        { x: 120, y: 256 },
        { x: 232, y: 236 },
      ],
      lanes: twoWay(),
      centreLine: 'broken',
    },
    {
      id: 'ne_spur',
      from: 'n_ne',
      to: 'n_ne_east',
      category: 'ruralLocal',
      lanes: twoWay(3.2),
      centreLine: 'broken',
    },
    {
      id: 'rural',
      from: 'n_east',
      to: 'n_rural_end',
      category: 'ruralLocal',
      via: [
        { x: 402, y: -18 },
        { x: 474, y: -88 },
        { x: 512, y: -158 },
      ],
      lanes: twoWay(3.2),
      centreLine: 'broken',
    },
    {
      id: 'rural_south',
      from: 'n_rural_end',
      to: 'n_se',
      category: 'ruralLocal',
      via: [
        { x: 470, y: -252 },
        { x: 376, y: -274 },
      ],
      lanes: twoWay(3.2),
      centreLine: 'broken',
    },
    {
      id: 'south_link',
      from: 'n_south',
      to: 'n_se',
      category: 'ruralLocal',
      lanes: twoWay(3.2),
      centreLine: 'broken',
    },
    {
      id: 'regional',
      from: 'n_south',
      to: 'n_sw',
      category: 'regional',
      lanes: twoWay(3.6),
      centreLine: 'broken',
    },
    {
      id: 'west_link',
      from: 'n_sw',
      to: 'n_west',
      category: 'ruralLocal',
      via: [
        { x: -306, y: -196 },
        { x: -334, y: -104 },
      ],
      lanes: twoWay(3.2),
      centreLine: 'broken',
    },
  ],
}

/** Where a drive starts: westbound on the main street, in the left lane. */
export const START = { edgeId: 'main_e', s: 140, laneIndex: 0 } as const

/** Single-carriageway one-way lane set, kept here for future bus-lane work. */
export const oneWay = (width = 3.5) => [generalLane(1, width)]
