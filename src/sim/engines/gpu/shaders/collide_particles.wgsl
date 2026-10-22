// Spatial-hash cloth–cloth contact (Velvet-style particle–particle).
// Hash: cell = floor(p / cellSize); 27-neighbor lookup via flat table.
//
// Contact is a *constraint*, and it is solved with the others: within the
// iteration loop, on `predicted`, interleaved with stretch and bend. Solving it
// once and apart from them does not settle — before the loop the positions are
// re-opened by the next stretch pass, after `finalize` the next substep pulls
// the separation straight back in, and either way the cloth is left with speed
// it never asked for (a fabric that inflates, climbs and buzzes).
//
// Storage buffers are packed to stay within maxStorageBuffersPerShaderStage (8):
//   predicted        = the substep's working positions (read/written by apply)
//   initialPositions = the flat layout, for the rest-pair filter
//   massEdge         = (inverse mass, mean incident edge length)
//   cellStart        = spatial-hash bucket ranges
//   particleIds      = particle index per bucket slot
//   velocities       = this substep's velocities, for Coulomb friction on the slip
//   delta            = (x, y, z, contactCount) per particle — position correction
//   sewn             = CSR of the particles each point is sewn to

struct Params {
  n: u32,
  tableSize: u32,
  invCell: f32,
  diameterScalar: f32,
  scale: f32,
  /** Coulomb bound per pass — the substep's μ already divided by the passes. */
  mu: f32,
  maxNeighbors: u32,
  /** Slip budget per pass — the substep's h already divided by the passes. */
  dt: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> positions: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> initialPositions: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> massEdge: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> cellStart: array<u32>;
@group(0) @binding(5) var<storage, read> particleIds: array<u32>;
@group(0) @binding(6) var<storage, read> velocities: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> delta: array<atomic<i32>>;
@group(0) @binding(8) var<storage, read> sewn: array<u32>;

fn hashCell(c: vec3<i32>) -> u32 {
  let x = u32(c.x) * 73856093u;
  let y = u32(c.y) * 19349663u;
  let z = u32(c.z) * 83492791u;
  return (x ^ y ^ z) % params.tableSize;
}

/**
 * Whether these two points are stitched to each other.
 *
 * A seam holds its two rows a couple of millimetres apart — closer than any
 * cloth thickness — so contact between a pair the seam has joined is a fight the
 * fabric can never win: the seam pulls, the contact pushes, and the two of them
 * drag the garment around the body for as long as the sim runs. They are one
 * piece of cloth now; the seam is the constraint that owns their distance.
 */
fn isSewn(i: u32, j: u32) -> bool {
  let a = sewn[i];
  let b = sewn[i + 1u];
  let base = params.n + 1u;
  for (var k = a; k < b; k++) {
    if (sewn[base + k] == j) { return true; }
  }
  return false;
}

fn atomicAddVec(i: u32, d: vec3<f32>) {
  let o = i * 4u;
  atomicAdd(&delta[o], i32(d.x * params.scale));
  atomicAdd(&delta[o + 1u], i32(d.y * params.scale));
  atomicAdd(&delta[o + 2u], i32(d.z * params.scale));
  atomicAdd(&delta[o + 3u], 1);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let wi = massEdge[i].x;
  if (wi <= 0.0) { return; }
  let diSelf = massEdge[i].y * params.diameterScalar;
  let pi = positions[i].xyz;
  let vi = velocities[i].xyz;
  let cell = vec3<i32>(floor(pi * params.invCell));

  for (var ox = -1; ox <= 1; ox++) {
    for (var oy = -1; oy <= 1; oy++) {
      for (var oz = -1; oz <= 1; oz++) {
        let h = hashCell(cell + vec3<i32>(ox, oy, oz));
        let start = cellStart[h];
        let count = min(cellStart[h + 1u] - start, params.maxNeighbors);
        for (var n = 0u; n < count; n++) {
          let j = particleIds[start + n];
          if (j <= i) { continue; }
          // Per-pair diameter (mean of the two particle diameters).
          let di = 0.5 * (diSelf + massEdge[j].y * params.diameterScalar);
          let pj = positions[j].xyz;
          let diff = pi - pj;
          let dist = length(diff);
          // Narrow phase first: everything below costs more and only matters for
          // the handful of pairs that are actually inside one another.
          if (dist >= di || dist < 1e-8) { continue; }
          // Pairs that sit inside one another in the flat layout are the same
          // piece feeding through itself (a fold laid flat) or a mesh's own
          // neighbours (an edge, or the diagonal across a quad): separating them
          // would fight the pattern they were cut from, without a per-pair ring
          // lookup on every candidate.
          let p0 = initialPositions[i].xyz;
          let p1 = initialPositions[j].xyz;
          let restSkip = max(di, 1.5 * 0.5 * (massEdge[i].y + massEdge[j].y));
          if (length(p0 - p1) < restSkip) { continue; }
          if (isSewn(i, j)) { continue; }
          let wj = massEdge[j].x;
          if (wi + wj <= 0.0) { continue; }
          let nrm = diff / dist;
          let lambda = -(dist - di) / (wi + wj);
          var corr = nrm * lambda;

          // Coulomb friction on the tangential *slip*, bounded by the normal
          // correction this pair just asked for: a layer pressed by μ·depth of
          // normal work may give back at most that much tangential travel, so
          // slack folds settle instead of sliding over each other forever.
          //
          // Both budgets are per *substep*, and this runs once per iteration, so
          // the engine hands them over already divided by the iteration count.
          // Without that the friction is applied six times over and the pair is
          // shoved back further than it ever slipped — which is the buzz, not the
          // grip.
          let vrel = vi - velocities[j].xyz;
          let vn = dot(vrel, nrm);
          let slip = vrel - nrm * vn;
          let slipLen = length(slip);
          if (slipLen > 1e-6) {
            let allowed = min(params.mu * (di - dist), slipLen * params.dt) / (wi + wj);
            if (allowed > 0.0) {
              corr -= (slip / slipLen) * allowed;
            }
          }

          atomicAddVec(i, wi * corr);
          atomicAddVec(j, -wj * corr);
        }
      }
    }
  }
}
