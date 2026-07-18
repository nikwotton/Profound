export interface StoppableResource {
  stop(): Promise<void>;
}

/** Small async-disposal scope for service bootstrap code. */
export class ResourceScope {
  readonly #releases: Array<() => void | Promise<void>> = [];
  #closed = false;

  defer(release: () => void | Promise<void>): void {
    if (this.#closed) throw new Error("Cannot add a resource to a closed scope");
    this.#releases.push(release);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const releases = this.#releases.splice(0).reverse();
    let firstFailure: Error | undefined;
    for (const release of releases) {
      try {
        await release();
      } catch (reason) {
        firstFailure ??= reason instanceof Error ? reason : new Error("Resource cleanup failed");
      }
    }
    if (firstFailure !== undefined) throw firstFailure;
  }

  service(): StoppableResource {
    return { stop: () => this.close() };
  }
}
