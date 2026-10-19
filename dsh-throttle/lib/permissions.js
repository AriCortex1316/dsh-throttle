/** 权限恢复顺序与档位的权限意图；实际写入由 Host 完成。 */

/**
 * The permission preset a non-default tier restores.
 *
 * Preference order: the preset the user chose while outside the default tier,
 * then the session's original preset, then the configured `deep.permission`
 * when it names a real preset, and finally the first writable preset the
 * deployment offers. The default tier's own preset is never a restore target —
 * restoring it would make the other tiers as confined as the default one, which
 * would strand the session in the read-only trap this version exists to fix.
 *
 * @param config - validated config.
 * @param state - the projection state.
 * @param isSelectable - predicate reporting whether a preset name is offered.
 * @returns the preset to select, or `undefined` when nothing selectable exists.
 */
export function restoreTarget (config, state, isSelectable) {
  for (const candidate of [state.chosenPreset, state.original]) {
    if (typeof candidate === 'string' && candidate !== config.default.permission && isSelectable(candidate)) return candidate
  }
  if (config.deep.permission !== 'restore' && isSelectable(config.deep.permission)) return config.deep.permission
  for (const candidate of ['workspace-write', 'danger-full-access']) {
    if (candidate !== config.default.permission && isSelectable(candidate)) return candidate
  }
  return undefined
}

/**
 * The permission preset a tier wants the session to hold.
 * @param config - validated config.
 * @param mode - the target tier.
 * @param state - the projection state.
 * @param isSelectable - predicate reporting whether a preset name is offered.
 * @returns the preset name, or `undefined` when the tier has no opinion.
 */
export function wantedPreset (config, mode, state, isSelectable) {
  return mode === 'default' ? config.default.permission : restoreTarget(config, state, isSelectable)
}
