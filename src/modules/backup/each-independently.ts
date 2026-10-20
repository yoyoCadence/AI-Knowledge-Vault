/**
 * Runs `task` for every item, sequentially, without letting one failure stop the rest (one
 * stuck object must not starve cleanup of the others). Throws the first error afterwards, with
 * the failure count, so the caller's job still reports the problem.
 */
export async function eachIndependently<T>(
  items: readonly T[],
  task: (item: T) => Promise<unknown>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const item of items) {
    try {
      await task(item);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} of ${items.length} cleanup step(s) failed`);
  }
}
