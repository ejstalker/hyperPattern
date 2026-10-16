// A taut stitch does not let go.
//
// The seam is solved on positions after `finalize` (see `solve_attachment.wgsl`
// and the seam pass in `encodeStep`), which is what keeps a stitch correction
// from being read back out as the pair's velocity. The flip side is that the
// stitch then says nothing about how fast the pair is separating: the fabric's
// own passes push the two rows apart every substep, the projection pulls them
// back on the next one, and on a seam that is not a gather — nothing there to
// fold and take up the slack — that reads as jitter running along the stitch.
//
// So once the seam is closed, its relative velocity along the stitch may only
// close, never part. Momentum-conserving: the change is split by inverse mass,
// so a frozen side stays put, and because only a *separating* component is ever
// removed it can only take energy out, never put it in.

struct Params {
  nConstraints: u32,
  nParticles: u32,
  /** 1 while the seam is closed (the ramp has finished), 0 while it wraps. */
  closed: u32,
  maxSpeed: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> positions: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> velocities: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> invMasses: array<f32>;
@group(0) @binding(4) var<storage, read> stitchIndices: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (params.closed == 0u) { return; }
  let id = gid.x;
  if (id >= params.nConstraints) { return; }

  let i = stitchIndices[id * 2u];
  let j = stitchIndices[id * 2u + 1u];
  if (i >= params.nParticles || j >= params.nParticles || i == j) { return; }

  let wi = invMasses[i];
  let wj = invMasses[j];
  let wSum = wi + wj;
  if (wSum <= 0.0) { return; }

  let diff = positions[i].xyz - positions[j].xyz;
  let distance = length(diff);
  if (distance < 1e-8) { return; }
  let nrm = diff / distance;

  // Positive when the pair is pulling apart; only that is removed.
  let rel = dot(velocities[i].xyz - velocities[j].xyz, nrm);
  if (rel <= 0.0) { return; }

  let share = nrm * (rel / wSum);
  velocities[i] = vec4<f32>(velocities[i].xyz - share * wi, 0.0);
  velocities[j] = vec4<f32>(velocities[j].xyz + share * wj, 0.0);
}
