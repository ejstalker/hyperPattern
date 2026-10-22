import { CM_TO_WORLD } from './units';
import type { ProjectDocument, SimCameraState } from '../project/types';

/**
 * How tall the default avatar stands in the scene. `me01_low1.obj` is 1.82 m
 * from sole to crown and these runtimes keep 1 world unit = 10 cm, so the
 * figure is ~18 units tall with its feet on the floor at y = 0.
 */
export const AVATAR_HEIGHT_WORLD = 18.2;

/** Orbit target: halfway up the avatar, so the view is framed on the torso. */
export const ORBIT_HEIGHT_WORLD = AVATAR_HEIGHT_WORLD / 2;

/** Eye height: just over the top of the head, looking gently down at the torso. */
export const ORBIT_EYE_HEIGHT_WORLD = AVATAR_HEIGHT_WORLD * 1.06;

/** Orbit radius: far enough back to hold the whole figure in a 45° frame. */
export const ORBIT_DISTANCE_WORLD = 30;

const DRAPE_A_SIM_NAME = 'Drape A';

const DEFAULT_AZIMUTH = 0.35;

/** Gentle look-down from the eye height to the torso — 20° off the level. */
const DEFAULT_ELEVATION = Math.asin(
  (ORBIT_EYE_HEIGHT_WORLD - ORBIT_HEIGHT_WORLD) / ORBIT_DISTANCE_WORLD
);

/**
 * Default 3D viewport camera — level with the figure rather than looking down
 * on it: the aim point sits at half the avatar's height and the eye just above
 * the crown, which is the angle a fitting is actually judged from.
 */
export let DEFAULT_SIM_CAMERA: SimCameraState = {
  distance: ORBIT_DISTANCE_WORLD,
  azimuth: DEFAULT_AZIMUTH,
  elevation: DEFAULT_ELEVATION,
  target: orbitTarget(0, ORBIT_HEIGHT_WORLD, 0, DEFAULT_AZIMUTH, DEFAULT_ELEVATION),
};

/**
 * The viewports store their aim point as a pan in *camera* space, not the world:
 * the eye lands at `R·((0,0,distance) − target)` and the camera looks back at
 * `R·(−target)`. So a world point has to be rotated by `R⁻¹ = Rx(elevation) ·
 * Ry(azimuth)` and negated before it can be written as a `target` — feeding the
 * world height straight in aims the camera somewhere else entirely, which is how
 * the old default ended up pointing below the avatar's feet.
 */
export function orbitTarget(
  x: number,
  y: number,
  z: number,
  azimuth: number,
  elevation: number
): [number, number, number] {
  const ca = Math.cos(azimuth);
  const sa = Math.sin(azimuth);
  const ce = Math.cos(elevation);
  const se = Math.sin(elevation);
  const rx = x * ca + z * sa;
  const rz = -x * sa + z * ca;
  // Rx(elevation) · Ry(azimuth) · (x, y, z), then negated.
  return [-rx, -(y * ce - rz * se), -(y * se + rz * ce)];
}

/** The world height a stored camera is pointing at. */
export function cameraAimHeight(camera: SimCameraState): number {
  const ce = Math.cos(camera.elevation);
  const se = Math.sin(camera.elevation);
  return -camera.target[1] * ce - camera.target[2] * se;
}

/**
 * The framing this app used to bake in, when the orbit was pinned at hip height
 * with a steep look-down. A camera that still matches it, to the millimetre, was
 * never touched by hand, so it is safe to re-frame on load.
 */
const RETIRED_DEFAULT = {
  distance: 30,
  elevation: 0.78,
  targetY: 6.096,
} as const;

function isRetiredDefault(camera: SimCameraState): boolean {
  return (
    Math.abs(camera.distance - RETIRED_DEFAULT.distance) < 0.01 &&
    Math.abs(camera.elevation - RETIRED_DEFAULT.elevation) < 0.001 &&
    Math.abs(camera.target[1] - RETIRED_DEFAULT.targetY) < 0.01
  );
}

function adoptDefaults(camera: SimCameraState, defaults: SimCameraState): void {
  Object.assign(camera, cloneSimCamera(defaults));
  camera.target = [...defaults.target] as [number, number, number];
}

export function cloneSimCamera(camera: SimCameraState): SimCameraState {
  return {
    distance: camera.distance,
    azimuth: camera.azimuth,
    elevation: camera.elevation,
    target: [camera.target[0], camera.target[1], camera.target[2]],
  };
}

/** Update baked defaults when Drape A's camera changes. */
export function setDefaultSimCamera(camera: SimCameraState): void {
  DEFAULT_SIM_CAMERA = cloneSimCamera(camera);
}

export function getDefaultSimCamera(project?: ProjectDocument): SimCameraState {
  const fromDrapeA = drapeASim(project)?.camera;
  if (fromDrapeA && !isRetiredDefault(fromDrapeA)) return cloneSimCamera(fromDrapeA);
  return cloneSimCamera(DEFAULT_SIM_CAMERA);
}

function drapeASim(project?: ProjectDocument) {
  return project?.sims.find((sim) => sim.name === DRAPE_A_SIM_NAME);
}

/** Pull the current Drape A camera into module defaults (orbit height + framing). */
export function syncDefaultCameraFromDrapeA(project: ProjectDocument): void {
  const drapeA = drapeASim(project);
  if (!drapeA?.camera) return;
  // A Drape A still parked on the retired framing has nothing to say about
  // where the camera should sit, so it takes the current default instead.
  if (isRetiredDefault(drapeA.camera)) {
    adoptDefaults(drapeA.camera, DEFAULT_SIM_CAMERA);
    return;
  }
  setDefaultSimCamera(drapeA.camera);
}

/** Upgrade cameras saved before the avatar collider framing pass. */
export function migrateLegacySimCamera(
  camera: SimCameraState,
  defaults: SimCameraState = DEFAULT_SIM_CAMERA
): void {
  if (isRetiredDefault(camera)) {
    adoptDefaults(camera, defaults);
    return;
  }
  // Old framing is recognised by where the camera sits, not by the sign of its
  // pan: the pan is a camera-space offset, so a hand-moved camera can read
  // positive or negative and still be perfectly framed.
  const legacyOrbitY = 1.5;
  const looksLegacy = camera.distance <= 14 || Math.abs(camera.target[1] - legacyOrbitY) < 0.01;
  if (looksLegacy) {
    adoptDefaults(camera, defaults);
    return;
  }
  ensureAvatarFraming(camera, defaults);
}

function ensureAvatarFraming(camera: SimCameraState, defaults: SimCameraState): void {
  if (camera.distance >= 20) return;
  adoptDefaults(camera, defaults);
}

/** Inches → world units helper (1 world unit = 10 cm). */
export function inchesToOrbitWorld(inches: number): number {
  return inches * 2.54 * CM_TO_WORLD;
}
