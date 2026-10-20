/**
 * Runs `task` for every row of a keyset-paged query (ordered by id), sequentially, without
 * letting one failure stop the rest: a row that keeps failing neither aborts the run nor fills
 * a page and starves the rows after it. Throws the collected errors afterwards, so the caller's
 * job still reports the problem. Returns the number of rows visited.
 */
export async function eachRowIndependently<T extends { id: string }>(
  fetchPage: (afterId: string | null, limit: number) => Promise<T[]>,
  task: (row: T) => Promise<unknown>,
  pageSize = 200,
): Promise<number> {
  const errors: unknown[] = [];
  let visited = 0;
  let afterId: string | null = null;
  for (;;) {
    const page = await fetchPage(afterId, pageSize);
    for (const row of page) {
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
