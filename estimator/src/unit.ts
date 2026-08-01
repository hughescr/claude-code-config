/**
 * src/unit.ts — WHAT A NUMBER MEANS, as one value, compared as one value.
 *
 * `schema.sql` declares the unit of a band as `(ref_model, estimand)`, and v15 added a
 * third leg to it — `sp_anchor_id`, the version of the scale a points band is
 * denominated against. Nothing declared how to COMPARE that tuple, so every site that
 * needed the comparison spelled its own subset:
 *
 *   - `assertAmbientUnitMatches` took `{estimand, anchorId}` and never saw `ref_model`,
 *     so after `est config set ref_model …` an `est block` landed sonnet-denominated
 *     numbers under an opus-denominated parent and `est open --continue` copied the old
 *     raw band verbatim into a row labelled with the new normaliser;
 *   - `newestRefclass` matched `(bucket, family, ref_model, estimand)` but not the
 *     anchor;
 *   - `liveBucketN` matched `(bucket, ref_model, estimand)` and optionally the anchor;
 *   - `foreignAnchorSamples` matched `(bucket, ref_model, estimand, anchor, window)` but
 *     not the estimator FAMILY, so one foreign-family sample suppressed a homogeneous
 *     ten-sample rate;
 *   - `est retro` fitted every `v_velocity` row regardless of `--as-of`, while the guard
 *     that protects the resulting snapshot counted only rows finalized before its
 *     `as_of` — two windows that were never the same window.
 *
 * Six defects, one cause: **the unit was a convention, not a value.** This module makes
 * it a value.
 *
 * ## The shape
 *
 * {@link BandIdentity} carries every component that decides whether two numbers mean the
 * same thing, and its components are `#private`: they cannot be read out, so they cannot
 * be compared one at a time. Three operations are exported in their place, and each one
 * is total over {@link IDENTITY_COMPONENTS}:
 *
 *   - {@link BandIdentity.equals} — the whole tuple or nothing;
 *   - {@link BandIdentity.differences} — what differs, for the refusal prose;
 *   - {@link BandIdentity.samples} — the SQL row set, built from the same component
 *     table, so a query cannot filter on a subset either.
 *
 * Construction is likewise closed: {@link BandIdentity.ambient} (from config) and
 * {@link BandIdentity.ofEstimate} (from a row) are the only two ways to get one, and
 * `ofEstimate` takes {@link EstimateUnitColumns} with every column REQUIRED. A caller
 * that selects two of the three columns does not get a partial comparison; it gets a
 * type error.
 *
 * ## Adding a fifth component
 *
 * Append one entry to {@link IDENTITY_COMPONENTS} and one field to
 * {@link IdentityParts}. `equals`, `differences`, `describe` and the SQL builder all
 * read the table, so nothing else changes — which is the property
 * `test/unit-identity.test.ts` asserts by walking the table rather than by naming
 * components.
 *
 * ## The anchor's text cannot drift from its id
 *
 * The fourth component is the anchor DEFINITION, and it is not stored beside the id
 * anywhere a second copy could disagree: `sp_anchor` (schema v18) is an append-only
 * table keyed by id, so the text is a FUNCTION of the id and `{id: 'v1', text: '<the v2
 * definition>'}` is not a state this database can hold. See `src/db.ts` `setConfig`.
 */

import type { Database } from "bun:sqlite";
import { anchorDefinition, anchorTextOf, getConfig } from "./db.ts";
import { InvariantError } from "./errors.ts";
import { priceFamily } from "./prices.ts";

// ---------------------------------------------------------------------------
// the estimand, and the story-point anchor
// ---------------------------------------------------------------------------

