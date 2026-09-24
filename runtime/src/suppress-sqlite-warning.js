/**
 * Suppress the ExperimentalWarning for node:sqlite.
 *
 * This is a side-effect module — import it before any `node:sqlite` import
 * so the warning handler is registered first.
 *
 * The warning is emitted via process.emitWarning() from the C++ layer,
 * so we override that function to intercept SQLite-specific warnings.
 */
const originalEmitWarning = process.emitWarning.bind(process)

process.emitWarning = function (warning, ...args) {
  const msg = typeof warning === "string" ? warning : (warning?.message ?? "")
  if (msg.includes("SQLite")) {
    return
  }
  return originalEmitWarning(warning, ...args)
}
