// XPBD distance constraint with an accumulated Lagrange multiplier.
//
// Uses the true XPBD update Δλ = (−C − α̃λ) / (w₁+w₂+α̃) with α̃ = α/h², so
// `compliance` is timestep-independent (the previous form multiplied C by a raw
// softness fraction, which made stiffness drift with substep count).
//
// λ is reset to 0 at the start of every substep (reset_lambdas.wgsl).
//
// `slack` is this edge's crowd floor, as a share of its rest length, and it is
// 1 for ordinary fabric: the constraint is then two-sided, exactly as it was
// before gathers were a feature. Only the row along the long side of a gathered
// seam gets a lower floor — fabric with somewhere to go, which crowds and folds
// instead of pushing back at the stitch cinching it. The floor comes from the
// seam's own length mismatch, so a row may give exactly what its seam needs and
// nothing more.

struct Params {
  offset: u32,
  count: u32,
  compliance: f32,
  nParticles: u32,
  invH2: f32,
  /** How much softer a gathered row is at the start of its crowd range. */
  crowdSoftness: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> predicted: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> invMasses: array<f32>;
@group(0) @binding(3) var<storage, read> stretchIndices: array<u32>;
@group(0) @binding(4) var<storage, read> stretchRest: array<f32>;
@group(0) @binding(5) var<storage, read_write> lambdas: array<f32>;
@group(0) @binding(6) var<storage, read> slack: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.count) { return; }
  let id = params.offset + gid.x;
  let idx1 = stretchIndices[id * 2u];
  let idx2 = stretchIndices[id * 2u + 1u];
  if (idx1 >= params.nParticles || idx2 >= params.nParticles || idx1 == idx2) { return; }

  let expected = stretchRest[id];
  if (!(expected > 1e-8)) { return; }

  let w1 = invMasses[idx1];
  let w2 = invMasses[idx2];
  let wSum = w1 + w2;
  if (wSum <= 0.0) { return; }

  let p1 = predicted[idx1].xyz;
  let p2 = predicted[idx2].xyz;
  let diff = p1 - p2;
  let distance = length(diff);
  if (distance < 1e-8) { return; }

  let nrm = diff / distance;
  var C = distance - expected;

  // Ordinary fabric: the floor is the rest length, so there is no crowd range
  // and this is the same two-sided constraint it has always been.
  let floor = expected * slack[id];
  let span = expected - floor;
  let crowds = span > 1e-6;
  // How deep into a gathered row's crowd range this edge has settled: 0 at the
  // rest length, 1 down at the floor.
  var crowd = 0.0;
  if (crowds) {
    crowd = clamp((expected - distance) / span, 0.0, 1.0);
    // Below the floor the fabric is being crushed rather than gathered, so it
    // pushes back at full stiffness.
    if (distance < floor) {
      C = distance - floor;
      crowd = 1.0;
    }
  }
  if (C == 0.0 && crowd == 0.0) { return; }

  // Color-class Gauss–Seidel: no shared vertices within a dispatch → safe stores.
  //
  // A gathered row eases into its gather instead of slamming between free travel
  // and a rigid wall: the response starts soft and stiffens as the fabric runs
  // out of folds. A hard floor lets the stitch squeeze the row against a wall
  // every substep, and that chatter is what keeps a gathered panel buzzing long
  // after it should have settled. Only a row with folds to give is softened —
  // everywhere else `softness` is 1 and the fabric keeps its own stiffness.
  let base = max(params.compliance, 0.0) * params.invH2;
  let softness = select(1.0, mix(max(params.crowdSoftness, 1.0), 1.0, crowd), crowds);
  let alphaTilde = base * softness;
  let lambda = lambdas[id];
  let dLambda = (-C - alphaTilde * lambda) / (wSum + alphaTilde);
  lambdas[id] = lambda + dLambda;

  predicted[idx1] = vec4<f32>(p1 + nrm * (w1 * dLambda), 0.0);
  predicted[idx2] = vec4<f32>(p2 - nrm * (w2 * dLambda), 0.0);
}
