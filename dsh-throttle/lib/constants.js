/** 档位、回执与投影版本的稳定标识。 */

/** The three tiers, in the order a bare `/throttle` walks them. */
export const MODES = Object.freeze(['default', 'deep', 'free'])

/** Receipt prefixes fixed by PLAN-throttle-mode.md section 3. */
export const RECEIPT = Object.freeze({ default: '🍃 Tight', deep: '⚡ Wide', free: '♾️ Open' })

/** Display names used in receipts, notes, and the model-facing text. */
export const MODE_LABELS = Object.freeze({ default: 'Tight', deep: 'Wide', free: 'Open' })

/** The projection key this plugin owns. */
export const PROJECTION_KEY = 'throttleMode'

/**
 * The projection state version.
 *
 * 1 → 2: the two-state `active` boolean became the three-tier `mode` string.
 * 2 → 3: `commanded` was added, so a session can be told apart from one that
 * merely *folded* to the default tier. That distinction is what lets a
 * sub-session without a `/throttle` record of its own inherit the delegating
 * session's tier instead of being pinned to Tight.
 *
 * A persisted checkpoint carrying an older version is discarded and refolded
 * from the log, which is lossless because the fold derives everything from
 * already-persisted events.
 */
export const PROJECTION_VERSION = 3

/** Minimum allowed value for the deep-state limits (PLAN section 5.5). */
export const DEEP_MINIMUM = 5
