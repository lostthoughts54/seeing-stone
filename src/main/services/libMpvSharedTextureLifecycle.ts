export interface SharedTextureSlotClaim {
  slot: number;
  sequence: number;
  surfaceGeneration: number;
  releaseNative: () => boolean;
}

export type SharedTextureSlotLifecycleEvent =
  | "slot-tracked"
  | "all-references-released"
  | "slot-reusable"
  | "unimported-slot-released";

interface SharedTextureSlotState extends SharedTextureSlotClaim {
  allReferencesReleased: boolean;
}

/**
 * Gates native texture-slot reuse on Electron's managed allReferencesReleased
 * callback, after renderer references and both processes' GPU work are done.
 */
export class SharedTextureSlotLifecycle {
  private readonly bySequence = new Map<number, SharedTextureSlotState>();
  private readonly sequenceBySlot = new Map<number, number>();

  constructor(private readonly onEvent?: (
    event: SharedTextureSlotLifecycleEvent,
    state: Readonly<SharedTextureSlotState>,
  ) => void) {}

  claim(claim: SharedTextureSlotClaim): void {
    if (this.bySequence.has(claim.sequence)) {
      throw new Error(`LIBMPV_TEXTURE_SEQUENCE_ALREADY_TRACKED:${claim.sequence}`);
    }
    const owner = this.sequenceBySlot.get(claim.slot);
    if (owner !== undefined) {
      throw new Error(`LIBMPV_TEXTURE_SLOT_REUSED_BEFORE_GPU_RELEASE:${claim.slot}:${owner}:${claim.sequence}`);
    }
    const state: SharedTextureSlotState = {
      ...claim,
      allReferencesReleased: false,
    };
    this.bySequence.set(claim.sequence, state);
    this.sequenceBySlot.set(claim.slot, claim.sequence);
    this.onEvent?.("slot-tracked", state);
  }

  has(sequence: number): boolean {
    return this.bySequence.has(sequence);
  }

  matches(sequence: number, surfaceGeneration: number): boolean {
    return this.bySequence.get(sequence)?.surfaceGeneration === surfaceGeneration;
  }

  get pendingCount(): number {
    return this.bySequence.size;
  }

  markAllReferencesReleased(sequence: number): void {
    const state = this.require(sequence);
    if (state.allReferencesReleased) {
      throw new Error(`LIBMPV_TEXTURE_ALL_REFERENCES_RELEASED_TWICE:${sequence}`);
    }
    state.allReferencesReleased = true;
    this.onEvent?.("all-references-released", state);
    this.releaseNative(state, "slot-reusable");
  }

  abandonUnimported(sequence: number): void {
    const state = this.require(sequence);
    if (state.allReferencesReleased) {
      throw new Error(`LIBMPV_TEXTURE_IMPORTED_SLOT_ABANDONED:${sequence}`);
    }
    this.releaseNative(state, "unimported-slot-released");
  }

  discardAll(): void {
    this.bySequence.clear();
    this.sequenceBySlot.clear();
  }

  private require(sequence: number): SharedTextureSlotState {
    const state = this.bySequence.get(sequence);
    if (!state) throw new Error(`LIBMPV_TEXTURE_RELEASE_SIGNAL_WITHOUT_SLOT:${sequence}`);
    return state;
  }

  private releaseNative(state: SharedTextureSlotState, event: SharedTextureSlotLifecycleEvent): void {
    if (!state.releaseNative()) {
      throw new Error(`LIBMPV_NATIVE_TEXTURE_SLOT_RELEASE_REJECTED:${state.slot}:${state.sequence}`);
    }
    this.bySequence.delete(state.sequence);
    this.sequenceBySlot.delete(state.slot);
    this.onEvent?.(event, state);
  }
}
