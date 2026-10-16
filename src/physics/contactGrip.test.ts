import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { Particle, contactHoldFromGrip } from './Particle';
import { holdTangentialTravel } from './contactHold';

function particleAt(x: number, y: number, z: number, velocity: [number, number, number]) {
  const p = new Particle(vec3.fromValues(x, y, z), vec3.fromValues(0, 1, 0), 1, 0.8, 0);
  vec3.set(p.getVelocity(), velocity[0], velocity[1], velocity[2]);
  return p;
}

describe('contact grip', () => {
  it('keeps the historical velocity model for the old range', () => {
    const p = particleAt(0, 0, 0, [0, 0, 0]);
    p.setContactFriction(0.5);
    expect(p.getContactFrictionRetain()).toBeCloseTo(1 - 0.5 * 0.95, 6);
    expect(p.getContactHold()).toBe(0);
    // The retain saturates (at zero) well inside the old range, which is why the
    // top of the range needed something else to do.
    p.setContactFriction(1.4);
    expect(p.getContactFrictionRetain()).toBe(0);
    p.setContactFriction(20);
    expect(p.getContactFrictionRetain()).toBe(0);
  });

  it('only starts holding above the old ceiling', () => {
    expect(contactHoldFromGrip(0)).toBe(0);
    expect(contactHoldFromGrip(2)).toBe(0);
    expect(contactHoldFromGrip(5)).toBeCloseTo(0.5, 6);
    expect(contactHoldFromGrip(8)).toBe(1);
    expect(contactHoldFromGrip(20)).toBe(1);
  });

  it('holds back the tangential travel it just made, not the normal travel', () => {
    const normal = vec3.fromValues(0, 1, 0);
    // Moving sideways down a slope: the grip should take the sideways slide back.
    const p = particleAt(0, 0, 0, [2, -3, 0]);
    holdTangentialTravel(p, normal, { hold: 1, stepSeconds: 0.5 });
    expect(p.getPosition()[0]).toBeCloseTo(-1, 6);
    // The normal component is left for the projection itself to resolve.
    expect(p.getPosition()[1]).toBeCloseTo(0, 6);

    const halfGrip = particleAt(0, 0, 0, [2, -3, 0]);
    holdTangentialTravel(halfGrip, normal, { hold: 0.5, stepSeconds: 0.5 });
    expect(halfGrip.getPosition()[0]).toBeCloseTo(-0.5, 6);

    const unheld = particleAt(0, 0, 0, [2, -3, 0]);
    holdTangentialTravel(unheld, normal, { hold: 0, stepSeconds: 0.5 });
    expect(unheld.getPosition()[0]).toBe(0);
  });
});
