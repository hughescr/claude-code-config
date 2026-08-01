/**
 * src/errors.ts — the exit-code contract, as types.
 *
 * These two classes used to live in `src/tasks.ts`, which is where every verb that
 * throws them also lives. They moved here for one mechanical reason: `src/db.ts` now
 * refuses an anchor redefinition (see {@link module:db} `setConfig`) and `src/unit.ts`
 * refuses a cross-unit write, and both of those are imported BY `tasks.ts`. Importing
 * the error classes back out of `tasks.ts` would close a cycle through the module that
 * owns the write verbs.
 *
 * `src/tasks.ts` re-exports both names, so `instanceof UsageError` in `src/cli.ts`
 * still compares against these exact class objects — there is one definition, not two.
 */

/** Exit 1: the command was malformed, or the anchor could not be resolved. */
export class UsageError extends Error {
  readonly exitCode = 1;
}

/**
 * Exit 2: the command was well-formed and the operation is NOT PERMITTED.
 *
 * "Exit 2 is the anti-Goodhart code and it must never be retried, worked around, or
 * downgraded to a warning" (P1.0). Its message names the append path that is
 * allowed, so `remedy` is not optional prose — it is the payload.
 */
export class InvariantError extends Error {
  readonly exitCode = 2;
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
  }
}
