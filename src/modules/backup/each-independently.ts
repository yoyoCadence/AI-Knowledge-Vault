/**
 * Runs `task` for every row of a keyset-paged query (ordered by id), sequentially, without
 * letting one failure stop the rest: a row that keeps failing neither aborts the run nor fills
 * a page and starves the rows after it. Throws the collected errors afterwards, so the caller's
 * job still reports the problem. Returns the number of rows visited.
 *
 * `signal` (the job's timeout) is checked before every page and row: an aborted job stops at
 * once instead of carrying on detached from the worker.
 */
export async function eachRowIndependently<T extends { id: string }>(
  fetchPage: (afterId: string | null, limit: number) => Promise<T[]>,
  task: (row: T) => Promise<unknown>,
  options: { pageSize?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const { pageSize = 200, signal } = options;
  const errors: unknown[] = [];
  let visited = 0;
  let afterId: string | null = null;
  for (;;) {
    signal?.throwIfAborted();
    const page = await fetchPage(afterId, pageSize);
    for (const row of page) {
      signal?.throwIfAborted();
      try {
        await task(row);
      } catch (error) {
        errors.push(error);
      }
    }
    visited += page.length;
    if (page.length < pageSize) break;
    afterId = page.at(-1)!.id;
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} of ${visited} cleanup step(s) failed`);
  }
  return visited;
}
