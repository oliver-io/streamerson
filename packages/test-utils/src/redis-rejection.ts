/**
 * `expectRejection` — assert that an async operation rejects, WITHOUT `bun:test`'s
 * `expect(...).rejects`.
 *
 * KNOWN BUG WORKAROUND (Bun 1.3.13). `await expect(<an in-flight Bun.RedisClient
 * command that rejects>).rejects.toThrow()` can HANG forever and wedge the connection:
 * the matcher drives the promise without advancing the event-loop I/O turn that reads
 * the command's reply off the socket, so the promise never settles and the connection's
 * command pipeline stalls behind it. It is a timing race — the first/cold-connection
 * operation reliably loses. A plain `try { await op() } catch {}` drives reply dispatch
 * correctly and never wedges, so all assertions that a Redis datasource operation
 * rejects MUST go through this helper, not `expect().rejects`. (Standalone reproduction
 * + full writeup: the sibling `bunbug/` project's BUG.md; reported upstream to Bun.)
 *
 * This helper deliberately uses no test-framework matcher — it throws plain `Error`s on
 * an unmet expectation, which `bun:test` reports as an ordinary test failure.
 *
 * @returns the rejection error (so callers can make further assertions on it).
 * @throws if `op()` resolves, or rejects with a message not matching `messagePattern`.
 */
export async function expectRejection(
  op: () => Promise<unknown>,
  messagePattern?: RegExp,
): Promise<Error> {
  let resolvedValue: unknown;
  let rejected = false;
  let error: unknown;
  try {
    resolvedValue = await op();
  } catch (e) {
    rejected = true;
    error = e;
  }

  if (!rejected) {
    throw new Error(`expectRejection: expected the operation to reject, but it resolved with ${JSON.stringify(resolvedValue) ?? 'undefined'}`);
  }
  const message = String((error as Error)?.message ?? error);
  if (messagePattern && !messagePattern.test(message)) {
    throw new Error(`expectRejection: rejection message did not match ${messagePattern} — got: ${message}`);
  }
  return error as Error;
}
