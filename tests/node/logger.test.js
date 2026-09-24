import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const modulePath = "../../runtime/src/logger.js"

function temporaryDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-logger-"))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function silenceConsole(context) {
  const original = {
    debug: console.debug,
    log: console.log,
    warn: console.warn,
    error: console.error
  }
  const calls = []
  for (const method of Object.keys(original)) {
    console[method] = (...args) => calls.push([method, ...args])
  }
  context.after(() => Object.assign(console, original))
  return calls
}

function useLogMode(context, mode) {
  const previousMode = process.env.REC_LOG_MODE
  process.env.REC_LOG_MODE = mode
  context.after(() => {
    if (previousMode === undefined) delete process.env.REC_LOG_MODE
    else process.env.REC_LOG_MODE = previousMode
  })
}

test("writes at the configured level and formats extra values", async (context) => {
  const directory = temporaryDirectory(context)
  const calls = silenceConsole(context)
  useLogMode(context, "sync")
  const { createLogger, initLogger } = await import(`${modulePath}?sync`)
  initLogger({ dir: directory, level: "warn" })
  const logger = createLogger("worker")
  const circular = {}
  circular.self = circular

  logger.debug("hidden")
  logger.info("also hidden")
  logger.warn("problem", "detail", { code: 4 }, circular)
  logger.error("failed", new Error("boom"), null)

  const output = fs.readFileSync(path.join(directory, "rec.log"), "utf8")
  assert.doesNotMatch(output, /hidden/)
  assert.match(
    output,
    /WARN\s+\[worker\] problem detail \{"code":4\} \[object Object\]/
  )
  assert.match(output, /ERROR \[worker\] failed Error: boom/)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].slice(0, 3), ["warn", "[worker]", "problem"])
})

test("rotates synchronous logs and shifts existing generations", async (context) => {
  const directory = temporaryDirectory(context)
  silenceConsole(context)
  useLogMode(context, "sync")
  const logPath = path.join(directory, "rec.log")
  fs.writeFileSync(logPath, "current log")
  fs.writeFileSync(`${logPath}.1`, "previous log")
  fs.writeFileSync(`${logPath}.2`, "oldest log")
  const { createLogger, initLogger } = await import(`${modulePath}?rotation`)
  initLogger({ dir: directory, maxFileSize: 1, maxFiles: 2 })

  createLogger("rotate").info("new line")

  assert.equal(fs.readFileSync(`${logPath}.1`, "utf8"), "current log")
  assert.equal(fs.readFileSync(`${logPath}.2`, "utf8"), "previous log")
  assert.match(fs.readFileSync(logPath, "utf8"), /\[rotate\] new line/)
})

test("buffers writes when requested and flushes them deterministically", async (context) => {
  const directory = temporaryDirectory(context)
  silenceConsole(context)
  useLogMode(context, "BUFFERED")
  const { createLogger, initLogger } = await import(`${modulePath}?buffered`)
  initLogger({ dir: directory })
  const logger = createLogger("queue")

  logger.info("first")
  logger.info("second")
  await new Promise((resolve) => setTimeout(resolve, 150))

  const output = fs.readFileSync(path.join(directory, "rec.log"), "utf8")
  assert.match(output, /\[queue\] first/)
  assert.match(output, /\[queue\] second/)
})

test("remains console-only without a directory and reports initialization errors", async (context) => {
  const directory = temporaryDirectory(context)
  const calls = silenceConsole(context)
  const blocker = path.join(directory, "not-a-directory")
  fs.writeFileSync(blocker, "file")
  const first = await import(`${modulePath}?console-only`)
  first.initLogger({ level: "debug" })
  first.createLogger("console").debug("visible")
  assert.deepEqual(calls[0], ["debug", "[console]", "visible"])

  const second = await import(`${modulePath}?init-error`)
  second.initLogger({ dir: blocker })
  assert.ok(
    calls.some(
      ([method, message]) =>
        method === "error" &&
        message === "[logger] Failed to create log directory:"
    )
  )
})
