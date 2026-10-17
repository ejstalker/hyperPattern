import type { vec3 } from 'gl-matrix';

/** One world-axis turn applied to a selection during a placement gesture. */
export type PlacementTurn = {
  axis: [number, number, number];
  radians: number;
};

/** What a finished placement gesture did to the cloth. */
export type PlacementCommit = {
  /** The pieces the gesture moved, in selection order. */
  pieceIds: string[];
  /** Something was translated. */
  moved: boolean;
  /** Turns applied about the world axes, applied in order. */
  turns: PlacementTurn[];
};

const MIN_TRAVEL = 1e-6;
const MIN_TURN = 1e-8;

/**
 * Records what a placement gesture (a free drag or a gizmo drag) did, so the
 * owner can write the result back to the node the drape was built from.
 *
 * The transforms are kept as world-axis turns rather than a finished
 * quaternion because the stored placement is a rotation *applied on top of* the
 * orientation the piece already had: composing them one at a time reproduces
 * the renderer's own accumulation exactly, and a plain drag of a never-rotated
 * piece stays representable as euler degrees.
 */
export class PlacementGesture {
  private pieceIds: string[] = [];
  private turns: PlacementTurn[] = [];
  private moved = false;
  private active = false;

  /** Start a gesture over the given pieces. */
  begin(pieceIds: Iterable<string>): void {
    this.pieceIds = [...pieceIds];
    this.turns = [];
    this.moved = false;
    this.active = this.pieceIds.length > 0;
  }

  /** Note a world-space translation applied to the whole selection. */
  movedBy(delta: vec3): void {
    if (!this.active) return;
    if (Math.abs(delta[0]) + Math.abs(delta[1]) + Math.abs(delta[2]) > MIN_TRAVEL) {
      this.moved = true;
    }
  }

  /** Note a rotation applied to the whole selection about a world axis. */
  turned(axis: vec3, radians: number): void {
    if (!this.active) return;
    if (!Number.isFinite(radians) || Math.abs(radians) < MIN_TURN) return;
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    if (!Number.isFinite(length) || length < MIN_TURN) return;
    this.turns.push({ axis: [axis[0] / length, axis[1] / length, axis[2] / length], radians });
  }

  /**
   * Finish the gesture. Returns what changed, or `null` when the gesture was
   * empty (a click with no drag) so callers can skip the work entirely.
   */
  end(): PlacementCommit | null {
    const commit =
      this.active && (this.moved || this.turns.length > 0)
        ? { pieceIds: [...this.pieceIds], moved: this.moved, turns: [...this.turns] }
        : null;
    this.cancel();
    return commit;
  }

  cancel(): void {
    this.pieceIds = [];
    this.turns = [];
    this.moved = false;
    this.active = false;
  }
}
