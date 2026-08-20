/**
 * dsh-plugin-letme-annotator — host loader entry.
 *
 * The host half contributes nothing host-side: this package is a browser-only
 * client plugin. All behavior lives in lib/client.js (the `dsh.client` bundle).
 */
/** Provides no host-side behavior. */
function apply() {}

export { apply };
