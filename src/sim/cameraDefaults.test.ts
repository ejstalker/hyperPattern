import { describe, expect, it } from 'vitest';
import {
  AVATAR_HEIGHT_WORLD,
  DEFAULT_SIM_CAMERA,
  cameraAimHeight,
  cloneSimCamera,
  migrateLegacySimCamera,
  orbitTarget,
  syncDefaultCameraFromDrapeA,
} from './cameraDefaults';
import { createSmallFixture } from '../persistence/fixtures';
import type { SimCameraState } from '../project/types';

/**
 * Where the camera ends up. The runtimes pan in camera space, so the eye is
 * `R·((0,0,distance) − target)`; this mirrors that in world space.
 */
function eyePosition(camera: SimCameraState): [number, number, number] {
  const v: [number, number, number] = [
    -camera.target[0],
    -camera.target[1],
    camera.distance - camera.target[2],
  ];
  const ce = Math.cos(camera.elevation);
  const se = Math.sin(camera.elevation);
  const y = v[1] * ce + v[2] * se;
  const z = -v[1] * se + v[2] * ce;
  const ca = Math.cos(camera.azimuth);
  const sa = Math.sin(camera.azimuth);
  return [v[0] * ca - z * sa, y, v[0] * sa + z * ca];
}

const retired: SimCameraState = {
  distance: 30,
  azimuth: 0.35,
  elevation: 0.78,
  target: [0, 6.096, 0],
};

describe('default sim camera', () => {
  it('aims at the middle of the avatar', () => {
    expect(cameraAimHeight(DEFAULT_SIM_CAMERA)).toBeCloseTo(AVATAR_HEIGHT_WORLD / 2, 6);
  });

  it('puts the eye just above the top of the avatar', () => {
    const eyeY = eyePosition(DEFAULT_SIM_CAMERA)[1];
    expect(eyeY).toBeGreaterThan(AVATAR_HEIGHT_WORLD);
    expect(eyeY).toBeLessThan(AVATAR_HEIGHT_WORLD * 1.15);
  });

  it('mirrors a world point into the camera-space target', () => {
    const target = orbitTarget(1.5, 9.1, -2, 0.35, 0.34);
    const camera: SimCameraState = {
      distance: 30,
      azimuth: 0.35,
      elevation: 0.34,
      target,
    };
    // The height survives the rotation; the pan carries the full point.
    expect(cameraAimHeight(camera)).toBeCloseTo(9.1, 6);
    expect(target[1]).toBeLessThan(0);
  });

  it('keeps the whole figure in the frame at 45°', () => {
    const halfFrame = DEFAULT_SIM_CAMERA.distance * Math.tan((45 * Math.PI) / 360);
    expect(halfFrame * 2).toBeGreaterThan(AVATAR_HEIGHT_WORLD);
  });
});

describe('migrateLegacySimCamera', () => {
  it('re-frames a camera still on the retired default', () => {
    const camera = cloneSimCamera(retired);
    migrateLegacySimCamera(camera);
    expect(camera.target[1]).toBeCloseTo(DEFAULT_SIM_CAMERA.target[1], 6);
    expect(camera.elevation).toBeCloseTo(DEFAULT_SIM_CAMERA.elevation, 6);
  });

  it('leaves a camera the user has moved alone', () => {
    const camera: SimCameraState = {
      distance: 26,
      azimuth: -0.6,
      elevation: 0.2,
      target: [1, 8.4, -0.5],
    };
    const before = cloneSimCamera(camera);
    migrateLegacySimCamera(camera);
    expect(camera).toEqual(before);
  });
});

describe('syncDefaultCameraFromDrapeA', () => {
  it('replaces an untouched Drape A camera with the current default', () => {
    const project = createSmallFixture();
    const base = project.sims[0];
    project.sims = [
      {
        ...base,
        id: 'sim_drape_a',
        name: 'Drape A',
        camera: cloneSimCamera(retired),
      },
    ];
    syncDefaultCameraFromDrapeA(project);
    expect(project.sims[0].camera.target[1]).toBeCloseTo(DEFAULT_SIM_CAMERA.target[1], 6);
  });

  it('keeps a Drape A camera the user has framed', () => {
    const project = createSmallFixture();
    const base = project.sims[0];
    const framed: SimCameraState = {
      distance: 22,
      azimuth: 0.1,
      elevation: 0.15,
      target: [0, 9, 1],
    };
    project.sims = [
      {
        ...base,
        id: 'sim_drape_a',
        name: 'Drape A',
        camera: cloneSimCamera(framed),
      },
    ];
    syncDefaultCameraFromDrapeA(project);
    expect(project.sims[0].camera).toEqual(framed);
  });
});
