import { bench, describe } from 'vitest';
import { carryParticles } from './particleCarryOver';

/**
 * A skirt's worth of particles: a waistband ring plus two half-panels, close to
 * the scale the mesh settings make at a 1 cm target edge.
 */
function skirt(radiusCm: number, stepCm: number, pieces: string[]) {
  const rest: number[] = [];
  const pieceIds: string[] = [];
  const half = Math.PI;
  for (const [index, piece] of pieces.entries()) {
    const counts = piece === 'band' ? Math.round(120 * (radiusCm / 6)) : Math.round(160 * radiusCm);
    for (let i = 0; i < counts; i++) {
      const t = (i / counts) * half;
      const angle = (index === 1 ? -half : 0) + t;
      const r = piece === 'band' ? 6 : radiusCm * (0.15 + 0.85 * (i / counts));
      // Extra pieces sit beyond the skirt, the way a drafted block sits apart.
      const offset = Math.max(0, index - 2) * radiusCm * 2;
      rest.push(Math.cos(angle) * r + offset, Math.sin(angle) * r, 0);
      pieceIds.push(piece);
    }
  }
  return { rest: new Float32Array(rest), pieceIds };
}

function live(rest: Float32Array, lift: number): Float32Array {
  const out = new Float32Array(rest.length);
  for (let i = 0; i < rest.length; i += 3) {
    out[i] = rest[i]!;
    out[i + 1] = rest[i + 1]!;
    out[i + 2] = lift;
  }
  return out;
}

const old = skirt(60, 1, ['band', 'left', 'right']);
const oldLive = live(old.rest, 12);
// The same cut, nudged: a handful of particles gained, every particle the same
// piece as before.
const nudged = skirt(60.4, 1, ['band', 'left', 'right']);
// A cut that also brings a piece the old cloth never had.
const added = skirt(60, 1, ['band', 'left', 'right', 'ruffle']);

// A waistband: hundreds of particles along it, one or two across, plus a tie the
// edit added — the shape that turned a ring walk into a walk of the whole layout.
function strip(lengthCm: number, count: number) {
  const rest: number[] = [];
  const pieceIds: string[] = [];
  for (let i = 0; i < count; i++) {
    rest.push((i / count) * lengthCm, i % 2 === 0 ? 0 : 0.4, 0);
    pieceIds.push(i < count - 200 ? 'band' : 'tie');
  }
  return { rest: new Float32Array(rest), pieceIds };
}

const stripBefore = strip(400, 4000);
// The re-cut brings a few more particles, so every index means something else.
const stripAfter = strip(400, 4008);

describe('carrying a drape onto a new mesh', () => {
  bench(`nudged points, ${Math.round(old.rest.length / 3)} particles`, () => {
    carryParticles(
      { rest: old.rest, positions: oldLive, pieceIds: old.pieceIds },
      nudged.rest,
      nudged.pieceIds
    );
  });

  bench('strip panel with a new tie, 4008 particles', () => {
    carryParticles(
      { rest: stripBefore.rest, positions: live(stripBefore.rest, 6), pieceIds: stripBefore.pieceIds },
      stripAfter.rest,
      stripAfter.pieceIds
    );
  });

  bench(`new piece, ${Math.round(added.rest.length / 3)} particles`, () => {
    carryParticles(
      { rest: old.rest, positions: oldLive, pieceIds: old.pieceIds },
      added.rest,
      added.pieceIds
    );
  });
});
