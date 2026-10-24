import { vec3, quat, mat4 } from 'gl-matrix';
import type { AvatarBody } from '../../../mesh/AvatarBody';
import { Ground } from '../../../Ground';
import { Particle, contactHoldFromGrip } from '../../../physics/Particle';
import { identity } from '../../../utils/math';
import type { MeshGeometry, PatternDocument, SimParams, SimPose } from '../../../project/types';
import type { ClothCollider, ClothFloor, ClothSimulator } from '../../ClothSimulator';
import { buildClothTopology, FALLBACK_PIECE_ID, type ClothTopology } from '../../meshTopology';
import { buildWireframeEdgeIndices } from '../../wireframeEdges';
import { colorConstraints, colorStretchConstraints } from '../../graphColoring';
import { fillStrainColors, type StrainEdge } from '../../strainMap';
import {
  createDummySdfTexture,
  createSdfGpuTexture,
  packObstacles,
  type ObstacleGpu,
} from './sdfGpuTexture';

import predictWgsl from './shaders/predict.wgsl?raw';
import solveStretchWgsl from './shaders/solve_stretch.wgsl?raw';
import solveAttachmentWgsl from './shaders/solve_attachment.wgsl?raw';
import solveStitchVelocityWgsl from './shaders/solve_stitch_velocity.wgsl?raw';
import applyDeltasWgsl from './shaders/apply_deltas.wgsl?raw';
import finalizeWgsl from './shaders/finalize.wgsl?raw';
import computeNormalsWgsl from './shaders/compute_normals.wgsl?raw';
import collideSdfWgsl from './shaders/collide_sdf.wgsl?raw';
import collideParticlesWgsl from './shaders/collide_particles.wgsl?raw';
import strainLimitWgsl from './shaders/strain_limit.wgsl?raw';
import resetLambdasWgsl from './shaders/reset_lambdas.wgsl?raw';
import hashBuildWgsl from './shaders/hash_build.wgsl?raw';
import { FROZEN_PIECE_OPACITY, GHOSTED_PIECE_OPACITY } from '../../pieceOpacity';
import { ghostInverseMass } from '../../ghostMass';
import { DEFAULT_MAX_SPEED } from '../../../project/createDefault';
import { perSubstepRetain } from '../../velocityDamping';
import { relaxContactPush } from '../../contactRelax';

const DELTA_SCALE = 1 << 20;


/** How far apart cloth–cloth contact holds two points, in mesh edges. */
const DEFAULT_CONTACT_EDGES = 0.5;
/**
 * A contact can be no thicker than half an edge.
 *
 * Thickness and the seam model have to agree: a seam holds its two rows about a
 * millimetre and a half apart, so a fabric "two edges thick" cannot have a seam
 * at all — the stitch pulls the rows together, the contact pushes them apart,
 * and the pair is dragged around the body for as long as the sim runs. At half
 * an edge the layers can still pass each other no more than a fold's thickness
 * while a seam is a seam.
 */
const MAX_CONTACT_EDGES = 0.5;

function clampContactEdges(edges: number): number {
  return Math.min(MAX_CONTACT_EDGES, Math.max(0.05, edges));
}
/**
 * Slower sew so panels wrap around the body instead of tunneling through it.
 * Seam clamp-safety comes from the attach kernel's per-pass `maxClose` budget,
 * not a global velocity cap (which starved long/thin pieces).
 */
const SEAM_RAMP_SECONDS = 6.0;

/**
 * How much softer a gathered row is at the start of its crowd range than at the
 * floor.
 *
 * The fabric has folds to give, so compressing it is cheap — until it runs out,
 * where it should stop. Making that a rigid wall instead lets the stitch squeeze
 * the row against it every substep, and a sewn panel then buzzes and churns for
 * as long as the sim runs. Softening the top of the range turns the wall into a
 * gradient the fabric can settle into.
 */
const SEAM_CROWD_SOFTNESS = 60;
const WG = 256;

function groups(n: number): number {
  return Math.max(1, Math.ceil(n / WG));
}

/**
 * XPBD compliance (1/stiffness). `0` = hard PBD stretch. When the param is
 * absent, derive it from the fabric spring constant (stiffer spring → smaller
 * compliance).
 */
function stretchComplianceFromParams(params: SimParams): number {
  if (params.stretchCompliance != null && Number.isFinite(params.stretchCompliance)) {
    return Math.max(0, Math.min(1, params.stretchCompliance));
  }
  const k = Math.min(5000, Math.max(100, params.springConst));
  return 1 / k;
}

/** XPBD bend compliance (1/stiffness). Higher = floppier; 0 = rigid. */
function bendComplianceFromParams(params: SimParams): number {
  const c = params.bendCompliance;
  if (c != null && Number.isFinite(c)) return Math.max(0, Math.min(1, c));
  // Mirror the CPU bend-spring scale (bendSpringScale × springConst).
  const scale = Math.max(0, params.bendSpringScale ?? 0.2);
  if (scale <= 0) return 1e9; // effectively disabled
  return Math.max(0, Math.min(1, 1 / (Math.min(5000, Math.max(100, params.springConst)) * scale)));
}

/** Copy typed array into an ArrayBuffer-backed view for WebGPU writeBuffer. */
function gpuData(data: ArrayBufferView): GPUAllowSharedBufferSource {
  const copy = new Uint8Array(data.byteLength);
  copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return copy;
}

function rayTriangle(
  origin: vec3,
  dir: vec3,
  v0: vec3,
  v1: vec3,
  v2: vec3,
  eps: number
): number | null {
  const edge1 = vec3.create();
  const edge2 = vec3.create();
  vec3.sub(edge1, v1, v0);
  vec3.sub(edge2, v2, v0);
  const pvec = vec3.create();
  vec3.cross(pvec, dir, edge2);
  const det = vec3.dot(edge1, pvec);
  if (Math.abs(det) < eps) return null;
  const invDet = 1 / det;
  const tvec = vec3.create();
  vec3.sub(tvec, origin, v0);
  const u = vec3.dot(tvec, pvec) * invDet;
  if (u < 0 || u > 1) return null;
  const qvec = vec3.create();
  vec3.cross(qvec, tvec, edge1);
  // Möller–Trumbore: v uses the ray direction. Using edge2 here made the
  // barycentric test geometry-dependent and caused GPU cloth picks to fail
  // once simulation deformed the triangles.
  const v = vec3.dot(dir, qvec) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = vec3.dot(edge2, qvec) * invDet;
  return t >= 0 ? t : null;
}

/**
 * Velvet-style Jacobi XPBD cloth on WebGPU compute.
 */
export class XpbdGpuEngine implements ClothSimulator {
  private device: GPUDevice;
  private avatar: AvatarBody;
  private floor: Ground;
  private floorY = 0;
  private topo: ClothTopology;

  private cpuPos: Float32Array;
  private cpuVel: Float32Array;
  /** When true, next simulate frame re-uploads CPU pos/vel to GPU (pose/drag/reset). */
  private simStateDirty = true;
  private cpuInitial: Float32Array;
  private invMasses: Float32Array;
  private radii: Float32Array;
  private edgeLengths: Float32Array;
  private indices: Uint32Array;
  private vertexPieceIds: string[];
  /** Pieces pinned by zeroing their inverse mass; they never gain velocity. */
  private frozenPieceIds = new Set<string>();
  /**
   * Pieces taken out of the simulation entirely (see `applyFrozenMasses`). A
   * ghosted piece holds its pose and interacts with nothing: no constraints, no
   * contact, and nothing of it pushes the fabric around it.
   */
  private ghostedPieceIds = new Set<string>();
  /** Un-frozen per-particle inverse mass, restored when a piece is released. */
  private restInvMasses: Float32Array;
  /** Weight that puts a ghosted particle outside every solver's `wSum <= 0`. */
  private ghostInvMass: number;
  private seamPairs: Array<[number, number]>;

  private substeps: number;
  private iterations: number;
  private gravity: number;
  /** Continuous drag coeff for predict (`1 - damping * h`). From dampingConst. */
  private damping: number;
  /** Per-substep velocity retain in finalize (matches CPU `velocityDamping`). */
  private velocityDamping: number;
  /** XPBD stretch compliance (1/stiffness). 0 = rigid. */
  private stretchCompliance = 0;
  /** XPBD bend compliance (1/stiffness). Higher = floppier. */
  private bendCompliance = 1e-3;
  /** Provot max edge length as a multiple of rest; ≤ 1 disables. */
  private maxStretch = 1.12;
  private diameterScalar = DEFAULT_CONTACT_EDGES;
  private totalMass = 100;
  private maxSpeed: number;
  private friction: number;
  /** Substep length of the last stepped frame, for the per-frame contact pass. */
  private lastSubstepSeconds = 1 / 60;
  private enableSelfCollision: boolean;
  private particleDiameter: number;
  private seamRampElapsed = 0;
  private dragging = false;
  private prevT = 0;
  private debugStepCount = 0;

  // GPU buffers
  private positionsBuf!: GPUBuffer;
  private velocitiesBuf!: GPUBuffer;
  private predictedBuf!: GPUBuffer;
  private invMassBuf!: GPUBuffer;
  private radiiBuf!: GPUBuffer;
  private initialBuf!: GPUBuffer;
  /** Packed (x, y, z, contactCount) self-collision accumulators. */
  private deltaBuf!: GPUBuffer;
  /** Packed (inverse mass, mean incident edge length) for the collision kernels. */
  private massEdgeBuf!: GPUBuffer;
  private stretchIdxBuf!: GPUBuffer;
  private stretchRestBuf!: GPUBuffer;
  private stretchLambdaBuf!: GPUBuffer;
  /** Per stretch edge: the crowd floor of a gathered row, 1 = ordinary fabric. */
  private stretchSlackBuf!: GPUBuffer;
  private bendSlackBuf!: GPUBuffer;
  /** Bend (cross-edge) constraints: opposite-vertex pair + rest distance. */
  private bendIdxBuf!: GPUBuffer;
  private bendRestBuf!: GPUBuffer;
  private bendLambdaBuf!: GPUBuffer;
  /**
   * Fold resistance across each stitch: the interior vertices of the two
   * triangles that meet along the seam. Solved with the bend kernel, and held
   * off until the seam has closed.
   */
  private seamBendIdxBuf!: GPUBuffer;
  private seamBendRestBuf!: GPUBuffer;
  private seamBendLambdaBuf!: GPUBuffer;
  private seamBendSlackBuf!: GPUBuffer;
  private seamBendColorOffsets: Uint32Array = new Uint32Array([0]);
  /** Pairwise sew constraints: indices (i,j), target rest, initial distance. */
  private seamIdxBuf!: GPUBuffer;
  private seamRestBuf!: GPUBuffer;
  private seamInitialBuf!: GPUBuffer;
  private indicesBuf!: GPUBuffer;
  private normalsAccumBuf!: GPUBuffer;
  private obstaclesBuf!: GPUBuffer;
  private renderPosBuf!: GPUBuffer;
  private renderNrmBuf!: GPUBuffer;
  private colorBuffer!: GPUBuffer;
  private strainColorData!: Float32Array;
  /** Per-vertex opacity for the renderer (see `updatePieceAlpha`). */
  private alphaData!: Float32Array;
  private alphaBuffer!: GPUBuffer;
  private stretchEdges: StrainEdge[] = [];
  private strainMapEnabled = false;
  private indexBuffer!: GPUBuffer;
  private wireframeEdgeBuffer: GPUBuffer | null = null;
  private wireframeEdgeCount = 0;
  private seamLinePosBuf: GPUBuffer | null = null;
  private seamLineNrmBuf: GPUBuffer | null = null;
  private seamLineVertexCount = 0;
  private stagingBuf!: GPUBuffer;
  private stagingBufB!: GPUBuffer;
  private stagingVelBuf!: GPUBuffer;
  private stagingVelBufB!: GPUBuffer;
  private stagingFlip = 0;
  private readPending = false;
  /** CPU contact resolved; upload pos/vel before the next GPU step. */
  private collisionFeedbackPending = false;
  /** Stretch constraints grouped by color for race-free parallel GS. */
  private stretchColorOffsets: Uint32Array = new Uint32Array([0]);
  /** Bend constraints grouped by color for race-free parallel GS. */
  private bendColorOffsets: Uint32Array = new Uint32Array([0]);
  private collideProxies: Particle[] = [];

