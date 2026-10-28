/** Prevents a delayed initial read from overwriting a newer event-driven value. */
export class LatestReadGuard {
  private revision = 0;

  capture() {
    return this.revision;
  }

  invalidate() {
    this.revision += 1;
  }

  isCurrent(revision: number) {
    return revision === this.revision;
  }
}
