import type { CameraParams } from '../render/cameras'
import type { VehicleParams } from '../sim/vehicle'
import type { FieldSpec } from './tuner'

export const VEHICLE_FIELDS: FieldSpec<VehicleParams>[] = [
  { key: 'maxAccel', label: 'Launch acceleration', min: 1, max: 8, step: 0.1, unit: 'm/s²' },
  { key: 'enginePowerKw', label: 'Engine power', min: 30, max: 220, step: 5, unit: 'kW' },
  { key: 'maxBrakeDecel', label: 'Braking', min: 3, max: 14, step: 0.2, unit: 'm/s²' },
  { key: 'engineBrakeDecel', label: 'Engine braking', min: 0, max: 3, step: 0.05, unit: 'm/s²' },
  { key: 'maxSteerDeg', label: 'Steering lock', min: 20, max: 45, step: 1, unit: '°' },
  { key: 'steerRateDegPerSec', label: 'Steering speed', min: 30, max: 240, step: 5, unit: '°/s' },
  { key: 'steerReturnDegPerSec', label: 'Self-centring', min: 30, max: 300, step: 5, unit: '°/s' },
  { key: 'maxLatAccel', label: 'Grip ceiling', min: 3, max: 12, step: 0.1, unit: 'm/s²' },
  { key: 'wheelbase', label: 'Wheelbase', min: 2.2, max: 3.2, step: 0.05, unit: 'm' },
  { key: 'mass', label: 'Mass', min: 900, max: 2200, step: 25, unit: 'kg' },
  { key: 'rollingResistance', label: 'Rolling resistance', min: 0, max: 0.6, step: 0.01, unit: 'm/s²' },
  { key: 'maxSpeedKmh', label: 'Top speed', min: 60, max: 220, step: 5, unit: 'km/h' },
]

/** Plain geometry only — no speed-dependent behaviour to tune. */
export const CAMERA_FIELDS: FieldSpec<CameraParams>[] = [
  { key: 'height', label: 'Camera height', min: 0.8, max: 6, step: 0.05, unit: 'm' },
  { key: 'distance', label: 'Camera distance', min: 3, max: 16, step: 0.1, unit: 'm' },
  { key: 'fov', label: 'Field of view', min: 40, max: 90, step: 1, unit: '°' },
  { key: 'lookAhead', label: 'Look ahead', min: 0, max: 40, step: 1, unit: 'm' },
  { key: 'overheadHeight', label: 'Overhead height', min: 10, max: 60, step: 1, unit: 'm' },
]
