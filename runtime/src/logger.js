import fs from "fs"
import path from "path"

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

let logFilePath = null
let currentLevel = LEVELS.info
let maxFileSize = 5 * 1024 * 1024 // 5 MB
let maxFiles = 5
let logDir = null
let initialized = false
let logMode = "sync"
let bufferedQueue = []
let flushTimer = null
let flushInFlight = false

/**
 * Initialize the logger with a log directory and options.
 * Must be called once from the main process before logging to files.
 * Before this is called, createLogger() still works (console-only).
 */
export function initLogger(options = {}) {
  logDir = options.dir
  currentLevel = LEVELS[options.level] ?? LEVELS.info
  maxFileSize = options.maxFileSize ?? 5 * 1024 * 1024
  maxFiles = options.maxFiles ?? 5
  const defaultLogMode =
    process.env.NODE_ENV === "test" || process.env.VITEST ? "sync" : "buffered"
  logMode = (process.env.REC_LOG_MODE || defaultLogMode).toLowerCase()

  if (!logDir) return

  try {
    fs.mkdirSync(logDir, { recursive: true })
    logFilePath = path.join(logDir, "rec.log")
    initialized = true
  } catch (err) {
    console.error("[logger] Failed to create log directory:", err)
  }
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushBufferedQueue()
  }, 100)
}

function flushBufferedQueue() {
  if (!logFilePath || flushInFlight || bufferedQueue.length === 0) return

  flushInFlight = true
  const lines = bufferedQueue.join("\n") + "\n"
  bufferedQueue = []

  try {
    rotateIfNeeded()
  } catch {
    // ignore — rotateIfNeeded already logs to console
  }

  fs.appendFile(logFilePath, lines, (err) => {
    flushInFlight = false
    if (err) {
      console.error("[logger] Buffered write failed:", err.message)
    }
    if (bufferedQueue.length > 0) {
      scheduleFlush()
    }
  })
}

/**
 * Rotate the log file if it exceeds maxFileSize.
 * Shifts existing rotated files: .1 -> .2 -> .3, etc.
 */
function rotateIfNeeded() {
  if (!logFilePath) return

  try {
    if (!fs.existsSync(logFilePath)) return
    const stats = fs.statSync(logFilePath)
    if (stats.size < maxFileSize) return

    // Delete the oldest rotated file if it exists
    const oldest = `${logFilePath}.${maxFiles}`
    if (fs.existsSync(oldest)) {
      fs.unlinkSync(oldest)
    }

    // Shift existing rotated files: .{n-1} -> .{n}
    for (let i = maxFiles - 1; i >= 1; i--) {
      const src = `${logFilePath}.${i}`
      const dest = `${logFilePath}.${i + 1}`
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest)
      }
    }

    // Rename current log to .1
    fs.renameSync(logFilePath, `${logFilePath}.1`)
  } catch (err) {
    console.error("[logger] Rotation failed:", err)
  }
}

/**
 * Write a line to the log file (synchronous append).
 */
function writeToFile(line) {
  if (!logFilePath) return

  try {
    if (logMode === "buffered") {
      bufferedQueue.push(line)
      if (bufferedQueue.length >= 100) {
        flushBufferedQueue()
      } else {
        scheduleFlush()
      }
      return
    }

    rotateIfNeeded()
    fs.appendFileSync(logFilePath, line + "\n")
  } catch (err) {
    // Avoid infinite loop — only write to console
    console.error("[logger] Write failed:", err.message)
  }
}

/**
 * Format a timestamp for log output.
 */
function timestamp() {
  return new Date().toISOString()
}

/**
 * Format an error for logging. Extracts the stack trace if available.
 */
function formatError(err) {
  if (!err) return ""
  if (err instanceof Error) {
    return err.stack || `${err.name}: ${err.message}`
  }
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Create a tagged logger instance.
 * Returns { debug, info, warn, error } — compatible with the existing
 * service `{ info, error }` injection pattern.
 *
 * @param {string} tag - Module name for log prefix (e.g. "photo-watcher")
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
export function createLogger(tag) {
  const makeLogFn = (level, levelName, consoleFn) => {
    return (msg, ...args) => {
      if (LEVELS[level] < currentLevel) return

      const prefix = `[${tag}]`
      const levelTag = levelName.toUpperCase().padEnd(5)

      // Build the file log line
      const parts = [msg]
      for (const arg of args) {
        parts.push(formatError(arg))
      }
      const fileLine = `${timestamp()} ${levelTag} ${prefix} ${parts.join(" ")}`

      // Write to console
      consoleFn(prefix, msg, ...args)

      // Write to file (if initialized)
      if (initialized) {
        writeToFile(fileLine)
      }
    }
  }

  return {
    debug: makeLogFn("debug", "DEBUG", console.debug),
    info: makeLogFn("info", "INFO", console.log),
    warn: makeLogFn("warn", "WARN", console.warn),
    error: makeLogFn("error", "ERROR", console.error)
  }
}
