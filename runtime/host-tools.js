import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const activeCommands = new Set()
let terminating = false

function killProcessTree(child, signal) {
  if (!Number.isInteger(child.pid)) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== "ESRCH") throw error
  }
}

function waitForClose(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout)
    timer.unref()
    child.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export function terminateActiveProcessTreesSync() {
  terminating = true
  for (const child of activeCommands) killProcessTree(child, "SIGKILL")
}

export async function terminateActiveProcessTrees({ graceMs = 500 } = {}) {
  terminating = true
  const commands = [...activeCommands]
  for (const child of commands) killProcessTree(child, "SIGTERM")
  await Promise.all(commands.map((child) => waitForClose(child, graceMs)))
  for (const child of commands) {
    if (activeCommands.has(child)) killProcessTree(child, "SIGKILL")
  }
  await Promise.all(commands.map((child) => waitForClose(child, graceMs)))
}

process.once("exit", terminateActiveProcessTreesSync)

export function findCommand(name) {
  const directories = (process.env.PATH || "").split(path.delimiter)
  if (process.platform === "linux") directories.push("/usr/bin/vendor_perl")
  for (const directory of directories) {
    if (!directory) continue
    const candidate = path.join(directory, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Try the next PATH entry.
    }
  }
  return null
}

export function runCommand(command, args, options = {}) {
  if (terminating) {
    return Promise.reject(new Error("Records is shutting down"))
  }
  if (options.signal?.aborted) {
    const error = new Error("Command aborted")
    error.name = "AbortError"
    error.code = "ABORT_ERR"
    return Promise.reject(error)
  }
  return new Promise((resolve, reject) => {
    const {
      encoding = "utf8",
      killGraceMs = 500,
      killSignal = "SIGTERM",
      maxBuffer = 16 * 1024 * 1024,
      signal,
      timeout = 120_000,
      ...spawnOptions
    } = options
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    })
    const stdout = []
    const stderr = []
    let stdoutSize = 0
    let stderrSize = 0
    let commandError = null
    let timer = null
    let killTimer = null

    function output(chunks) {
      const value = Buffer.concat(chunks)
      return encoding === "buffer" || encoding === null
        ? value
        : value.toString(encoding)
    }

    function fail(error) {
      if (commandError) return
      commandError = error
      killProcessTree(child, killSignal)
      killTimer = setTimeout(
        () => killProcessTree(child, "SIGKILL"),
        killGraceMs
      )
      killTimer.unref()
    }

    child.stdout.on("data", (chunk) => {
      if (commandError) return
      const remaining = Math.max(0, maxBuffer - stdoutSize)
      if (remaining) stdout.push(chunk.subarray(0, remaining))
      stdoutSize += Math.min(chunk.length, remaining)
      if (chunk.length > remaining) {
        fail(new Error("stdout maxBuffer length exceeded"))
      }
    })
    child.stderr.on("data", (chunk) => {
      if (commandError) return
      const remaining = Math.max(0, maxBuffer - stderrSize)
      if (remaining) stderr.push(chunk.subarray(0, remaining))
      stderrSize += Math.min(chunk.length, remaining)
      if (chunk.length > remaining) {
        fail(new Error("stderr maxBuffer length exceeded"))
      }
    })
    child.once("error", fail)
    activeCommands.add(child)
    const onAbort = () => {
      const error = new Error("Command aborted")
      error.name = "AbortError"
      error.code = "ABORT_ERR"
      fail(error)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    if (timeout > 0) {
      timer = setTimeout(() => {
        const error = new Error(`Command timed out after ${timeout}ms`)
        error.code = "ETIMEDOUT"
        fail(error)
      }, timeout)
      timer.unref()
    }
    child.once("close", (code, signalCode) => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener("abort", onAbort)
      activeCommands.delete(child)
      killProcessTree(child, "SIGKILL")
      const stdoutValue = output(stdout)
      const stderrValue = output(stderr)
      if (!commandError && code === 0) {
        resolve({ stdout: stdoutValue, stderr: stderrValue })
        return
      }
      const error =
        commandError ||
        new Error(stderrValue || `Command exited with code ${code}`)
      error.code ??= code
      error.signal ??= signalCode
      error.stdout = stdoutValue
      error.stderr = stderrValue
      reject(error)
    })
  })
}
