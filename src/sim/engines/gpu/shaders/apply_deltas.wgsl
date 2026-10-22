// Resolve the cloth–cloth contacts accumulated by collide_particles.wgsl.
//
// The correction lands on `predicted` — the substep's working positions — so the
// next pass of the iteration loop solves against cloth that is already separated
// rather than against the penetration it just made. Nothing here touches the
// velocities: they are read off the converged positions by `finalize`.
//
// The push is capped per pass for the same reason the body contact's is (see
// collide_sdf.wgsl): extracting a whole penetration at once throws a particle a
// diameter away from where it was, and the stretch solve then has to reel it
// back — motion the cloth never asked for. A fraction of an edge per pass still
// clears a fold within a substep.

const INV_DELTA_SCALE: f32 = 1.0 / 1048576.0; // 2^20

struct Params {
  n: u32,
  _pad0: u32,
  relaxation: f32,
  pushFraction: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> predicted: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> delta: array<atomic<i32>>;
// (inverse mass, mean incident edge length) — the per-particle push budget.
@group(0) @binding(3) var<storage, read> massEdge: array<vec4<f32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let o = i * 4u;
  let count = atomicLoad(&delta[o + 3u]);
  if (count > 0) {
    let dx = f32(atomicLoad(&delta[o]));
    let dy = f32(atomicLoad(&delta[o + 1u]));
    let dz = f32(atomicLoad(&delta[o + 2u]));
    var avg = vec3<f32>(dx, dy, dz) * (INV_DELTA_SCALE / f32(count)) * params.relaxation;
    let len = length(avg);
    let maxPush = max(massEdge[i].y * params.pushFraction, 1e-4);
    if (len > maxPush) {
      avg = avg * (maxPush / len);
    }
    predicted[i] = vec4<f32>(predicted[i].xyz + avg, 0.0);
  }
  atomicStore(&delta[o], 0);
  atomicStore(&delta[o + 1u], 0);
  atomicStore(&delta[o + 2u], 0);
  atomicStore(&delta[o + 3u], 0);
}
