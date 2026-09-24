/**
 * Barrel re-export of all repository infrastructure.
 * Every repo file imports from this single module instead of
 * separate infrastructure imports.
 *
 * Usage in a repository:
 *   import { wrapDb } from "../db/repo-helpers.js"
 */
export { wrapDb } from "./helpers.js"
