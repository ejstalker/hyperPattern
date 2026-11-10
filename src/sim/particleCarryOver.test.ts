import { describe, expect, it } from 'vitest';
import { carryParticles, poseFitsCloth } from './particleCarryOver';

/** A 2×2 grid of particles, one unit apart, all lying flat. */
function grid(step = 1): Float32Array {
  const out: number[] = [];
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) out.push(x * step, y * step, 0);
  }
  return new Float32Array(out);
}

/** The same grid, lifted a little and moving. */
function liftedGrid(step = 1): { positions: Float32Array; velocities: Float32Array } {
  const positions: number[] = [];
  const velocities: number[] = [];
  for (let i = 0; i < 4; i++) {
    positions.push(i % 2, Math.floor(i / 2), 2);
    velocities.push(0.5, 0, -0.25);
  }
  return { positions: new Float32Array(positions), velocities: new Float32Array(velocities) };
}

describe('carrying a drape onto a new mesh', () => {
  it('hands the same particle to the same particle when the tessellation holds', () => {
    const rest = grid();
    const live = liftedGrid();
    const carried = carryParticles({ rest, ...live }, rest);
    expect(carried).not.toBeNull();
    expect(carried!.positions).toEqual([...live.positions]);
    expect(carried!.velocities).toEqual([...live.velocities]);
  });

  it('gives every new particle the drape of the old one nearest it', () => {
    // The old cloth is a 2×2 grid; the new one is the same grid at half the
    // spacing, so each new particle sits between old ones.
    const rest = grid(2);
    const live = liftedGrid();
    const next = grid(1);
    const carried = carryParticles({ rest, ...live }, next)!;
    expect(carried.positions).toHaveLength(next.length);
    // Every carried particle keeps the lift the old cloth had.
    for (let i = 0; i < next.length / 3; i++) {
      expect(carried.positions[i * 3 + 2]).toBeCloseTo(2, 6);
    }
    // And it sits where the new layout says, not where the old one did.
    expect(carried.positions[0]).toBeCloseTo(next[0]!, 6);
    expect(carried.positions[1]).toBeCloseTo(next[1]!, 6);
  });

  it('moves each new particle by however far its part of the pattern moved', () => {
    const rest = grid(2);
    const live = liftedGrid();
    // One particle in the new layout, half a cell along from the old corner: it
    // takes that corner's drape and the half cell the pattern gained.
    const next = new Float32Array([0.5, 0, 0]);
    const carried = carryParticles({ rest, ...live }, next)!;
    expect(carried.positions[0]).toBeCloseTo(0.5, 6);
    expect(carried.positions[1]).toBeCloseTo(0, 6);
    // And keeps the drape it was carrying, not its rest height.
    expect(carried.positions[2]).toBeCloseTo(2, 6);
  });

  it('keeps each panel to its own fabric, however close the panel next door is', () => {
    // Two panels laid side by side a hair apart: the nearest particle to a new
    // point on the left panel is one of the right panel's, and taking it would
    // drag the two drapes into each other.
    const rest = new Float32Array([0, 0, 0, 0.1, 0, 0, 1, 0, 0, 1.1, 0, 0]);
    const positions = new Float32Array([0, 0, 5, 0.1, 0, 5, 5, 0, 5, 5.1, 0, 5]);
    const pieces = ['left', 'left', 'right', 'right'];
    // The new cloth gains one point on the left, close to the seam between them.
    const nextRest = new Float32Array([0, 0, 0, 0.1, 0, 0, 0.2, 0, 0, 1, 0, 0, 1.1, 0, 0]);
    const nextPieces = ['left', 'left', 'left', 'right', 'right'];
    const carried = carryParticles(
      { rest, positions, pieceIds: pieces },
      nextRest,
      nextPieces
    )!;
    // The new left-hand point takes the left panel's fabric — its lift plus the
    // tenth of a unit the new point sits further along — and not the right
    // panel's, which would have put it out at 4.2.
    expect(carried.positions[6]).toBeCloseTo(0.2, 6);
    expect(carried.positions[8]).toBeCloseTo(5, 6);
    // And the right panel still carries its own.
    expect(carried.positions[9]).toBeCloseTo(5, 6);
    expect(carried.positions[12]).toBeCloseTo(5.1, 6);
    expect(carried.positions[14]).toBeCloseTo(5, 6);
  });

  it('maps rather than copies when a panel is re-indexed', () => {
    // Same number of particles, but the panels have swapped places in the index
    // order: copying index for index would put the wrong fabric on each.
    const rest = new Float32Array([0, 0, 0, 10, 0, 0]);
    const positions = new Float32Array([0, 0, 3, 4, 0, 3]);
    const carried = carryParticles(
      { rest, positions, pieceIds: ['a', 'b'] },
      rest,
      ['b', 'a']
    )!;
    // Particle 0 is now panel "b", so it takes b's drape, travelling the ten
    // units that panel's rest position moved with it.
    expect(carried.positions[2]).toBeCloseTo(3, 6);
    expect(carried.positions[0]).toBeCloseTo(4 - 10, 6);
    expect(carried.positions[1]).toBeCloseTo(0, 6);
  });

  it('falls back to the rest of the cloth when the piece is new', () => {
    // The edit added a panel. Its particles have no counterpart to carry from, so
    // they take the nearest fabric of any piece rather than nothing at all.
    const rest = new Float32Array([0, 0, 0, 1, 0, 0]);
    const positions = new Float32Array([0, 0, 4, 1, 0, 4]);
    const nextRest = new Float32Array([0, 5, 0, 1, 5, 0]);
    const carried = carryParticles(
      { rest, positions, pieceIds: ['kept', 'kept'] },
      nextRest,
      ['kept', 'added']
    )!;
    for (let i = 0; i < 2; i++) {
      // Five units of new layout, on the drape the nearest kept particle held.
      expect(carried.positions[i * 3 + 2]).toBeCloseTo(4, 6);
    }
    expect(carried.positions[0]).toBeCloseTo(0, 6);
    expect(carried.positions[3]).toBeCloseTo(1, 6);
  });

  it('still finds a piece whose moved layout leaves it nowhere near where it was', () => {
    // A panel drafted across the sheet: its new particles are far from its old
    // ones, but they are still that panel's fabric and must not take a neighbour's.
    const rest = new Float32Array([0, 0, 0, 100, 0, 0, 200, 0, 0]);
    const positions = new Float32Array([0, 0, 1, 100, 0, 5, 200, 0, 9]);
    const nextRest = new Float32Array([0, 400, 0, 100, 400, 0, 200, 400, 0]);
    const carried = carryParticles(
      { rest, positions, pieceIds: ['a', 'b', 'c'] },
      nextRest,
      ['a', 'b', 'c']
    )!;
    expect(carried.positions[2]).toBeCloseTo(1, 6);
    expect(carried.positions[5]).toBeCloseTo(5, 6);
    expect(carried.positions[8]).toBeCloseTo(9, 6);
  });

  it('carries a dense re-cut without walking the whole layout per particle', () => {
    // Twenty thousand particles across two panels, re-cut with a few hundred more.
    // The neighbour search is grid-based, so this is a rounding error in a test
    // run rather than the minutes a scan of every particle per particle cost.
    const build = (radius: number) => {
      const rest: number[] = [];
      const ids: string[] = [];
      for (let side = 0; side < 2; side++) {
        const count = Math.round(radius * 170);
        for (let i = 0; i < count; i++) {
          const angle = (side === 0 ? 0 : Math.PI) + (i / count) * Math.PI;
          const r = radius * (0.2 + 0.8 * (i / count));
          rest.push(Math.cos(angle) * r, Math.sin(angle) * r, 0);
          ids.push(side === 0 ? 'left' : 'right');
        }
      }
      return { rest: new Float32Array(rest), ids };
    };
    const before = build(60);
    const live = new Float32Array(before.rest.length);
    for (let i = 0; i < live.length; i += 3) {
      live[i] = before.rest[i]!;
      live[i + 1] = before.rest[i + 1]!;
      live[i + 2] = 3;
    }
    const after = build(60.3);
    const started = performance.now();
    const carried = carryParticles(
      { rest: before.rest, positions: live, pieceIds: before.ids },
      after.rest,
      after.ids
    )!;
    const elapsed = performance.now() - started;
    expect(carried.positions).toHaveLength(after.rest.length);
    // Every particle keeps the drape: a grid search that gave up would leave
    // particles at their rest height.
    for (let i = 2; i < carried.positions.length; i += 3) {
      expect(carried.positions[i]).toBeCloseTo(3, 6);
    }
    expect(elapsed).toBeLessThan(2000);
  });

  it('carries a strip-shaped panel without walking its whole length per particle', () => {
    // A waistband is a strip: hundreds of particles along it, one or two across.
    // A grid whose rows run out before its columns must not keep expanding rings,
    // which is what turned this shape into seconds per drag.
    const strip = (length: number, count: number) => {
      const rest: number[] = [];
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        rest.push((i / count) * length, i % 2 === 0 ? 0 : 0.4, 0);
        ids.push(i < count - 200 ? 'band' : 'tie');
      }
      return { rest: new Float32Array(rest), ids };
    };
    const before = strip(400, 4000);
    const live = new Float32Array(before.rest.length);
    for (let i = 0; i < live.length; i += 3) {
      live[i] = before.rest[i]!;
      live[i + 1] = before.rest[i + 1]!;
      live[i + 2] = 6;
    }
    // The re-cut adds a handful of particles, so no index can be copied across.
    const after = strip(400, 4008);
    const started = performance.now();
    const carried = carryParticles(
      { rest: before.rest, positions: live, pieceIds: before.ids },
      after.rest,
      after.ids
    )!;
    expect(performance.now() - started).toBeLessThan(2000);
    expect(carried.positions).toHaveLength(after.rest.length);
    expect(carried.positions[2]).toBeCloseTo(6, 6);
  });

  it('carries a re-cut that brings a whole new panel', () => {
    // A panel the old cloth never had: nothing to match piece for piece, so its
    // particles take the nearest fabric of the rest of the garment. Every one of
    // them is a search that cannot settle locally, which is what made this shape
    // the slowest of all.
    const build = (extra: boolean) => {
      const rest: number[] = [];
      const ids: string[] = [];
      for (const [index, piece] of ['band', 'left', 'right', ...(extra ? ['ruffle'] : [])].entries()) {
        const count = 6000;
        for (let i = 0; i < count; i++) {
          const t = i / count;
          rest.push(Math.cos(t * Math.PI) * (20 + index) + index * 60, Math.sin(t * Math.PI) * 40, 0);
          ids.push(piece);
        }
      }
      return { rest: new Float32Array(rest), ids };
    };
    const before = build(false);
    const live = new Float32Array(before.rest.length);
    for (let i = 0; i < live.length; i += 3) {
      live[i] = before.rest[i]!;
      live[i + 1] = before.rest[i + 1]!;
      live[i + 2] = 2;
    }
    const after = build(true);
    const started = performance.now();
    const carried = carryParticles(
      { rest: before.rest, positions: live, pieceIds: before.ids },
      after.rest,
      after.ids
    )!;
    expect(performance.now() - started).toBeLessThan(2000);
    expect(carried.positions).toHaveLength(after.rest.length);
    // The new panel keeps a drape rather than falling back to rest.
    expect(carried.positions[carried.positions.length - 1]).toBeCloseTo(2, 6);
  });

  it('refuses a stored pose that belongs to a cloth of another size', () => {
    const threeParticles = new Float32Array(9);
    const fourParticles = new Float32Array(12);
    expect(poseFitsCloth(fourParticles, 4)).toBe(true);
    // A pose captured before the re-cut: same cloth, different tessellation.
    expect(poseFitsCloth(fourParticles, 3)).toBe(false);
    // Too short to be a cloth at all.
    expect(poseFitsCloth(threeParticles, 0)).toBe(false);
    // Nothing to compare against: taken on trust.
    expect(poseFitsCloth(fourParticles, null)).toBe(true);
  });

  it('has nothing to carry when the old cloth had no particles', () => {
    expect(
      carryParticles({ positions: new Float32Array(), rest: new Float32Array() }, grid())
    ).toBeNull();
    expect(
      carryParticles({ positions: new Float32Array([0, 0, 0]), rest: grid() }, new Float32Array())
    ).toBeNull();
  });

  it('refuses when the live positions do not match the rest layout', () => {
    expect(
      carryParticles(
        { positions: new Float32Array([0, 0, 0]), rest: grid() },
        grid()
      )
    ).toBeNull();
  });
});