/**
 * The one `config.estimand` value under which a band is RELATIVE rather than absolute.
 *
 * Work-CET turned out to be a unit agents cannot predict: 61.9x spread across models
 * on the same task, with repeated silent 1000x outliers. The same models sized the
 * same work against a fixed anchor to within 1.96x when they decomposed it first. So
 * the estimand becomes "how many times the anchor is this", and the system learns the
 * points -> Work-CET conversion from completed work instead of asking anyone to guess
 * a token count.
 *
 * Everything else about the unit machinery is unchanged and deliberately so: this is a
 * fourth value in a column that is ALREADY a calibration key everywhere
 * (`estimate.estimand`, `refclass`'s primary key, `v_velocity`'s projection, every
 * consumer's filter), so switching to it segregates the new corpus from the old
 * automatically. No history is deleted, and none is redenominated.
 */
export const POINTS_ESTIMAND = "story_point";

export function isPointsEstimand(estimand: string): boolean {
  return estimand === POINTS_ESTIMAND;
}

/** `config.ref_model`'s seed — the fallback when the key is unreadable. */
export const DEFAULT_REF_MODEL = "claude-sonnet-4-5";
/** `config.estimand`'s seed. */
export const DEFAULT_ESTIMAND = "work_cet";
/** `config.sp_anchor_id`'s seed. */
export const DEFAULT_ANCHOR_ID = "v1";

/**
 * What {@link storyPointAnchor} renders when the anchor in force has no `sp_anchor`
 * row: an id whose definition was never recorded.
 *
 * Two ways to reach it, and both are honest rather than broken. A band issued before
 * v18 may name an anchor whose text nobody wrote down, and `est config set sp_anchor_id
 * <new>` deliberately leaves the new id undefined until its text is supplied — that gap
 * is the whole reason the id-then-text order is refused (`src/db.ts` `setConfig`).
 *
 * It is a PLACEHOLDER for display, never a value: {@link BandIdentity} carries `null`
 * for an unrecorded definition and declines to compare it, so this string can never
 * make two anchors look alike.
 */
export const ANCHOR_UNDEFINED_TEXT = "(no definition recorded)";

/**
 * The story-point anchor in force: the work defined to be 1 point, and its version.
 *
 * The text is read from the `sp_anchor` registry rather than from a second config key,
 * so it cannot disagree with the id. `config.sp_anchor_text` still exists and still
 * reads back what you set, but it is a MIRROR maintained by `setConfig` — the registry
 * is the only writer of meaning.
 */
export interface StoryPointAnchor {
  readonly id: string;
  readonly text: string;
  /**
   * Is there a `sp_anchor` row for `id` at all? False means `text` is
   * {@link ANCHOR_UNDEFINED_TEXT} — a placeholder, not a definition — and `est open`
   * refuses to issue a points band against it (v19).
   */
  readonly defined: boolean;
  /**
   * Has a human declared or confirmed this definition? False for a definition the
   * v17 -> v18 step read off the mutable config pair and nobody has vouched for since.
   * A repair state, not a refusal: it is rendered with a marker and it blocks nothing.
   */
  readonly verified: boolean;
}

export function storyPointAnchor(db: Database): StoryPointAnchor {
  const id = getConfig(db, "sp_anchor_id") ?? DEFAULT_ANCHOR_ID;
  const def = anchorDefinition(db, id);
  return {
    id,
    text: def?.text ?? ANCHOR_UNDEFINED_TEXT,
    defined: def !== null,
    verified: def?.verified ?? false,
  };
}

// ---------------------------------------------------------------------------
// the component table — the single list everything below is derived from
// ---------------------------------------------------------------------------

/** The components of a band identity, by name. Extend {@link IDENTITY_COMPONENTS}. */
export type IdentityComponentName = "ref_model" | "estimand" | "sp_anchor_id" | "sp_anchor_text";

/** The private carrier. One field per {@link IDENTITY_COMPONENTS} entry. */
type IdentityParts = Readonly<Record<IdentityComponentName, string | null>>;

