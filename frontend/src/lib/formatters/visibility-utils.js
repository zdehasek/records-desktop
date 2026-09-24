/**
 * Returns true if the visibility value represents an NSFW/folder classification
 * (anything that is not "visible" and not a dot-prefix folder).
 *
 * @param {string|null|undefined} v - The visibility value from a message/photo
 * @returns {boolean}
 */
export function isNsfw(v) {
  return !!v && v !== "visible" && !v.startsWith(".")
}

/**
 * Returns true if the visibility value is a dot-prefix folder (e.g. ".vault").
 *
 * @param {string|null|undefined} v - The visibility value
 * @returns {boolean}
 */
export function isDotFolder(v) {
  return !!v && v.startsWith(".")
}

export function isUserFolder(v) {
  return !!v && v !== "visible"
}