  private nStretch = 0;
  private nBend = 0;
  private nSeamBend = 0;
  private nAttach = 0;
  private nParticles = 0;
  private nTriangles = 0;

  private pipelines: Record<string, GPUComputePipeline> = {};
  /** Fresh UNIFORM buffers written this frame; destroyed next update (cannot rewrite mid-pass). */
  private transientUniforms: GPUBuffer[] = [];

  private sdfTexture: GPUTexture;
  private sdfView: GPUTextureView;
  private meshObstacles: ObstacleGpu[] = [];
  private dummySdf: { texture: GPUTexture; view: GPUTextureView };

  private cellStartBuf!: GPUBuffer;
  private cellCountBuf!: GPUBuffer;
  private cellCursorBuf!: GPUBuffer;
  private particleIdsBuf!: GPUBuffer;
  private particleHashBuf!: GPUBuffer;
  /** CSR of the particles each point is sewn to: offsets[0..n] then the list. */
  private sewnBuf!: GPUBuffer;
  private tableSize = 4096;
  private maxNeighbors = 64;

  constructor(
    mesh: MeshGeometry,
    params: SimParams,
    device: GPUDevice,
    avatar: AvatarBody,
    pattern?: PatternDocument
  ) {
    this.device = device;
    this.avatar = avatar;
    this.substeps = params.substeps ?? 8;
    this.iterations = params.constraintIterations ?? 4;
    this.gravity = params.gravity;
    this.damping = Math.min(0.5, params.dampingConst * 0.01);
    this.velocityDamping = params.velocityDamping ?? 0.998;
    this.totalMass = Math.max(1e-3, params.mass);
    this.stretchCompliance = stretchComplianceFromParams(params);
    this.bendCompliance = bendComplianceFromParams(params);
    this.maxStretch = params.maxStretch ?? this.maxStretch;
    this.diameterScalar = clampContactEdges(params.particleDiameterScalar ?? this.diameterScalar);
    this.maxSpeed = params.maxSpeed ?? DEFAULT_MAX_SPEED;
    this.friction = params.contactFriction ?? 0.45;
    this.enableSelfCollision = params.enableSelfCollision ?? false;

    this.topo = buildClothTopology(mesh, params.mass, pattern, {
      particleDiameterScalar: this.diameterScalar,
      longRangeStretchiness: params.longRangeStretchiness ?? 1.2,
    });
    this.nParticles = this.topo.numParticles;
    this.cpuPos = new Float32Array(this.topo.positions);
    this.cpuInitial = new Float32Array(this.topo.initialPositions);
    this.cpuVel = new Float32Array(this.nParticles * 3);
    this.invMasses = new Float32Array(this.topo.inverseMasses);
    this.restInvMasses = new Float32Array(this.invMasses);
    this.ghostInvMass = ghostInverseMass(this.restInvMasses);
    this.radii = new Float32Array(this.topo.radii);
    this.edgeLengths = new Float32Array(this.topo.edgeLengths);
    this.indices = new Uint32Array(this.topo.indices);
    this.vertexPieceIds = [...this.topo.vertexPieceIds];
    this.seamPairs = this.topo.seamPairs.map((p) => [p[0], p[1]]);
    this.stretchEdges = this.topo.stretch.map((s) => ({ i: s.i, j: s.j, rest: s.rest }));
    this.nTriangles = this.indices.length / 3;
    this.particleDiameter = this.topo.avgEdgeLength * this.diameterScalar;

    const up = vec3.fromValues(0, 1, 0);
    this.collideProxies = [];
    for (let i = 0; i < this.nParticles; i++) {
      const pos = vec3.fromValues(this.cpuPos[i * 3], this.cpuPos[i * 3 + 1], this.cpuPos[i * 3 + 2]);
      const p = new Particle(pos, vec3.clone(up), this.topo.particleMass, this.gravity, this.floorY);
      p.setEdgeLength(this.edgeLengths[i] ?? this.topo.avgEdgeLength);
      p.setContactFriction(this.friction);
      this.collideProxies.push(p);
    }

    const floorSize = Math.max(16, avatar.getFootprintRadius() * 2.5) * 3;
    this.floor = new Ground([-floorSize * 0.5, 0, -floorSize * 0.5], floorSize, device, {
      radialGradient: true,
    });

    this.dummySdf = createDummySdfTexture(device);
    this.sdfTexture = this.dummySdf.texture;
    this.sdfView = this.dummySdf.view;
    this.refreshSdfFromAvatar();

    this.createGpuBuffers();
    this.createPipelines();
    this.uploadAll();
    this.rebuildSeamLines();
    this.syncStrainColors(true);
    this.prevT = 0;

    this.device.addEventListener('uncapturederror', (ev) => {
      console.error('[XpbdGpuEngine] GPU error', (ev as GPUUncapturedErrorEvent).error);
    });
  }

  private refreshSdfFromAvatar(): void {
    const vol = this.avatar.getSdfVolume?.() ?? null;
    if (this.sdfTexture !== this.dummySdf.texture) {
      this.sdfTexture.destroy();
    }
    if (vol) {
      const uploaded = createSdfGpuTexture(this.device, vol);
      this.sdfTexture = uploaded.texture;
      this.sdfView = uploaded.view;
      this.meshObstacles = [uploaded.obstacle];
    } else {
      this.sdfTexture = this.dummySdf.texture;
      this.sdfView = this.dummySdf.view;
      this.meshObstacles = [];
    }
  }

  private createBuf(
    size: number,
    usage: GPUBufferUsageFlags,
    label: string
  ): GPUBuffer {
    return this.device.createBuffer({ size: Math.max(size, 4), usage, label });
  }