export interface IdentityComponent {
  readonly name: IdentityComponentName;
  /** How the component reads in a refusal message. */
  readonly label: string;
  /**
   * The column on `estimate` / `v_velocity` that carries it, or `null` when the
   * component is DERIVED and so has no column of its own. A derived component still
   * takes part in {@link BandIdentity.equals}; it simply cannot be filtered on in SQL,
   * which is exactly why it must not be the only thing standing between two units.
   */
  readonly column: string | null;
  /**
   * When true, `null` on either side means "nothing was recorded", and the component is
   * SKIPPED rather than counted as a difference.
   *
   * This is the anti-over-refusal rule, and it has exactly one occupant. An anchor id
   * that predates the `sp_anchor` registry has no recoverable definition; refusing
   * every band that names one would turn a gap in the record into a wall in front of
   * work whose unit is in fact perfectly well known from its id.
   */
  readonly nullIsUnknown: boolean;
  /** `est config set <key>` that moves it, for the remedy line. */
  readonly configKey: string | null;
}

/**
 * THE list. Everything in this file walks it; nothing in this file names a component
 * except here and in {@link IdentityParts}.
 */
export const IDENTITY_COMPONENTS: readonly IdentityComponent[] = Object.freeze([
  {
    name: "ref_model",
    label: "normaliser",
    column: "ref_model",
    nullIsUnknown: false,
    configKey: "ref_model",
  },
  {
    name: "estimand",
    label: "estimand",
    column: "estimand",
    nullIsUnknown: false,
    configKey: "estimand",
  },
  {
    name: "sp_anchor_id",
    label: "story-point anchor",
    column: "sp_anchor_id",
    nullIsUnknown: false,
    configKey: "sp_anchor_id",
  },
  {
    name: "sp_anchor_text",
    label: "story-point anchor definition",
    column: null,
    nullIsUnknown: true,
    configKey: null,
  },
] as const);

/** One component's disagreement, for the refusal prose. */
export interface IdentityDifference {
  readonly component: IdentityComponent;
  /** The value the ROW being honoured carries. */
  readonly recorded: string | null;
  /** The value in force. */
  readonly ambient: string | null;
}

/**
 * The columns an `estimate` row must supply to name its unit.
 *
 * All three are REQUIRED, and that is the load-bearing part of this interface: the
 * three call sites that used to hand-roll a two-column subset (`est open --tid`'s
 * baseline lookup, `est block`'s parent lookup, and `est open`'s own INSERT) can no
 * longer express one. A `SELECT eid, estimand, sp_anchor_id` does not typecheck here.
 */
export interface EstimateUnitColumns {
  readonly ref_model: string;
  readonly estimand: string;
  readonly sp_anchor_id: string | null;
}

// ---------------------------------------------------------------------------
// BandIdentity
// ---------------------------------------------------------------------------

/**
 * The unit a band's numbers are denominated in — the whole tuple, as one value.
 *
 * The components are `#private` ECMAScript fields, so they are not reachable at
 * runtime and there is no accessor that hands one out. That is deliberate and it is
 * the fix: the six defects this class replaces were all a call site comparing the
 * subset it happened to have in hand. What is exported instead is the COMPARISON
 * ({@link equals}, {@link differences}), the row set ({@link samples}), the write
 * ({@link bindEstimate}) and the prose ({@link describe}).
 */
export class BandIdentity {
  readonly #parts: IdentityParts;

  private constructor(parts: IdentityParts) {
    this.#parts = Object.freeze({ ...parts });
  }

  /**
   * The unit IN FORCE — what `est open` would issue a band in right now.
   *
   * A Work-CET estimand carries no anchor at all: `sp_anchor_id` is NULL on the row and
   * NULL here, because naming the current anchor on a band that is not denominated
   * against one would claim a scale the band does not have.
   */
  static ambient(db: Database): BandIdentity {
    const estimand = getConfig(db, "estimand") ?? DEFAULT_ESTIMAND;
    const anchorId = isPointsEstimand(estimand)
      ? (getConfig(db, "sp_anchor_id") ?? DEFAULT_ANCHOR_ID)
      : null;
    return new BandIdentity({
      ref_model: getConfig(db, "ref_model") ?? DEFAULT_REF_MODEL,
      estimand,
      sp_anchor_id: anchorId,
      sp_anchor_text: anchorId === null ? null : anchorTextOf(db, anchorId),
    });
  }

