import type { SdfVolumeData } from './sdfVolume';
import SdfBakeWorker from './sdfBake.worker?worker';

/** Good starting point: fast enough to iterate, adequate for draping collision. */
export const DEFAULT_SDF_RESOLUTION = 48;

export function computeSdfGrid(
  boundsMin: [number, number, number],
  boundsMax: [number, number, number],
  resolution: number
): { origin: [number, number, number]; voxelSize: number; dim: [number, number, number] } {
  const extents = [0, 1, 2].map((k) => boundsMax[k] - boundsMin[k]);
  const pad = Math.max(extents[0], extents[1], extents[2]) * 0.05 + 0.25;
  const origin: [number, number, number] = [
    boundsMin[0] - pad,
    boundsMin[1] - pad,
    boundsMin[2] - pad,
  ];
  const padded = extents.map((e) => e + pad * 2);
  const span = Math.max(padded[0], padded[1], padded[2]);
  // `resolution` sets the voxel size along the model's longest axis, as before.
  const voxelSize = span / resolution;
  // …and each axis then gets only the voxels it needs. A cube of `resolution`
  // on every side holds a body that is four units deep and sixteen tall in the
  // same 16 units of depth as in its height: three quarters of its cells sit in
  // empty space, and the bake pays for every one of them.
  const dim: [number, number, number] = [
    Math.max(2, Math.round(padded[0] / voxelSize) + 1),
    Math.max(2, Math.round(padded[1] / voxelSize) + 1),
    Math.max(2, Math.round(padded[2] / voxelSize) + 1),
  ];
  return { origin, voxelSize, dim };
}

export type BakeSdfOptions = {
  /**
   * `value` is the share of the field baked so far, `elapsedMs` how long the
   * whole bake has been running. The elapsed clock keeps ticking even while the
   * worker has nothing to report, so a slow bake reads as slow rather than as a
   * frozen dialog.
   */
  onProgress?: (value: number, elapsedMs: number) => void;
  signal?: AbortSignal;
};

/** How often the elapsed-time tick fires while a bake is in flight. */
const PROGRESS_TICK_MS = 400;

/**
 * Give up on a worker that has gone quiet for this long.
 *
 * A 128³ bake is a few seconds even on a busy machine, so this only ever fires
 * on a worker that is never coming back — and because the worker is shared, one
 * that hangs would otherwise take every later bake down with it.
 */
const BAKE_STALL_MS = 5 * 60_000;

/**
 * The bake worker, kept between bakes.
 *
 * Bakes are queued through it rather than each one spawning (and terminating) a
 * worker: a fresh worker has to fetch and parse its own module graph, and while
 * that is pending the bake reports nothing at all.
 */
let sharedWorker: Worker | null = null;
let bakeQueue: Promise<unknown> = Promise.resolve();

function workerFor(): Worker {
  if (!sharedWorker) sharedWorker = new SdfBakeWorker();
  return sharedWorker;
}

/** A worker that has been terminated mid-bake is no use to the next caller. */
function dropWorker(): void {
  sharedWorker?.terminate();
  sharedWorker = null;
}

export async function bakeSdfVolume(
  positions: Float32Array,
  indices: Uint32Array,
  boundsMin: [number, number, number],
  boundsMax: [number, number, number],
  resolution: number,
  options: BakeSdfOptions = {}
): Promise<SdfVolumeData> {
  const run = () =>
    new Promise<SdfVolumeData>((resolve, reject) => {
      const { onProgress, signal } = options;
      const grid = computeSdfGrid(boundsMin, boundsMax, resolution);
      const posCopy = new Float32Array(positions);
      const idxCopy = new Uint32Array(indices);

      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('SDF bake cancelled', 'AbortError'));
        return;
      }

      const worker = workerFor();
      const started = performance.now();
      let settled = false;
      let last = 0;
      let lastSignal = started;
      const report = (value: number) => {
        last = value;
        onProgress?.(value, performance.now() - started);
      };
      // The worker only speaks per slice, and nothing at all while it is
      // starting: without a clock of our own a stalled bake is indistinguishable
      // from a hung one.
      const ticker = setInterval(() => {
        report(last);
        if (performance.now() - lastSignal > BAKE_STALL_MS) {
          dropWorker();
          finish(() => reject(new Error('SDF bake stalled — the bake worker stopped responding')));
        }
      }, PROGRESS_TICK_MS);
      report(0);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(ticker);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const onAbort = () => {
        // A worker stopped mid-bake cannot be reused: its next message would be
        // for a job nobody is waiting on.
        dropWorker();
        finish(() => reject(signal!.reason ?? new DOMException('SDF bake cancelled', 'AbortError')));
      };

      signal?.addEventListener('abort', onAbort);

      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        lastSignal = performance.now();
        if (msg.type === 'progress') {
          if (!settled) report(msg.value);
          return;
        }
        if (msg.type === 'done') {
          finish(() =>
            resolve({
              origin: grid.origin,
              voxelSize: grid.voxelSize,
              dim: grid.dim,
              distances: msg.distances,
            })
          );
        } else if (msg.type === 'error') {
          finish(() => reject(new Error(msg.message)));
        }
      };
      worker.onerror = (err) => {
        dropWorker();
        finish(() => reject(err instanceof Error ? err : new Error(String(err?.message ?? err))));
      };
      worker.postMessage({
        positions: posCopy,
        indices: idxCopy,
        origin: grid.origin,
        voxelSize: grid.voxelSize,
        dim: grid.dim,
      });
    });

  // One bake at a time: the worker answers whoever asked last.
  const job = bakeQueue.then(run, run);
  bakeQueue = job.then(
    () => undefined,
    () => undefined
  );
  return job;
}