  private createGpuBuffers(): void {
    const n = this.nParticles;
    const usage =
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.positionsBuf = this.createBuf(n * 16, usage, 'xpbd-pos');
    this.velocitiesBuf = this.createBuf(n * 16, usage, 'xpbd-vel');
    this.predictedBuf = this.createBuf(n * 16, usage, 'xpbd-pred');
    this.invMassBuf = this.createBuf(n * 4, usage, 'xpbd-invmass');
    this.radiiBuf = this.createBuf(n * 4, usage, 'xpbd-radii');
    this.initialBuf = this.createBuf(n * 16, usage, 'xpbd-initial');
    this.deltaBuf = this.createBuf(n * 4 * 4, usage, 'xpbd-delta');
    this.normalsAccumBuf = this.createBuf(n * 16, usage, 'xpbd-nrm-accum');
    this.massEdgeBuf = this.createBuf(n * 16, usage, 'xpbd-mass-edge');

    this.nStretch = this.topo.stretch.length;
    const coloring = colorStretchConstraints(this.topo.stretch, this.nParticles);
    this.stretchColorOffsets = coloring.offsets;
    const stretchIdx = new Uint32Array(Math.max(this.nStretch, 1) * 2);
    const stretchRest = new Float32Array(Math.max(this.nStretch, 1));
    const stretchSlack = new Float32Array(Math.max(this.nStretch, 1));
    for (let slot = 0; slot < this.nStretch; slot++) {
      const src = coloring.idx[slot]!;
      stretchIdx[slot * 2] = this.topo.stretch[src]!.i;
      stretchIdx[slot * 2 + 1] = this.topo.stretch[src]!.j;
      stretchRest[slot] = this.topo.stretch[src]!.rest;
      stretchSlack[slot] = this.topo.stretch[src]!.slack ?? 1;
    }
    this.stretchIdxBuf = this.createBuf(stretchIdx.byteLength, usage, 'xpbd-stretch-idx');
    this.stretchRestBuf = this.createBuf(stretchRest.byteLength, usage, 'xpbd-stretch-rest');
    this.stretchSlackBuf = this.createBuf(stretchSlack.byteLength, usage, 'xpbd-stretch-slack');
    this.writeBuf(this.stretchSlackBuf, stretchSlack);
    this.stretchLambdaBuf = this.createBuf(
      Math.max(this.nStretch, 1) * 4,
      usage,
      'xpbd-stretch-lambda'
    );
    // Bends share the distance kernel but are never gathered: floor 1 = the
    // two-sided constraint.
    this.bendSlackBuf = this.createBuf(Math.max(this.nBend, 1) * 4, usage, 'xpbd-bend-slack');
    this.writeBuf(
      this.bendSlackBuf,
      new Float32Array(Math.max(this.nBend, 1)).fill(1)
    );
    this.writeBuf(this.stretchIdxBuf, stretchIdx);
    this.writeBuf(this.stretchRestBuf, stretchRest);

    // Bend = cross-edge (opposite-vertex) distance constraints, mirroring the CPU
    // engine's bend springs. Rest is the layout distance between the opposite verts.
    const bends = this.topo.bend;
    this.nBend = bends.length;
    const bendColoring = colorConstraints(
      bends.map((b) => [b.i0, b.i3]),
      this.nParticles
    );
    this.bendColorOffsets = bendColoring.offsets;
    const bendIdx = new Uint32Array(Math.max(this.nBend, 1) * 2);
    const bendRest = new Float32Array(Math.max(this.nBend, 1));
    for (let slot = 0; slot < this.nBend; slot++) {
      const b = bends[bendColoring.idx[slot]!]!;
      bendIdx[slot * 2] = b.i0;
      bendIdx[slot * 2 + 1] = b.i3;
      bendRest[slot] = Math.hypot(
        this.cpuPos[b.i0 * 3] - this.cpuPos[b.i3 * 3],
        this.cpuPos[b.i0 * 3 + 1] - this.cpuPos[b.i3 * 3 + 1],
        this.cpuPos[b.i0 * 3 + 2] - this.cpuPos[b.i3 * 3 + 2]
      );
    }
    this.bendIdxBuf = this.createBuf(bendIdx.byteLength, usage, 'xpbd-bend-idx');
    this.bendRestBuf = this.createBuf(bendRest.byteLength, usage, 'xpbd-bend-rest');
    this.bendLambdaBuf = this.createBuf(Math.max(this.nBend, 1) * 4, usage, 'xpbd-bend-lambda');
    this.writeBuf(this.bendIdxBuf, bendIdx);
    this.writeBuf(this.bendRestBuf, bendRest);

    // Seam bends: the triangle interiors either side of the stitch, solved by
    // the same kernel. Their rest comes from the pattern — the two triangle
    // heights, which is how far apart those vertices sit with the seam flat —
    // not from the layout, where the panels are still apart.
    const seamBends = this.topo.seamBend ?? [];
    this.nSeamBend = seamBends.length;
    const seamBendColoring = colorConstraints(
      seamBends.map((b) => [b.i, b.j]),
      this.nParticles
    );
    this.seamBendColorOffsets = seamBendColoring.offsets;
    const seamBendIdx = new Uint32Array(Math.max(this.nSeamBend, 1) * 2);
    const seamBendRest = new Float32Array(Math.max(this.nSeamBend, 1));
    for (let slot = 0; slot < this.nSeamBend; slot++) {
      const b = seamBends[seamBendColoring.idx[slot]!]!;
      seamBendIdx[slot * 2] = b.i;
      seamBendIdx[slot * 2 + 1] = b.j;
      seamBendRest[slot] = b.rest;
    }
    this.seamBendIdxBuf = this.createBuf(seamBendIdx.byteLength, usage, 'xpbd-seam-bend-idx');
    this.seamBendRestBuf = this.createBuf(seamBendRest.byteLength, usage, 'xpbd-seam-bend-rest');
    this.seamBendLambdaBuf = this.createBuf(
      Math.max(this.nSeamBend, 1) * 4,
      usage,
      'xpbd-seam-bend-lambda'
    );
    this.seamBendSlackBuf = this.createBuf(
      Math.max(this.nSeamBend, 1) * 4,
      usage,
      'xpbd-seam-bend-slack'
    );
    this.writeBuf(this.seamBendIdxBuf, seamBendIdx);
    this.writeBuf(this.seamBendRestBuf, seamBendRest);
    this.writeBuf(this.seamBendSlackBuf, new Float32Array(Math.max(this.nSeamBend, 1)).fill(1));

    this.writeMassEdgeBuffer();

    const seams = this.topo.seamConstraints ?? [];
    this.nAttach = seams.length;
    const seamIdx = new Uint32Array(Math.max(this.nAttach, 1) * 2);
    const seamRest = new Float32Array(Math.max(this.nAttach, 1));
    const seamInit = new Float32Array(Math.max(this.nAttach, 1));
    for (let i = 0; i < this.nAttach; i++) {
      seamIdx[i * 2] = seams[i].i;
      seamIdx[i * 2 + 1] = seams[i].j;
      seamRest[i] = seams[i].rest;
      seamInit[i] = seams[i].initialDist;
    }
    this.seamIdxBuf = this.createBuf(seamIdx.byteLength, usage, 'xpbd-seam-idx');
    this.seamRestBuf = this.createBuf(seamRest.byteLength, usage, 'xpbd-seam-rest');
    this.seamInitialBuf = this.createBuf(seamInit.byteLength, usage, 'xpbd-seam-init');
    this.writeBuf(this.seamIdxBuf, seamIdx);
    this.writeBuf(this.seamRestBuf, seamRest);
    this.writeBuf(this.seamInitialBuf, seamInit);

    this.indicesBuf = this.createBuf(this.indices.byteLength || 4, usage, 'xpbd-indices');
    this.writeBuf(this.indicesBuf, this.indices);

    this.obstaclesBuf = this.createBuf(28 * 4 * 4, usage, 'xpbd-obstacles');
    this.renderPosBuf = this.createBuf(
      n * 12,
      GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'xpbd-render-pos'
    );
    this.renderNrmBuf = this.createBuf(
      n * 12,
      GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'xpbd-render-nrm'
    );
    this.strainColorData = new Float32Array(n * 3);
    this.colorBuffer = this.createBuf(
      n * 12,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      'xpbd-render-color'
    );
    this.alphaData = new Float32Array(n).fill(1);
    this.alphaBuffer = this.createBuf(
      n * 4,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      'xpbd-render-alpha'
    );
    this.writeBuf(this.alphaBuffer, this.alphaData);
    this.indexBuffer = this.createBuf(
      this.indices.byteLength || 4,
      GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      'xpbd-index'
    );
    this.writeBuf(this.indexBuffer, this.indices);

    const edgeIndices = buildWireframeEdgeIndices(this.indices);
    this.wireframeEdgeCount = edgeIndices.length;
    if (this.wireframeEdgeCount > 0) {
      this.wireframeEdgeBuffer = this.createBuf(
        edgeIndices.byteLength,
        GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        'xpbd-wireframe-edges'
      );
      this.writeBuf(this.wireframeEdgeBuffer, edgeIndices);
    }

    this.stagingBuf = this.createBuf(
      n * 16,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      'xpbd-staging-a'
    );
    this.stagingBufB = this.createBuf(
      n * 16,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      'xpbd-staging-b'
    );
    this.stagingVelBuf = this.createBuf(
      n * 16,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      'xpbd-staging-vel-a'
    );
    this.stagingVelBufB = this.createBuf(
      n * 16,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      'xpbd-staging-vel-b'
    );

    this.cellStartBuf = this.createBuf((this.tableSize + 1) * 4, usage, 'xpbd-cell-start');
    this.cellCountBuf = this.createBuf(this.tableSize * 4, usage, 'xpbd-cell-count');
    this.cellCursorBuf = this.createBuf(this.tableSize * 4, usage, 'xpbd-cell-cursor');
    this.particleIdsBuf = this.createBuf(n * 4, usage, 'xpbd-part-ids');
    this.particleHashBuf = this.createBuf(n * 4, usage, 'xpbd-part-hash');

    {
      const nbrs: number[][] = Array.from({ length: n }, () => []);
      for (const [a, b] of this.seamPairs) {
        nbrs[a]!.push(b);
        nbrs[b]!.push(a);
      }
      const offsets = new Uint32Array(n + 1);
      let total = 0;
      for (let i = 0; i < n; i++) {
        offsets[i] = total;
        total += nbrs[i]!.length;
      }
      const list = new Uint32Array(total);
      let at = 0;
      for (let i = 0; i < n; i++) for (const j of nbrs[i]!) list[at++] = j;
      const packed = new Uint32Array(offsets.length + list.length);
      packed.set(offsets, 0);
      packed.set(list, offsets.length);
      this.sewnBuf = this.createBuf(packed.byteLength, usage, 'xpbd-sewn');
      this.writeBuf(this.sewnBuf, packed);
    }
  }

  /** Upload the packed (inverse mass, edge length) buffer used by collision. */
  private writeMassEdgeBuffer(): void {
    const data = new Float32Array(this.nParticles * 4);
    for (let i = 0; i < this.nParticles; i++) {
      data[i * 4] = this.invMasses[i]!;
      data[i * 4 + 1] = this.edgeLengths[i]!;
    }
    this.writeBuf(this.massEdgeBuf, data);
  }