  /**
   * The unit an `estimate` row is denominated in.
   *
   * The anchor's DEFINITION is resolved from the `sp_anchor` registry by id, never from
   * config: config says what an anchor means TODAY, and this row was issued whenever it
   * was issued. Because the registry is append-only and keyed by id, the definition it
   * returns is the one that was in force when the row was written — there is nowhere
   * else for a second answer to live.
   */
  static ofEstimate(db: Database, row: EstimateUnitColumns): BandIdentity {
    return new BandIdentity({
      ref_model: row.ref_model,
      estimand: row.estimand,
      sp_anchor_id: row.sp_anchor_id,
      sp_anchor_text: row.sp_anchor_id === null ? null : anchorTextOf(db, row.sp_anchor_id),
    });
  }

  /**
   * Every component agrees, or they do not. There is no partial answer and no way to
   * ask for one.
   */
  equals(other: BandIdentity): boolean {
    return this.differences(other).length === 0;
  }

  /**
   * Which components disagree, in {@link IDENTITY_COMPONENTS} order.
   *
   * `this` is the RECORDED side (the row being honoured) and `other` is the ambient
   * one, which is what the field names on {@link IdentityDifference} mean.
   */
  differences(other: BandIdentity): IdentityDifference[] {
    const out: IdentityDifference[] = [];
    for (const component of IDENTITY_COMPONENTS) {
      const mine = this.#parts[component.name];
      const theirs = other.#parts[component.name];
      if (component.nullIsUnknown && (mine === null || theirs === null)) continue;
      if (mine === theirs) continue;
      out.push({ component, recorded: mine, ambient: theirs });
    }
    return out;
  }

  /** One line naming the unit, for a refusal or a report. */
  describe(): string {
    const parts: string[] = [];
    for (const component of IDENTITY_COMPONENTS) {
      const v = this.#parts[component.name];
      if (v === null) continue;
      parts.push(`${component.label} ${JSON.stringify(v)}`);
    }
    return parts.join(", ");
  }

  /**
   * Write this identity's columns into an `INSERT INTO estimate` bind object.
   *
   * A WRITE, not a read: there is no `columns()` that hands the values back, because a
   * caller holding a record of components is one `&&` away from re-introducing the
   * piecemeal comparison this class exists to remove.
   */
  bindEstimate(params: Record<string, unknown>): void {
    params.$ref_model = this.#parts.ref_model;
    params.$estimand = this.#parts.estimand;
    params.$sp_anchor_id = this.#parts.sp_anchor_id;
  }

  /**
   * The `v_velocity` rows that are denominated the way this band is — the ONE
   * expression `est retro` fits over and every guard on its output counts.
   *
   * See {@link SampleScope}.
   */
  samples(opts: {
    /** Upper bound on `finalized_at`. `null` = unbounded. */
    readonly asOf: string | null;
    /** Restrict to one reference-class bucket. `null` = every bucket. */
    readonly bucket?: string | null;
    /** Restrict to one estimator family. `null` = pooled across families. */
    readonly estimatorFamily?: string | null;
  }): SampleScope {
    return new SampleScopeImpl(
      this.#parts,
      opts.asOf,
      opts.bucket ?? null,
      opts.estimatorFamily ?? null,
    );
  }
}

// ---------------------------------------------------------------------------
// the refusal
// ---------------------------------------------------------------------------

/** What a refusal needs to say beyond the units themselves. */
export interface UnitRefusalContext {
  /** Human name of the row being honoured. */
  readonly what: string;
  /** The verb being refused, for the remedy. */
  readonly verb: string;
}

