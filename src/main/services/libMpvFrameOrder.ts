export function isStrictlyNewerFrameSequence(lastSequence: number, candidateSequence: unknown): candidateSequence is number {
  return Number.isSafeInteger(candidateSequence)
    && Number(candidateSequence) > 0
    && Number(candidateSequence) > lastSequence;
}