  private createPipelines(): void {
    const mk = (code: string, entry = 'main') => {
      const module = this.device.createShaderModule({ code });
      return this.device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: entry },
      });
    };
    this.pipelines.predict = mk(predictWgsl);
    this.pipelines.stretch = mk(solveStretchWgsl);
    // Bend reuses the XPBD distance solver with its own buffers/λ accumulator.
    this.pipelines.bend = mk(solveStretchWgsl);
    this.pipelines.strainLimit = mk(strainLimitWgsl);
    this.pipelines.resetLambdas = mk(resetLambdasWgsl);
    this.pipelines.hashClear = mk(hashBuildWgsl, 'clear');
    this.pipelines.hashCount = mk(hashBuildWgsl, 'count');
    this.pipelines.hashScan = mk(hashBuildWgsl, 'scan');
    this.pipelines.hashScatter = mk(hashBuildWgsl, 'scatter');
    this.pipelines.attach = mk(solveAttachmentWgsl);
    this.pipelines.stitchVelocity = mk(solveStitchVelocityWgsl);
    this.pipelines.applyDeltas = mk(applyDeltasWgsl);
    this.pipelines.finalize = mk(finalizeWgsl);
    this.pipelines.collideSdf = mk(collideSdfWgsl);
    this.pipelines.collideParticles = mk(collideParticlesWgsl);
    this.pipelines.zeroNormals = mk(computeNormalsWgsl, 'zero_normals');
    this.pipelines.accumNormals = mk(computeNormalsWgsl, 'accumulate_tri_normals');
    this.pipelines.normCopy = mk(computeNormalsWgsl, 'normalize_and_copy');
  }

  /** Allocate a one-shot uniform buffer. Must not be rewritten while bound in an open pass. */
  private uniform(_label: string, data: Float32Array | Uint32Array | ArrayBuffer): GPUBuffer {
    const bytes =
      data instanceof ArrayBuffer ? Math.max(data.byteLength, 16) : Math.max(data.byteLength, 16);
    const buf = this.device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    if (data instanceof ArrayBuffer) {
      this.device.queue.writeBuffer(buf, 0, data);
    } else {
      this.device.queue.writeBuffer(buf, 0, gpuData(data));
    }
    this.transientUniforms.push(buf);
    return buf;
  }

  private flushTransientUniforms(): void {
    for (const b of this.transientUniforms) b.destroy();
    this.transientUniforms.length = 0;
  }

  private uploadVec4(buf: GPUBuffer, xyz: Float32Array): void {
    const n = xyz.length / 3;
    const v4 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      v4[i * 4] = xyz[i * 3];
      v4[i * 4 + 1] = xyz[i * 3 + 1];
      v4[i * 4 + 2] = xyz[i * 3 + 2];
    }
    this.device.queue.writeBuffer(buf, 0, gpuData(v4));
  }

  private writeBuf(buf: GPUBuffer, data: ArrayBufferView): void {
    this.device.queue.writeBuffer(buf, 0, gpuData(data));
  }

  private uploadAll(): void {
    this.uploadVec4(this.positionsBuf, this.cpuPos);
    this.uploadVec4(this.velocitiesBuf, this.cpuVel);
    this.uploadVec4(this.predictedBuf, this.cpuPos);
    this.uploadVec4(this.initialBuf, this.cpuInitial);
    this.writeBuf(this.invMassBuf, this.invMasses);
    this.writeBuf(this.radiiBuf, this.radii);
    this.writeRenderMeshes();
    this.writeObstacles();
    this.simStateDirty = false;
  }

  private writeObstacles(): void {
    const packed = packObstacles(this.meshObstacles);
    this.writeBuf(this.obstaclesBuf, packed);
  }

  private bg(pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[]): GPUBindGroup {
    return this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries,
    });
  }

  private encodeStep(encoder: GPUCommandEncoder, h: number, seamProgress: number): void {
    const n = this.nParticles;
    const pass = encoder.beginComputePass();
    const wrapping = seamProgress < 0.999;
    const invH2 = 1 / Math.max(h * h, 1e-12);

    for (let s = 0; s < this.substeps; s++) {
      // XPBD Lagrange multipliers accumulate within a substep only.
      this.dispatchResetLambdas(pass);

      {
        const uData = new ArrayBuffer(16);
        const f = new Float32Array(uData);
        const u32 = new Uint32Array(uData);
        f[0] = h;
        f[1] = this.gravity;
        f[2] = this.damping;
        u32[3] = n;
        const u = this.uniform('predict', uData);
        pass.setPipeline(this.pipelines.predict);
        pass.setBindGroup(
          0,
          this.bg(this.pipelines.predict, [
            { binding: 0, resource: { buffer: u } },
            { binding: 1, resource: { buffer: this.positionsBuf } },
            { binding: 2, resource: { buffer: this.velocitiesBuf } },
            { binding: 3, resource: { buffer: this.predictedBuf } },
            { binding: 4, resource: { buffer: this.invMassBuf } },
          ])
        );
        pass.dispatchWorkgroups(groups(n));
      }

      // One hash per substep, built from the positions the iteration loop will
      // work on: the constraint passes move points by a fraction of a cell, so
      // the buckets stay good enough for every iteration's contact pass.
      if (this.enableSelfCollision) this.dispatchHashBuild(pass, this.predictedBuf);

      for (let it = 0; it < this.iterations; it++) {
        this.dispatchStretch(pass, invH2);
        this.dispatchBend(pass, invH2);
        this.dispatchSeamBend(pass, invH2, seamProgress);
        this.dispatchAttach(pass, seamProgress, h);
        // Extra stretch pass resists seam crumpling / self-intersection.
        if (wrapping) this.dispatchStretch(pass, invH2);
        // Cloth–cloth contact is a constraint like the rest, and is solved with
        // them for that reason: it has to be part of the configuration the
        // iteration converges to, or every solve hands the fabric back to the
        // one that follows it and the cloth never comes to rest.
        if (this.enableSelfCollision) {
          this.dispatchSelfCollision(pass, h);
          this.dispatchApplyDeltas(pass, h);
        }
      }

      // Provot strain limiting — keeps soft-compliance cloth from stretching
      // without bound (GPU previously had no max-stretch cap at all).
      if (this.maxStretch > 1 && this.iterations > 0 && this.nStretch > 0) {
        for (let it = 0; it < this.iterations; it++) this.dispatchStrainLimit(pass);
      }

      {
        const uData = new ArrayBuffer(16);
        const f = new Float32Array(uData);
        const u32 = new Uint32Array(uData);
        f[0] = 1 / h;
        f[1] = perSubstepRetain(this.velocityDamping, this.substeps);
        f[2] = this.maxSpeed;
        u32[3] = n;
        const u = this.uniform('finalize', uData);
        pass.setPipeline(this.pipelines.finalize);
        pass.setBindGroup(
          0,
          this.bg(this.pipelines.finalize, [
            { binding: 0, resource: { buffer: u } },
            { binding: 1, resource: { buffer: this.positionsBuf } },
            { binding: 2, resource: { buffer: this.velocitiesBuf } },
            { binding: 3, resource: { buffer: this.predictedBuf } },
            { binding: 4, resource: { buffer: this.invMassBuf } },
          ])
        );
        pass.dispatchWorkgroups(groups(n));
      }

      // The stitch has the last word on *where* the cloth is, and none at all on
      // how fast it is going. The fabric's own passes — stretch, bend, the strain
      // limiter — reopen a closed seam every substep, because the gathered side
      // has to travel as it folds, so the stitch is re-solved here, on the
      // committed positions, after they have all had their turn.
      //
      // It must not run before `finalize`: there a seam correction becomes the
      // velocity of the pair (`v = delta / h`), so every substep the stitch
      // re-promises the fabric its own pull as speed at the velocity clamp. That
      // is what left a gathered seam buzzing and walking around the body.
      this.dispatchAttach(pass, seamProgress, h, this.positionsBuf);

      // ...and now that the cloth is where the stitch wants it, a closed stitch
      // also refuses to let the pair part: position work alone leaves a taut
      // seam's two rows free to separate at velocity every substep, which is
      // jitter running along the stitch.
      this.dispatchStitchVelocity(pass, seamProgress);

      // Body/floor contact after finalize so sew can't pull through the avatar.
      // It goes last of all: separating two layers can push one of them into the
      // body, and the body is the one surface the cloth may never be inside.
      this.dispatchCollideSdf(pass, h);
    }

    pass.end();
  }

  /** Zero both XPBD Lagrange accumulators (start of each substep). */
  private dispatchResetLambdas(pass: GPUComputePassEncoder): void {
    const zero = (count: number, buf: GPUBuffer, label: string) => {
      if (count <= 0) return;
      const uData = new ArrayBuffer(16);
      new Uint32Array(uData)[0] = count;
      const u = this.uniform(label, uData);
      pass.setBindGroup(
        0,
        this.bg(this.pipelines.resetLambdas, [
          { binding: 0, resource: { buffer: u } },
          { binding: 1, resource: { buffer: buf } },
        ])
      );
      pass.dispatchWorkgroups(groups(count));
    };
    pass.setPipeline(this.pipelines.resetLambdas);
    zero(this.nStretch, this.stretchLambdaBuf, 'reset-stretch');
    zero(this.nBend, this.bendLambdaBuf, 'reset-bend');
    zero(this.nSeamBend, this.seamBendLambdaBuf, 'reset-seam-bend');
  }

  /** Shared colored XPBD distance solver, used for both stretch and bend. */
  private dispatchDistancePass(
    pass: GPUComputePassEncoder,
    label: string,
    colorOffsets: Uint32Array,
    idxBuf: GPUBuffer,
    restBuf: GPUBuffer,
    lambdaBuf: GPUBuffer,
    slackBuf: GPUBuffer,
    compliance: number,
    invH2: number,
    crowdSoftness = 1
  ): void {
    if (colorOffsets.length <= 1) return;
    pass.setPipeline(this.pipelines.stretch);
    for (let c = 0; c < colorOffsets.length - 1; c++) {
      const offset = colorOffsets[c]!;
      const count = colorOffsets[c + 1]! - offset;
      if (count <= 0) continue;
      const uData = new ArrayBuffer(32);
      const f = new Float32Array(uData);
      const u32 = new Uint32Array(uData);
      u32[0] = offset;
      u32[1] = count;
      f[2] = compliance;
      u32[3] = this.nParticles;
      f[4] = invH2;
      // The crowd floor is per edge (the `slack` buffer); `crowdSoftness` says
      // how much softer a gathered row is at the start of its crowd range.
      f[5] = crowdSoftness;
      const u = this.uniform(`${label}-${c}`, uData);
      pass.setBindGroup(
        0,
        this.bg(this.pipelines.stretch, [
          { binding: 0, resource: { buffer: u } },
          { binding: 1, resource: { buffer: this.predictedBuf } },
          { binding: 2, resource: { buffer: this.invMassBuf } },
          { binding: 3, resource: { buffer: idxBuf } },
          { binding: 4, resource: { buffer: restBuf } },
          { binding: 5, resource: { buffer: lambdaBuf } },
          { binding: 6, resource: { buffer: slackBuf } },
        ])
      );
      pass.dispatchWorkgroups(groups(count));
    }
  }

  private dispatchStretch(pass: GPUComputePassEncoder, invH2: number): void {
    if (this.nStretch === 0) return;
    this.dispatchDistancePass(
      pass,
      'stretch',
      this.stretchColorOffsets,
      this.stretchIdxBuf,
      this.stretchRestBuf,
      this.stretchLambdaBuf,
      this.stretchSlackBuf,
      this.stretchCompliance,
      invH2,
      SEAM_CROWD_SOFTNESS
    );
  }

  private dispatchBend(pass: GPUComputePassEncoder, invH2: number): void {
    if (this.nBend === 0) return;
    this.dispatchDistancePass(
      pass,
      'bend',
      this.bendColorOffsets,
      this.bendIdxBuf,
      this.bendRestBuf,
      this.bendLambdaBuf,
      this.bendSlackBuf,
      this.bendCompliance,
      invH2
    );
  }

  /**
   * Fold resistance across the stitches.
   *
   * Off while the seam is still closing — the panels have not met yet, so there
   * is no fold to resist, and pulling those two triangles to their sewn spacing
   * would fight the sew itself — then the same compliance as ordinary bending,
   * so the seam bends exactly as the fabric either side of it does.
   */
  private dispatchSeamBend(
    pass: GPUComputePassEncoder,
    invH2: number,
    seamProgress: number
  ): void {
    if (this.nSeamBend === 0) return;
    const closed = seamProgress >= 0.999;
    this.dispatchDistancePass(
      pass,
      'seam-bend',
      this.seamBendColorOffsets,
      this.seamBendIdxBuf,
      this.seamBendRestBuf,
      this.seamBendLambdaBuf,
      this.seamBendSlackBuf,
      closed ? this.bendCompliance : 1e6,
      invH2
    );
  }

  private dispatchStrainLimit(pass: GPUComputePassEncoder): void {
    if (this.nStretch === 0) return;
    pass.setPipeline(this.pipelines.strainLimit);
    for (let c = 0; c < this.stretchColorOffsets.length - 1; c++) {
      const offset = this.stretchColorOffsets[c]!;
      const count = this.stretchColorOffsets[c + 1]! - offset;
      if (count <= 0) continue;
      const uData = new ArrayBuffer(16);
      const f = new Float32Array(uData);
      const u32 = new Uint32Array(uData);
      u32[0] = offset;
      u32[1] = count;
      f[2] = this.maxStretch;
      u32[3] = this.nParticles;
      const u = this.uniform(`strain-${c}`, uData);
      pass.setBindGroup(
        0,
        this.bg(this.pipelines.strainLimit, [
          { binding: 0, resource: { buffer: u } },
          { binding: 1, resource: { buffer: this.predictedBuf } },
          { binding: 2, resource: { buffer: this.invMassBuf } },
          { binding: 3, resource: { buffer: this.stretchIdxBuf } },
          { binding: 4, resource: { buffer: this.stretchRestBuf } },
        ])
      );
      pass.dispatchWorkgroups(groups(count));
    }
  }

  /** Counting-sort spatial hash over the positions the collision kernel reads. */
  private dispatchHashBuild(pass: GPUComputePassEncoder, positions: GPUBuffer): void {
    const uData = new ArrayBuffer(16);
    const f = new Float32Array(uData);
    const u32 = new Uint32Array(uData);
    u32[0] = this.nParticles;
    u32[1] = this.tableSize;
    f[2] = 1 / Math.max(this.particleDiameter, 1e-4);
    const u = this.uniform('hash', uData);

    // `layout: 'auto'` prunes bindings an entry point doesn't statically use, so
    // each hash entry point needs a bind group that exactly matches its layout.
    const buffers: Record<number, GPUBuffer> = {
      1: positions,
      2: this.cellStartBuf,
      3: this.cellCountBuf,
      4: this.cellCursorBuf,
      5: this.particleIdsBuf,
      6: this.particleHashBuf,
    };
    const run = (
      pipeline: GPUComputePipeline,
      entryBindings: number[],
      workgroups: number
    ) => {
      const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: u } }];
      for (const b of entryBindings) {
        entries.push({ binding: b, resource: { buffer: buffers[b] } });
      }
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.bg(pipeline, entries));
      pass.dispatchWorkgroups(workgroups);
    };

    run(this.pipelines.hashClear, [2, 3, 4], groups(this.tableSize));
    run(this.pipelines.hashCount, [1, 3, 6], groups(this.nParticles));
    run(this.pipelines.hashScan, [2, 3, 4], 1);
    run(this.pipelines.hashScatter, [4, 5, 6], groups(this.nParticles));
  }

  private dispatchAttach(
    pass: GPUComputePassEncoder,
    seamProgress: number,
    h: number,
    /**
     * Which of the two position buffers the stitch is solved against. Inside the
     * substep that is `predicted`, the usual constraint target; once the step is
     * committed it is `positions`, so the correction lands on the cloth the next
     * substep starts from and never becomes the pair's velocity.
     */
    target: GPUBuffer = this.predictedBuf
  ): void {
    if (this.nAttach === 0) return;
    // Same threshold `encodeStep` calls "wrapping".
    const t = Math.min(1, Math.max(0, seamProgress));
    const closed = t >= 0.999;
    // Once a seam is closed the stitch works at full strength. It has to: the
    // fabric's passes push a gathered pair apart between solves, so a seam that
    // may only recover a sliver per pass settles where the two balance — which
    // was a centimetre of daylight under a gathered skirt, instead of the fabric
    // resting against the stitch.
    const underRelax = closed ? 1 : 0.12 + 0.18 * t;
    // How far one pass may move the pair. While wrapping, that is a share of the
    // substep's travel budget split across the passes: not a global velocity cap,
    // which starved long, thin pieces on the way over, but enough to stop a seam
    // slamming through the body. Closed, the pair is already at its rest gap, so
    // it gets a whole substep of travel — far more than the fabric can push it
    // open by — because any tighter and the cap itself is what holds the stitch
    // open.
    const maxClose = closed
      ? Math.max(this.topo.avgEdgeLength * 0.5, this.maxSpeed * h)
      : Math.max(
          this.topo.avgEdgeLength * 0.08,
          this.maxSpeed * h / Math.max(1, this.iterations)
        );
    const uData = new ArrayBuffer(32);
    const f = new Float32Array(uData);
    const u32 = new Uint32Array(uData);
    u32[0] = this.nAttach;
    f[1] = seamProgress;
    u32[2] = this.nParticles;
    f[3] = underRelax;
    f[4] = maxClose;
    const u = this.uniform('attach', uData);
    pass.setPipeline(this.pipelines.attach);
    pass.setBindGroup(
      0,
      this.bg(this.pipelines.attach, [
        { binding: 0, resource: { buffer: u } },
        { binding: 1, resource: { buffer: target } },
        { binding: 2, resource: { buffer: this.invMassBuf } },
        { binding: 3, resource: { buffer: this.seamIdxBuf } },
        { binding: 4, resource: { buffer: this.seamRestBuf } },
        { binding: 5, resource: { buffer: this.seamInitialBuf } },
      ])
    );
    pass.dispatchWorkgroups(groups(this.nAttach));
  }

  /**
   * Stop a closed stitch parting at velocity level (see the shader for why).
   *
   * Momentum-conserving and energy-removing by construction: only the pair's
   * separating component is taken out, split by inverse mass.
   */
  private dispatchStitchVelocity(pass: GPUComputePassEncoder, seamProgress: number): void {
    if (this.nAttach === 0) return;
    const uData = new ArrayBuffer(32);
    const f = new Float32Array(uData);
    const u32 = new Uint32Array(uData);
    u32[0] = this.nAttach;
    u32[1] = this.nParticles;
    u32[2] = seamProgress >= 0.999 ? 1 : 0;
    f[3] = this.maxSpeed;
    const u = this.uniform('stitch-velocity', uData);
    pass.setPipeline(this.pipelines.stitchVelocity);
    pass.setBindGroup(
      0,
      this.bg(this.pipelines.stitchVelocity, [
        { binding: 0, resource: { buffer: u } },
        { binding: 1, resource: { buffer: this.positionsBuf } },
        { binding: 2, resource: { buffer: this.velocitiesBuf } },
        { binding: 3, resource: { buffer: this.invMassBuf } },
        { binding: 4, resource: { buffer: this.seamIdxBuf } },
      ])
    );
    pass.dispatchWorkgroups(groups(this.nAttach));
  }

  private dispatchCollideSdf(pass: GPUComputePassEncoder, h: number): void {
    const tangRetain = Math.max(0, 1 - Math.min(2, Math.max(0, this.friction)) * 0.95);
    const uData = new ArrayBuffer(32);
    const f = new Float32Array(uData);
    const u32 = new Uint32Array(uData);
    f[0] = tangRetain;
    f[1] = 0; // per-particle maxPush is computed in the shader
    u32[2] = this.nParticles;
    u32[3] = this.meshObstacles.length;
    f[4] = this.floorY;
    f[5] = 0; // per-particle margin is computed in the shader
    f[6] = contactHoldFromGrip(this.friction);
    f[7] = h;
    const u = this.uniform('sdf', uData);

    pass.setPipeline(this.pipelines.collideSdf);
    pass.setBindGroup(
      0,
      this.bg(this.pipelines.collideSdf, [
        { binding: 0, resource: { buffer: u } },
        { binding: 1, resource: { buffer: this.positionsBuf } },
        { binding: 2, resource: { buffer: this.velocitiesBuf } },
        { binding: 3, resource: { buffer: this.massEdgeBuf } },
        { binding: 4, resource: { buffer: this.obstaclesBuf } },
        { binding: 5, resource: this.sdfView },
      ])
    );
    pass.dispatchWorkgroups(groups(this.nParticles));
  }

  private dispatchApplyDeltas(pass: GPUComputePassEncoder, h: number): void {
    const uData = new ArrayBuffer(16);
    const f = new Float32Array(uData);
    const u32 = new Uint32Array(uData);
    u32[0] = this.nParticles;
    f[2] = 1.0;
    // How far one pass may separate a pair: a fraction of an edge (the same shape
    // of cap the body contact uses), and never more than a substep of travel at
    // the velocity clamp — a correction past that is one `finalize` refuses to
    // commit, which leaves the particle holding the speed instead of the place.
    f[3] = Math.min(0.25 * this.topo.avgEdgeLength, this.maxSpeed * h) /
      Math.max(this.topo.avgEdgeLength, 1e-6);
    const u = this.uniform('apply', uData);
    pass.setPipeline(this.pipelines.applyDeltas);
    pass.setBindGroup(
      0,
      this.bg(this.pipelines.applyDeltas, [
        { binding: 0, resource: { buffer: u } },
        { binding: 1, resource: { buffer: this.predictedBuf } },
        { binding: 2, resource: { buffer: this.deltaBuf } },
        { binding: 3, resource: { buffer: this.massEdgeBuf } },
      ])
    );
    pass.dispatchWorkgroups(groups(this.nParticles));
  }

  private dispatchSelfCollision(pass: GPUComputePassEncoder, h: number): void {
    const uData = new ArrayBuffer(32);
    const f = new Float32Array(uData);
    const u32 = new Uint32Array(uData);
    u32[0] = this.nParticles;
    u32[1] = this.tableSize;
    f[2] = 1 / Math.max(this.particleDiameter, 1e-4);
    f[3] = this.diameterScalar;
    f[4] = DELTA_SCALE;
    // Friction acts on the slip of a whole substep; this pass runs once per
    // iteration, so both the Coulomb bound and the slip budget are shared out
    // between them. Re-applying a full substep's worth each time shoves the pair
    // back further than it slipped and the contact buzzes instead of gripping.
    const passes = Math.max(1, this.iterations);
    f[5] = this.friction / passes;
    u32[6] = this.maxNeighbors;
    f[7] = h / passes;
    const u = this.uniform('selfcol', uData);
    pass.setPipeline(this.pipelines.collideParticles);
    pass.setBindGroup(
      0,
      this.bg(this.pipelines.collideParticles, [
        { binding: 0, resource: { buffer: u } },
        { binding: 1, resource: { buffer: this.predictedBuf } },
        { binding: 2, resource: { buffer: this.initialBuf } },
        { binding: 3, resource: { buffer: this.massEdgeBuf } },
        { binding: 4, resource: { buffer: this.cellStartBuf } },
        { binding: 5, resource: { buffer: this.particleIdsBuf } },
        { binding: 6, resource: { buffer: this.velocitiesBuf } },
        { binding: 7, resource: { buffer: this.deltaBuf } },
        { binding: 8, resource: { buffer: this.sewnBuf } },
      ])
    );
    pass.dispatchWorkgroups(groups(this.nParticles));
  }

  private async finishReadback(): Promise<void> {
    if (this.readPending) return;
    this.readPending = true;
    const staging = this.stagingFlip === 0 ? this.stagingBuf : this.stagingBufB;
    const stagingVel = this.stagingFlip === 0 ? this.stagingVelBuf : this.stagingVelBufB;
    try {
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      await stagingVel.mapAsync(GPUMapMode.READ);
      const velData = new Float32Array(stagingVel.getMappedRange().slice(0));
      stagingVel.unmap();
      for (let i = 0; i < this.nParticles; i++) {
        this.cpuPos[i * 3] = data[i * 4]!;
        this.cpuPos[i * 3 + 1] = data[i * 4 + 1]!;
        this.cpuPos[i * 3 + 2] = data[i * 4 + 2]!;
        this.cpuVel[i * 3] = velData[i * 4]!;
        this.cpuVel[i * 3 + 1] = velData[i * 4 + 1]!;
        this.cpuVel[i * 3 + 2] = velData[i * 4 + 2]!;
      }
      this.applyCpuCollision();
      this.writeRenderMeshes();
      this.collisionFeedbackPending = true;
      if (typeof window !== 'undefined') {
        let y = 0;
        for (let i = 0; i < this.nParticles; i++) y += this.cpuPos[i * 3 + 1]!;
        (window as unknown as { __xpbdMeanY?: number; __xpbdMeanX?: number }).__xpbdMeanY =
          y / this.nParticles;
        let x = 0;
        for (let i = 0; i < this.nParticles; i++) x += this.cpuPos[i * 3]!;
        (window as unknown as { __xpbdMeanX?: number }).__xpbdMeanX = x / this.nParticles;
      }
      this.rebuildSeamLines();
      this.syncStrainColors();
    } catch {
      /* map may fail if buffer in use; next frame retries */
    } finally {
      this.readPending = false;
    }
  }

  /** Same contact model as CPU PatternCloth — stable on SDF / triangle avatar. */
  private applyCpuCollision(): void {
    const edge = this.topo.avgEdgeLength;
    for (let i = 0; i < this.nParticles; i++) {
      if (this.invMasses[i]! <= 0) continue;
      const proxy = this.collideProxies[i]!;
      const pos = proxy.position;
      const vel = proxy.getVelocity();
      const x0 = this.cpuPos[i * 3]!;
      const y0 = this.cpuPos[i * 3 + 1]!;
      const z0 = this.cpuPos[i * 3 + 2]!;
      pos[0] = x0;
      pos[1] = y0;
      pos[2] = z0;
      vel[0] = this.cpuVel[i * 3]!;
      vel[1] = this.cpuVel[i * 3 + 1]!;
      vel[2] = this.cpuVel[i * 3 + 2]!;
      proxy.setGroundPos(this.floorY);
      proxy.setContactFriction(this.friction);
      proxy.setEdgeLength(this.edgeLengths[i] ?? edge);
      proxy.groundCollision();
      this.avatar.resolveParticle(proxy, this.edgeLengths[i] ?? edge, {
        hold: proxy.getContactHold(),
        stepSeconds: this.lastSubstepSeconds,
      });
      const dx = pos[0]! - x0;
      const dy = pos[1]! - y0;
      const dz = pos[2]! - z0;
      const movedSq = dx * dx + dy * dy + dz * dz;
      // Extra settle when contact actually projected — kills chatter against the body.
      if (movedSq > 1e-10) {
        vel[0]! *= 0.92;
        vel[1]! *= 0.92;
        vel[2]! *= 0.92;
      }
      // The push is taken a share at a time — see `relaxContactPush`. Velocities
      // stay the contact's own (the inward component is already gone, the
      // tangential slip damped); only the positional jump is eased, so this
      // frame-rate pass cannot fight the substep solve.
      const moved = movedSq > 1e-10;
      const px = relaxContactPush(x0, pos[0]!, moved);
      const py = relaxContactPush(y0, pos[1]!, moved);
      const pz = relaxContactPush(z0, pos[2]!, moved);
      const speedCap = this.maxSpeed;
      const speed = Math.hypot(vel[0]!, vel[1]!, vel[2]!);
      if (speed > speedCap && speed > 1e-8) {
        const s = speedCap / speed;
        vel[0]! *= s;
        vel[1]! *= s;
        vel[2]! *= s;
      }
      this.cpuPos[i * 3] = px;
      this.cpuPos[i * 3 + 1] = py;
      this.cpuPos[i * 3 + 2] = pz;
      this.cpuVel[i * 3] = vel[0]!;
      this.cpuVel[i * 3 + 1] = vel[1]!;
      this.cpuVel[i * 3 + 2] = vel[2]!;
    }
  }

  /** Stable face-area weighted normals (no GPU race flicker). */
  private writeRenderMeshes(): void {
    const nrm = new Float32Array(this.nParticles * 3);
    const idx = this.indices;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const i0 = idx[t]!;
      const i1 = idx[t + 1]!;
      const i2 = idx[t + 2]!;
      const ax = this.cpuPos[i1 * 3]! - this.cpuPos[i0 * 3]!;
      const ay = this.cpuPos[i1 * 3 + 1]! - this.cpuPos[i0 * 3 + 1]!;
      const az = this.cpuPos[i1 * 3 + 2]! - this.cpuPos[i0 * 3 + 2]!;
      const bx = this.cpuPos[i2 * 3]! - this.cpuPos[i0 * 3]!;
      const by = this.cpuPos[i2 * 3 + 1]! - this.cpuPos[i0 * 3 + 1]!;
      const bz = this.cpuPos[i2 * 3 + 2]! - this.cpuPos[i0 * 3 + 2]!;
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      nrm[i0 * 3] += nx;
      nrm[i0 * 3 + 1] += ny;
      nrm[i0 * 3 + 2] += nz;
      nrm[i1 * 3] += nx;
      nrm[i1 * 3 + 1] += ny;
      nrm[i1 * 3 + 2] += nz;
      nrm[i2 * 3] += nx;
      nrm[i2 * 3 + 1] += ny;
      nrm[i2 * 3 + 2] += nz;
    }
    for (let i = 0; i < this.nParticles; i++) {
      const ox = i * 3;
      const len = Math.hypot(nrm[ox]!, nrm[ox + 1]!, nrm[ox + 2]!);
      if (len > 1e-8) {
        nrm[ox]! /= len;
        nrm[ox + 1]! /= len;
        nrm[ox + 2]! /= len;
      } else {
        nrm[ox + 1] = 1;
      }
    }
    this.writeBuf(this.renderPosBuf, this.cpuPos);
    this.writeBuf(this.renderNrmBuf, nrm);
  }

  private syncStrainColors(force = false): void {
    if (!this.colorBuffer || !this.strainColorData) return;
    if (!this.strainMapEnabled && !force) return;
    if (!this.strainMapEnabled) {
      this.strainColorData.fill(0);
      this.writeBuf(this.colorBuffer, this.strainColorData);
      return;
    }
    fillStrainColors(this.cpuPos, this.stretchEdges, this.strainColorData);
    this.writeBuf(this.colorBuffer, this.strainColorData);
  }

  setStrainMapEnabled(enabled: boolean): void {
    this.strainMapEnabled = enabled;
    this.syncStrainColors(true);
  }

  isStrainMapEnabled(): boolean {
    return this.strainMapEnabled;
  }

  getColorBuffer(): GPUBuffer | null {
    return this.colorBuffer;
  }

  private rebuildSeamLines(): void {
    this.seamLinePosBuf?.destroy();
    this.seamLineNrmBuf?.destroy();
    this.seamLinePosBuf = null;
    this.seamLineNrmBuf = null;
    this.seamLineVertexCount = 0;
    if (this.seamPairs.length === 0) return;
    const pos = new Float32Array(this.seamPairs.length * 2 * 3);
    const nrm = new Float32Array(this.seamPairs.length * 2 * 3);
    for (let i = 0; i < this.seamPairs.length; i++) {
      const [a, b] = this.seamPairs[i];
      const o = i * 6;
      pos[o] = this.cpuPos[a * 3];
      pos[o + 1] = this.cpuPos[a * 3 + 1];
      pos[o + 2] = this.cpuPos[a * 3 + 2];
      pos[o + 3] = this.cpuPos[b * 3];
      pos[o + 4] = this.cpuPos[b * 3 + 1];
      pos[o + 5] = this.cpuPos[b * 3 + 2];
      nrm[o + 1] = 1;
      nrm[o + 4] = 1;
    }
    this.seamLineVertexCount = this.seamPairs.length * 2;
    this.seamLinePosBuf = this.device.createBuffer({
      size: pos.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.seamLineNrmBuf = this.device.createBuffer({
      size: nrm.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.seamLinePosBuf, 0, pos);
    this.writeBuf(this.seamLineNrmBuf, nrm);
  }

  update(simulate = true): void {
    const now = performance.now();
    if (this.prevT === 0) {
      this.prevT = now;
      this.syncRenderFromCpu();
      return;
    }
    // Never submit while a readback is in flight. Doing so let the GPU advance
    // several frames, after which the stale CPU collision feedback was uploaded
    // over them — losing simulation and injecting jitter.
    if (this.readPending) return;
    const dt = (now - this.prevT) / 1000;
    this.prevT = now;
    if (!simulate || this.dragging) {
      this.syncRenderFromCpu();
      return;
    }
    const clampedDt = Math.min(dt, 0.03);
    this.seamRampElapsed += clampedDt;
    const seamProgress = Math.min(1, this.seamRampElapsed / SEAM_RAMP_SECONDS);
    const h = clampedDt / this.substeps;
    // The per-frame CPU contact pass corrects the same substep-sized slice of
    // travel the GPU pass does, so a gripped contact takes back comparable
    // ground in either engine.
    this.lastSubstepSeconds = h;

    // Keep pos/vel resident on the GPU across frames unless CPU contact feedback
    // or an explicit edit (drag/reset) dirtied the CPU mirror.
    if (this.simStateDirty || this.collisionFeedbackPending) {
      this.uploadVec4(this.positionsBuf, this.cpuPos);
      this.uploadVec4(this.velocitiesBuf, this.cpuVel);
      this.uploadVec4(this.predictedBuf, this.cpuPos);
      this.simStateDirty = false;
      this.collisionFeedbackPending = false;
    }
    this.writeObstacles();

    this.flushTransientUniforms();
    const encoder = this.device.createCommandEncoder();
    try {
      this.encodeStep(encoder, h, seamProgress);
      this.stagingFlip = 1 - this.stagingFlip;
      const staging = this.stagingFlip === 0 ? this.stagingBuf : this.stagingBufB;
      const stagingVel = this.stagingFlip === 0 ? this.stagingVelBuf : this.stagingVelBufB;
      encoder.copyBufferToBuffer(this.positionsBuf, 0, staging, 0, this.nParticles * 16);
      encoder.copyBufferToBuffer(this.velocitiesBuf, 0, stagingVel, 0, this.nParticles * 16);
      this.device.queue.submit([encoder.finish()]);
      this.debugStepCount = (this.debugStepCount ?? 0) + 1;
      if (typeof window !== 'undefined') {
        (window as unknown as { __xpbdSteps?: number }).__xpbdSteps = this.debugStepCount;
      }
    } catch (err) {
      console.error('[XpbdGpuEngine] encode/submit failed', err);
      if (typeof window !== 'undefined') {
        (window as unknown as { __xpbdEncodeErr?: string }).__xpbdEncodeErr = String(err);
      }
      return;
    }

    void this.finishReadback();
  }

  private syncRenderFromCpu(): void {
    this.writeRenderMeshes();
    this.uploadVec4(this.positionsBuf, this.cpuPos);
    this.uploadVec4(this.velocitiesBuf, this.cpuVel);
    this.simStateDirty = false;
    this.rebuildSeamLines();
    this.syncStrainColors();
  }

  /**
   * Contact thickness, clamped and kept in step with the hash cell size (the
   * search cell is the contact distance, so the two may never drift apart).
   */
  private setContactThickness(scalar: number | undefined): void {
    this.diameterScalar = clampContactEdges(scalar ?? this.diameterScalar);
    this.particleDiameter = this.topo.avgEdgeLength * this.diameterScalar;
  }

  applyParams(params: SimParams): void {
    this.substeps = params.substeps ?? this.substeps;
    this.iterations = params.constraintIterations ?? this.iterations;
    this.gravity = params.gravity;
    this.damping = Math.min(0.5, params.dampingConst * 0.01);
    this.velocityDamping = params.velocityDamping ?? this.velocityDamping;
    this.maxSpeed = params.maxSpeed ?? this.maxSpeed;
    this.friction = params.contactFriction ?? this.friction;
    this.enableSelfCollision = params.enableSelfCollision ?? this.enableSelfCollision;
    this.stretchCompliance = stretchComplianceFromParams(params);
    this.bendCompliance = bendComplianceFromParams(params);
    this.maxStretch = params.maxStretch ?? this.maxStretch;
    this.diameterScalar = clampContactEdges(params.particleDiameterScalar ?? this.diameterScalar);

    const mass = Math.max(1e-3, params.mass);
    if (Math.abs(mass - this.totalMass) > 1e-6) {
      this.totalMass = mass;
      const particleMass = mass / Math.max(1, this.nParticles);
      const inv = particleMass > 0 ? 1 / particleMass : 0;
      this.restInvMasses.fill(inv);
      this.ghostInvMass = ghostInverseMass(this.restInvMasses);
      this.applyFrozenMasses();
    }
  }

  exportPose(): SimPose {
    const positions = Array.from(this.cpuPos);
    const velocities = Array.from(this.cpuVel);
    return { positions, velocities };
  }

  applyPose(pose: SimPose): void {
    for (let i = 0; i < this.nParticles; i++) {
      const o = i * 3;
      if (o + 2 >= pose.positions.length) break;
      this.cpuPos[o] = pose.positions[o];
      this.cpuPos[o + 1] = pose.positions[o + 1];
      this.cpuPos[o + 2] = pose.positions[o + 2];
      if (pose.velocities && o + 2 < pose.velocities.length) {
        this.cpuVel[o] = pose.velocities[o];
        this.cpuVel[o + 1] = pose.velocities[o + 1];
        this.cpuVel[o + 2] = pose.velocities[o + 2];
      }
    }
    this.seamRampElapsed = SEAM_RAMP_SECONDS;
    this.simStateDirty = true;
    this.uploadAll();
    this.rebuildSeamLines();
  }

  resetToInitialState(): void {
    this.cpuPos.set(this.cpuInitial);
    this.cpuVel.fill(0);
    this.frozenPieceIds.clear();
    this.ghostedPieceIds.clear();
    this.applyFrozenMasses();
    this.seamRampElapsed = 0;
    this.dragging = false;
    this.prevT = 0;
    this.simStateDirty = true;
    this.uploadAll();
    this.rebuildSeamLines();
    if (typeof window !== 'undefined') {
      let y = 0;
      for (let i = 0; i < this.nParticles; i++) y += this.cpuPos[i * 3 + 1]!;
      (window as unknown as { __xpbdCpuY?: number; __xpbdN?: number }).__xpbdCpuY =
        y / this.nParticles;
      (window as unknown as { __xpbdN?: number }).__xpbdN = this.nParticles;
    }
  }

  setAvatar(avatar: ClothCollider): void {
    this.avatar = avatar as AvatarBody;
    this.refreshSdfFromAvatar();
    this.writeObstacles();
  }

  getGround(): ClothCollider {
    return this.avatar;
  }

  getFloor(): ClothFloor {
    return this.floor;
  }

  getSeamLineVertexCount(): number {
    return this.seamLineVertexCount;
  }

  getSeamLinePositionBuffer(): GPUBuffer | null {
    return this.seamLinePosBuf;
  }

  getSeamLineNormalBuffer(): GPUBuffer | null {
    return this.seamLineNrmBuf;
  }

  getVertexPieceIds(): readonly string[] {
    return this.vertexPieceIds;
  }

  raycast(origin: vec3, dir: vec3): { t: number; point: vec3; pieceId: string } | null {
    let bestT = Infinity;
    let best: vec3 | null = null;
    let bestPieceId = FALLBACK_PIECE_ID;
    const eps = 1e-6;
    for (let i = 0; i + 2 < this.indices.length; i += 3) {
      const i0 = this.indices[i];
      const i1 = this.indices[i + 1];
      const i2 = this.indices[i + 2];
      const v0 = vec3.fromValues(
        this.cpuPos[i0 * 3],
        this.cpuPos[i0 * 3 + 1],
        this.cpuPos[i0 * 3 + 2]
      );
      const v1 = vec3.fromValues(
        this.cpuPos[i1 * 3],
        this.cpuPos[i1 * 3 + 1],
        this.cpuPos[i1 * 3 + 2]
      );
      const v2 = vec3.fromValues(
        this.cpuPos[i2 * 3],
        this.cpuPos[i2 * 3 + 1],
        this.cpuPos[i2 * 3 + 2]
      );
      const hit = rayTriangle(origin, dir, v0, v1, v2, eps);
      if (hit !== null && hit > eps && hit < bestT) {
        bestT = hit;
        bestPieceId = this.vertexPieceIds[i0] ?? FALLBACK_PIECE_ID;
        best = vec3.create();
        vec3.scaleAndAdd(best, origin, dir, hit);
      }
    }
    return best ? { t: bestT, point: best, pieceId: bestPieceId } : null;
  }

  getCentroid(pieceId?: string): vec3 {
    const c = vec3.create();
    let count = 0;
    for (let i = 0; i < this.nParticles; i++) {
      if (pieceId && this.vertexPieceIds[i] !== pieceId) continue;
      c[0] += this.cpuPos[i * 3];
      c[1] += this.cpuPos[i * 3 + 1];
      c[2] += this.cpuPos[i * 3 + 2];
      count++;
    }
    if (count > 0) {
      c[0] /= count;
      c[1] /= count;
      c[2] /= count;
    }
    return c;
  }

  getPieceCentroidTuple(pieceId: string): [number, number, number] {
    const c = this.getCentroid(pieceId);
    return [c[0], c[1], c[2]];
  }

  setPieceCentroid(pieceId: string, target: [number, number, number]): void {
    const c = this.getCentroid(pieceId);
    this.translateBy(
      vec3.fromValues(target[0] - c[0], target[1] - c[1], target[2] - c[2]),
      pieceId
    );
  }

  applyPieceEulerDegrees(pieceId: string, eulerDeg: [number, number, number]): void {
    for (let i = 0; i < this.nParticles; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      this.cpuPos[i * 3] = this.cpuInitial[i * 3];
      this.cpuPos[i * 3 + 1] = this.cpuInitial[i * 3 + 1];
      this.cpuPos[i * 3 + 2] = this.cpuInitial[i * 3 + 2];
      this.cpuVel[i * 3] = 0;
      this.cpuVel[i * 3 + 1] = 0;
      this.cpuVel[i * 3 + 2] = 0;
    }
    const axes: Array<[number, number, number]> = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    for (let a = 0; a < 3; a++) {
      const rad = (eulerDeg[a] * Math.PI) / 180;
      if (Math.abs(rad) < 1e-8) continue;
      this.rotateBy(vec3.fromValues(...axes[a]), rad, pieceId);
    }
  }

  applyPieceQuat(pieceId: string, quatXyZw: [number, number, number, number]): void {
    for (let i = 0; i < this.nParticles; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      this.cpuPos[i * 3] = this.cpuInitial[i * 3];
      this.cpuPos[i * 3 + 1] = this.cpuInitial[i * 3 + 1];
      this.cpuPos[i * 3 + 2] = this.cpuInitial[i * 3 + 2];
      this.cpuVel[i * 3] = 0;
      this.cpuVel[i * 3 + 1] = 0;
      this.cpuVel[i * 3 + 2] = 0;
    }
    const rotation = quat.fromValues(quatXyZw[0], quatXyZw[1], quatXyZw[2], quatXyZw[3]);
    if (quat.squaredLength(rotation) < 1e-12) {
      this.simStateDirty = true;
      this.syncRenderFromCpu();
      return;
    }
    quat.normalize(rotation, rotation);
    const center = this.getCentroid(pieceId);
    const relative = vec3.create();
    for (let i = 0; i < this.nParticles; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      vec3.set(
        relative,
        this.cpuPos[i * 3] - center[0],
        this.cpuPos[i * 3 + 1] - center[1],
        this.cpuPos[i * 3 + 2] - center[2]
      );
      vec3.transformQuat(relative, relative, rotation);
      this.cpuPos[i * 3] = center[0] + relative[0];
      this.cpuPos[i * 3 + 1] = center[1] + relative[1];
      this.cpuPos[i * 3 + 2] = center[2] + relative[2];
    }
    this.simStateDirty = true;
    this.syncRenderFromCpu();
  }

  translateBy(delta: vec3, pieceId?: string): void {
    for (let i = 0; i < this.nParticles; i++) {
      if (pieceId && this.vertexPieceIds[i] !== pieceId) continue;
      this.cpuPos[i * 3] += delta[0];
      this.cpuPos[i * 3 + 1] += delta[1];
      this.cpuPos[i * 3 + 2] += delta[2];
      this.cpuVel[i * 3] = 0;
      this.cpuVel[i * 3 + 1] = 0;
      this.cpuVel[i * 3 + 2] = 0;
    }
    this.syncRenderFromCpu();
  }

  rotateBy(axis: vec3, radians: number, pieceId: string): void {
    if (!Number.isFinite(radians) || Math.abs(radians) < 1e-8) return;
    const normalizedAxis = vec3.clone(axis);
    if (vec3.squaredLength(normalizedAxis) < 1e-8) return;
    vec3.normalize(normalizedAxis, normalizedAxis);
    const rotation = quat.create();
    quat.setAxisAngle(rotation, normalizedAxis, radians);
    const center = this.getCentroid(pieceId);
    const relative = vec3.create();
    for (let i = 0; i < this.nParticles; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      vec3.set(
        relative,
        this.cpuPos[i * 3] - center[0],
        this.cpuPos[i * 3 + 1] - center[1],
        this.cpuPos[i * 3 + 2] - center[2]
      );
      vec3.transformQuat(relative, relative, rotation);
      this.cpuPos[i * 3] = center[0] + relative[0];
      this.cpuPos[i * 3 + 1] = center[1] + relative[1];
      this.cpuPos[i * 3 + 2] = center[2] + relative[2];
      this.cpuVel[i * 3] = 0;
      this.cpuVel[i * 3 + 1] = 0;
      this.cpuVel[i * 3 + 2] = 0;
    }
    this.syncRenderFromCpu();
  }

  /**
   * Freeze a piece by zeroing its particles' inverse mass. The predict and
   * finalize kernels treat w=0 as immovable, so the piece holds its pose while
   * XPBD stretch/seam constraints still pull the other (live) end.
   */
  setPieceFrozen(pieceId: string, frozen: boolean): void {
    const changed = frozen
      ? !this.frozenPieceIds.has(pieceId)
      : this.frozenPieceIds.has(pieceId);
    if (!changed) return;
    if (frozen) {
      this.frozenPieceIds.add(pieceId);
      this.ghostedPieceIds.delete(pieceId);
    } else {
      this.frozenPieceIds.delete(pieceId);
    }
    this.zeroPieceVelocity(pieceId);
    this.applyFrozenMasses();
    this.simStateDirty = true;
  }

  isPieceFrozen(pieceId: string): boolean {
    return this.frozenPieceIds.has(pieceId);
  }

  /**
   * Ghost a piece: hold its pose and take it out of the simulation (see
   * `applyFrozenMasses`). Freezing and ghosting are two answers to "hold this
   * piece", so one replaces the other rather than stacking.
   */
  setPieceGhosted(pieceId: string, ghosted: boolean): void {
    const changed = ghosted
      ? !this.ghostedPieceIds.has(pieceId)
      : this.ghostedPieceIds.has(pieceId);
    if (!changed) return;
    if (ghosted) {
      this.ghostedPieceIds.add(pieceId);
      this.frozenPieceIds.delete(pieceId);
    } else {
      this.ghostedPieceIds.delete(pieceId);
    }
    this.zeroPieceVelocity(pieceId);
    this.applyFrozenMasses();
    this.simStateDirty = true;
  }

  isPieceGhosted(pieceId: string): boolean {
    return this.ghostedPieceIds.has(pieceId);
  }

  getGhostedPieceIds(): string[] {
    return [...this.ghostedPieceIds];
  }

  captureGhostState(): Record<string, number[]> {
    const state: Record<string, number[]> = {};
    for (const pieceId of this.ghostedPieceIds) {
      const positions = this.capturePiecePositions(pieceId);
      if (positions) state[pieceId] = positions;
    }
    return state;
  }

  applyGhostState(state: Record<string, number[]> | null | undefined): void {
    this.ghostedPieceIds.clear();
    if (state) {
      for (const [pieceId, positions] of Object.entries(state)) {
        let count = 0;
        for (const id of this.vertexPieceIds) if (id === pieceId) count++;
        if (count === 0) continue;
        // A remesh renumbers vertices, so only restore a saved pose when the
        // per-piece vertex count still lines up.
        if (positions.length === count * 3) {
          let k = 0;
          for (let i = 0; i < this.nParticles; i++) {
            if (this.vertexPieceIds[i] !== pieceId) continue;
            this.cpuPos[i * 3] = positions[k * 3]!;
            this.cpuPos[i * 3 + 1] = positions[k * 3 + 1]!;
            this.cpuPos[i * 3 + 2] = positions[k * 3 + 2]!;
            k++;
          }
        }
        this.ghostedPieceIds.add(pieceId);
        this.frozenPieceIds.delete(pieceId);
        this.zeroPieceVelocity(pieceId);
      }
    }
    this.applyFrozenMasses();
    this.simStateDirty = true;
  }

  getFrozenPieceIds(): string[] {
    return [...this.frozenPieceIds];
  }

  captureFrozenState(): Record<string, number[]> {
    const state: Record<string, number[]> = {};
    for (const pieceId of this.frozenPieceIds) {
      const positions = this.capturePiecePositions(pieceId);
      if (positions) state[pieceId] = positions;
    }
    return state;
  }

  applyFrozenState(state: Record<string, number[]> | null | undefined): void {
    this.frozenPieceIds.clear();
    if (state) {
      for (const [pieceId, positions] of Object.entries(state)) {
        let count = 0;
        for (const id of this.vertexPieceIds) if (id === pieceId) count++;
        if (count === 0) continue;
        // A remesh renumbers vertices, so only restore the saved pose when the
        // per-piece vertex count still lines up; otherwise pin it at rest.
        if (positions.length === count * 3) {
          let k = 0;
          for (let i = 0; i < this.nParticles; i++) {
            if (this.vertexPieceIds[i] !== pieceId) continue;
            this.cpuPos[i * 3] = positions[k * 3]!;
            this.cpuPos[i * 3 + 1] = positions[k * 3 + 1]!;
            this.cpuPos[i * 3 + 2] = positions[k * 3 + 2]!;
            k++;
          }
        }
        this.frozenPieceIds.add(pieceId);
        this.zeroPieceVelocity(pieceId);
      }
    }
    this.applyFrozenMasses();
    this.simStateDirty = true;
  }

  private capturePiecePositions(pieceId: string): number[] | null {
    const out: number[] = [];
    for (let i = 0; i < this.nParticles; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      out.push(this.cpuPos[i * 3]!, this.cpuPos[i * 3 + 1]!, this.cpuPos[i * 3 + 2]!);
    }
    return out.length ? out : null;
  }

  private zeroPieceVelocity(pieceId: string): void {
    for (let i = 0; i < this.nParticles; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      this.cpuVel[i * 3] = 0;
      this.cpuVel[i * 3 + 1] = 0;
      this.cpuVel[i * 3 + 2] = 0;
    }
  }

  /**
   * Rebuild invMasses from the rest values, with held pieces marked.
   *
   * A **frozen** piece gets w = 0: it stops integrating but stays in the solve,
   * so its seams still pull on whatever it is sewn to. A **ghosted** piece gets
   * the negative sentinel from `ghostInverseMass`, which every kernel already
   * treats as "no weight": `wSum <= 0` skips any constraint with a ghosted end
   * (stretch, bend, seam, the strain limiter), a self-collision pair with one
   * ghosted side is skipped, and contact skips the particle itself (`w <= 0`).
   * So one flag takes a piece out of the simulation without touching any
   * constraint buffer — and a *frozen* piece is unaffected, because the kernels
   * never see a negative weight from it.
   */
  private applyFrozenMasses(): void {
    for (let i = 0; i < this.nParticles; i++) {
      const piece = this.vertexPieceIds[i]!;
      if (this.ghostedPieceIds.has(piece)) this.invMasses[i] = this.ghostInvMass;
      else if (this.frozenPieceIds.has(piece)) this.invMasses[i] = 0;
      else this.invMasses[i] = this.restInvMasses[i]!;
    }
    this.writeBuf(this.invMassBuf, this.invMasses);
    this.writeMassEdgeBuffer();
    this.updatePieceAlpha();
  }

  /**
   * Refresh the per-vertex opacity the renderer reads: solid cloth, a dimmed
   * frozen piece, a faint ghosted one. Every route that changes which pieces
   * are held goes through `applyFrozenMasses`, so this stays in step with the
   * simulation state.
   */
  private updatePieceAlpha(): void {
    if (!this.alphaBuffer) return;
    for (let i = 0; i < this.nParticles; i++) {
      const piece = this.vertexPieceIds[i]!;
      if (this.ghostedPieceIds.has(piece)) this.alphaData[i] = GHOSTED_PIECE_OPACITY;
      else if (this.frozenPieceIds.has(piece)) this.alphaData[i] = FROZEN_PIECE_OPACITY;
      else this.alphaData[i] = 1;
    }
    this.writeBuf(this.alphaBuffer, this.alphaData);
  }

  getAlphaBuffer(): GPUBuffer | null {
    return this.alphaBuffer ?? null;
  }

  /** True while any piece is dimmed, so the renderer needs its blended pass. */
  hasTranslucentPieces(): boolean {
    return this.ghostedPieceIds.size > 0 || this.frozenPieceIds.size > 0;
  }

  setDragging(dragging: boolean): void {
    this.dragging = dragging;
    if (dragging) {
      this.cpuVel.fill(0);
      this.writeBuf(this.invMassBuf, this.invMasses);
      this.uploadVec4(this.velocitiesBuf, this.cpuVel);
    }
    // Resume simulate from the CPU pose (zeros velocity after a drag).
    this.simStateDirty = true;
  }

  getModelMatrix(): mat4 {
    return identity();
  }

  getPositionBuffer(): GPUBuffer {
    return this.renderPosBuf;
  }

  /** Latest CPU mirror of the particle positions (xyz interleaved, world units). */
  getPositionsSnapshot(): Float32Array | null {
    return this.cpuPos.length ? this.cpuPos : null;
  }

  getRestPositionsSnapshot(): Float32Array | null {
    return this.cpuInitial.length ? this.cpuInitial : null;
  }

  getTriangleIndices(): Uint32Array {
    return this.indices;
  }

  getNormalBuffer(): GPUBuffer {
    return this.renderNrmBuf;
  }

  getIndexBuffer(): GPUBuffer {
    return this.indexBuffer;
  }

  getIndexFormat(): GPUIndexFormat {
    return 'uint32';
  }

  getIndexCount(): number {
    return this.indices.length;
  }

  getWireframeBuffers(): null {
    return null;
  }

  getWireframeEdges(): { indexBuffer: GPUBuffer; indexFormat: GPUIndexFormat; indexCount: number } | null {
    if (!this.wireframeEdgeBuffer || this.wireframeEdgeCount === 0) return null;
    return {
      indexBuffer: this.wireframeEdgeBuffer,
      indexFormat: 'uint32',
      indexCount: this.wireframeEdgeCount,
    };
  }

  destroy(): void {
    const bufs: Array<GPUBuffer | null | undefined> = [
      this.positionsBuf,
      this.velocitiesBuf,
      this.predictedBuf,
      this.invMassBuf,
      this.radiiBuf,
      this.initialBuf,
      this.deltaBuf,
      this.massEdgeBuf,
      this.stretchIdxBuf,
      this.stretchRestBuf,
      this.stretchLambdaBuf,
      this.bendIdxBuf,
      this.bendRestBuf,
      this.bendLambdaBuf,
      this.seamIdxBuf,
      this.seamRestBuf,
      this.seamInitialBuf,
      this.indicesBuf,
      this.normalsAccumBuf,
      this.obstaclesBuf,
      this.renderPosBuf,
      this.renderNrmBuf,
      this.colorBuffer,
      this.indexBuffer,
      this.wireframeEdgeBuffer,
      this.stagingBuf,
      this.stagingBufB,
      this.stagingVelBuf,
      this.stagingVelBufB,
      this.seamLinePosBuf,
      this.seamLineNrmBuf,
      this.cellStartBuf,
      this.cellCountBuf,
      this.cellCursorBuf,
      this.particleIdsBuf,
      this.particleHashBuf,
      this.sewnBuf,
    ];
    for (const b of bufs) b?.destroy();
    this.flushTransientUniforms();
    if (this.sdfTexture !== this.dummySdf.texture) this.sdfTexture.destroy();
    this.dummySdf.texture.destroy();
    this.floor.destroy?.();
  }
}