/**
 * REFUSE to write a row into an estimate whose unit the ambient config no longer
 * agrees with (v17, generalised to the whole identity in v18).
 *
 * Everything that hangs off an existing `estimate` — a block, a re-estimate, a roll-up —
 * inherits that estimate's denomination, because that is the band it rolls up into and
 * the band `est close` will score. `config.ref_model`, `config.estimand` and
 * `config.sp_anchor_id` are all MUTABLE and flipping any of them is a one-line command
 * Craig is expected to run; so reading the unit from config at write time means any task
 * open across the flip silently acquires a second denomination. `estimate` and
 * `estimate_block` are both append-only, so the mixed row could never be corrected, and
 * every downstream key carries the unit as if the row were homogeneous.
 *
 * REFUSAL rather than reinterpretation, and the asymmetry is the point: converting would
 * require a rate this system may not have, and relabelling would move a number between
 * units without touching it. Exit **2** — an invariant refusal, not a malformed command
 * line — because retyping the arguments cannot fix it.
 *
 * The remedy names the anchor's DEFINITION, not just its id. Before the `sp_anchor`
 * registry it could not: the text lived in a mutable config key, so "restore
 * sp_anchor_id v1" was advice whose result depended on whether anyone had also re-worded
 * the text since — the exact failure that made this refusal unactionable.
 */
export function assertSameUnit(
  recorded: BandIdentity,
  ambient: BandIdentity,
  ctx: UnitRefusalContext,
): void {
  const diffs = recorded.differences(ambient);
  if (diffs.length === 0) return;
  const listed = diffs
    .map(
      (d) =>
        `${d.component.label} ${JSON.stringify(d.recorded)} -> ${JSON.stringify(d.ambient)}`,
    )
    .join("; ");
  const restore = diffs
    .filter((d) => d.component.configKey !== null && d.recorded !== null)
    .map((d) => `\`est config set ${d.component.configKey} ${d.recorded}\``)
    .join(" + ");
  throw new InvariantError(
    `${ctx.what} is denominated in ${recorded.describe()}, but the unit in force has moved: ${listed}. ` +
      `\`${ctx.verb}\` would store a number of one denomination under a band of another, and both tables are append-only`,
    (restore === "" ? "restore the unit this task was opened in" : `restore the unit this task was opened in — ${restore}`) +
      " — or close it and open the new work fresh under the new unit. A task's unit is fixed at its first estimate; " +
      "nothing converts a band after the fact",
  );
}

// ---------------------------------------------------------------------------
// SampleScope — one row set, one window, one place
// ---------------------------------------------------------------------------

/** The `v_velocity` projection. `SELECT *` over the view, typed. */
export interface VelocitySample {
  bucket: string;
  estimator_model: string;
  price_epoch: string;
  refclass_as_of: string | null;
  ref_model: string;
  estimand: string;
  sp_anchor_id: string | null;
  velocity_raw: number | null;
  velocity_cal: number | null;
  finalized_at: string;
  wcet_main: number;
  wcet_sub: number;
  wcet_aux: number;
  wcet_task_effort: number;
  exp_agents: number;
  n_agents: number;
}

/**
 * Which anchors a query admits.
 *
 *  - `"any"` — every anchor in the unit. What `est retro` fits over, because `refclass`
 *    is keyed on `(as_of, bucket, estimator_family, ref_model, estimand)` and has
 *    nowhere to put a per-anchor snapshot.
 *  - `"this"` — only the identity's own anchor. The honest `bucket_n`.
 *  - `"foreign"` — everything `"any"` admits that `"this"` does not. Non-zero means the
 *    snapshot fitted over `"any"` is a median of two different units.
 *
 * A NULL `sp_anchor_id` counts as FOREIGN: under points it means a band issued before
 * the anchor was recorded, whose denomination nobody can now establish. That is the
 * self-describing reading — never "the current anchor".
 */
export type AnchorFilter = "any" | "this" | "foreign";

/**
 * The completed samples that are denominated the way one band is, inside one window.
 *
 * **This is the type that makes `est retro` and the guard on its output agree.** They
 * used to be two expressions: the retro fitted `WHERE ref_model = ? AND estimand = ?`
 * over every row ever finalized, and the anchor guard counted `… AND finalized_at <= ?`.
 * A retro backdated with `--as-of 2000-01-01` therefore fitted twenty rows from two
 * anchors, stamped the snapshot `as_of 2000-01-01`, and the guard — asking what that
 * snapshot could have seen — correctly found zero foreign samples below the year 2000
 * and licensed a mixed 2,000-per-point median as a v2 rate.
 *
 * The retro was the wrong one. `--as-of T` names the instant a snapshot speaks for, and
 * a snapshot that speaks for T cannot be fitted on outcomes that had not happened at T;
 * `refclass.as_of` is what `estimate.refclass_as_of` points at and what every consumer
 * reads the window off. So the window moved into the retro, and both sides now build it
 * here, from the same fields, in {@link where}.
 */
