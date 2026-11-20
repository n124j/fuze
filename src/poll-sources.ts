export interface PollSource {
  name: string;
  run(): Promise<unknown>;
}

/** Runs every source in order. One failing never stops the others; the first error is rethrown at the end so the job retries. */
export async function runPollSources(sources: PollSource[]): Promise<void> {
  let first: unknown;
  let failed = false;
  for (const source of sources) {
    try {
      await source.run();
    } catch (err) {
      console.error(`[poll] ${source.name} failed:`, err instanceof Error ? err.message : "unknown error");
      if (!failed) {
        failed = true;
        first = err;
      }
    }
  }
  if (failed) throw first;
}