export interface SampleScope {
  /** The rows. `est retro` fits these. */
  rows(db: Database, anchor?: AnchorFilter): VelocitySample[];
  /** How many. Same predicate, without paying for the wide projection. */
  count(db: Database, anchor?: AnchorFilter): number;
  /** The predicate itself, exposed so a test can assert the two callers share it. */
  where(anchor?: AnchorFilter): { sql: string; params: (string | null)[] };
}

class SampleScopeImpl implements SampleScope {
  constructor(
    private readonly parts: IdentityParts,
    private readonly asOf: string | null,
    private readonly bucket: string | null,
    private readonly estimatorFamily: string | null,
  ) {}

  /**
   * The shared predicate. Built by walking {@link IDENTITY_COMPONENTS}, so a component
   * with a column is filtered on automatically and a component without one cannot be
   * silently forgotten — it simply has no column to filter on, which is a fact about the
   * schema rather than a choice made here.
   *
   * `sp_anchor_id` is handled by `anchor` rather than by the loop, because it is the one
   * component a caller legitimately widens: a `refclass` snapshot is fitted across every
   * anchor in the unit, so the row set that produced it has to be askable that way.
   *
   * The estimator family is NOT in the SQL. `v_velocity` carries `estimator_model` and
   * the pooling key is `priceFamily(estimator_model)`, which is a TypeScript function —
   * `est retro` groups on it in TypeScript and so does {@link matchesFamily}. Doing it
   * two ways is how the family fell out of the anchor guard in the first place.
   */
  where(anchor: AnchorFilter = "any"): { sql: string; params: (string | null)[] } {
    const clauses: string[] = [];
    const params: (string | null)[] = [];
    for (const component of IDENTITY_COMPONENTS) {
      if (component.column === null) continue;
      if (component.column === "sp_anchor_id") continue;
      clauses.push(`${component.column} = ?`);
      params.push(this.parts[component.name]);
    }
    if (anchor === "this") {
      // `IS ?` rather than `= ?`: the parameter may be NULL and SQLite's `=` never
      // matches NULL, so a unit with no anchor recorded would come back as a silent zero
      // instead of as the count it is.
      clauses.push("sp_anchor_id IS ?");
      params.push(this.parts.sp_anchor_id);
    } else if (anchor === "foreign") {
      clauses.push("(sp_anchor_id IS NULL OR sp_anchor_id <> ?)");
      params.push(this.parts.sp_anchor_id);
    }
    if (this.bucket !== null) {
      clauses.push("bucket = ?");
      params.push(this.bucket);
    }
    if (this.asOf !== null) {
      clauses.push("finalized_at <= ?");
      params.push(this.asOf);
    }
    return { sql: clauses.join(" AND "), params };
  }

  /** `null` family = pooled across families, which is what `refclass`'s `'*'` means. */
  private matchesFamily(sample: { estimator_model: string }): boolean {
    if (this.estimatorFamily === null) return true;
    return priceFamily(sample.estimator_model) === this.estimatorFamily;
  }

  rows(db: Database, anchor: AnchorFilter = "any"): VelocitySample[] {
    const { sql, params } = this.where(anchor);
    return db
      .query<VelocitySample, (string | null)[]>(`SELECT * FROM v_velocity WHERE ${sql}`)
      .all(...params)
      .filter((r) => this.matchesFamily(r));
  }

  count(db: Database, anchor: AnchorFilter = "any"): number {
    const { sql, params } = this.where(anchor);
    return db
      .query<{ estimator_model: string }, (string | null)[]>(
        `SELECT estimator_model FROM v_velocity WHERE ${sql}`,
      )
      .all(...params)
      .filter((r) => this.matchesFamily(r)).length;
  }
}
