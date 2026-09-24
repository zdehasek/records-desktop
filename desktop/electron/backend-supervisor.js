import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import path from "node:path"
import process from "node:process"
import { clearTimeout, setTimeout } from "node:timers"
import { fileURLToPath } from "node:url"
import {
  HOST_RESPONSE_TYPE,
  READY_TYPE,
  parseReadyLine,
  validateHostRequest,
  validateReadyMessage
} from "./protocol.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const defaultRoot = path.resolve(here, "../..")

function value(option) {
  return typeof option === "function" ? option() : option
}

export class BackendSupervisor extends EventEmitter {
  constructor(options = {}) {
    super()
    this.spawn = options.spawn
    this.executable = options.executable ?? process.execPath
    this.repositoryRoot = options.repositoryRoot ?? defaultRoot
    this.runtimeDirectory = options.runtimeDirectory
    this.workingDirectory = options.workingDirectory
    this.environment = options.environment ?? process.env
    this.handleHostRequest = options.handleHostRequest
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000
    this.maximumBackoffMs = options.maximumBackoffMs ?? 30_000
    this.healthyRunMs = options.healthyRunMs ?? 30_000
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.randomToken =
      options.randomToken ?? (() => randomBytes(32).toString("hex"))
    this.child = null
    this.restartTimer = null
    this.failures = 0
    this.stopping = false
    this.startPromise = null
    this.generation = 0
  }

  start() {
    if (this.startPromise) return this.startPromise
    this.stopping = false
    this.startPromise = this.#launch()
    return this.startPromise
  }

  #launch() {
    return new Promise((resolve, reject) => {
      const token = this.randomToken()
      const generation = ++this.generation
      const repositoryRoot = value(this.repositoryRoot)
      const runtimeDirectory = this.runtimeDirectory
        ? value(this.runtimeDirectory)
        : path.join(repositoryRoot, "runtime")
      const workingDirectory = this.workingDirectory
        ? value(this.workingDirectory)
        : repositoryRoot
      let settled = false
      let readyReceived = false
      let readyAt = null
      let output = ""
      let stderr = ""
      let startupTimer
      let killTimer
      const child = this.spawn(
        this.executable,
        [path.join(runtimeDirectory, "bootstrap.js")],
        {
          cwd: workingDirectory,
          env: {
            ...value(this.environment),
            ELECTRON_RUN_AS_NODE: "1",
            RECORDS_BASE_TOKEN: token
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"]
        }
      )
      this.child = child

      const clearStartupTimers = () => {
        this.clearTimer(startupTimer)
        this.clearTimer(killTimer)
      }
      const terminateStartup = () => {
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill("SIGTERM")
        killTimer = this.setTimer(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL")
          }
        }, this.shutdownTimeoutMs)
        killTimer.unref?.()
      }
      const failStartup = (error) => {
        if (settled) return
        settled = true
        clearStartupTimers()
        this.startPromise = null
        terminateStartup()
        reject(error)
      }
      const acceptReady = (message) => {
        if (settled || generation !== this.generation || this.child !== child) {
          return
        }
        const ready = validateReadyMessage(message, token)
        settled = true
        readyReceived = true
        readyAt = this.now()
        clearStartupTimers()
        resolve(ready)
        this.emit("ready", ready)
      }

      startupTimer = this.setTimer(
        () => failStartup(new Error("Records backend startup timed out")),
        this.startupTimeoutMs
      )
      startupTimer.unref?.()

      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-16_384)
      })
      child.stdout?.on("data", (chunk) => {
        output = (output + String(chunk)).slice(-65_536)
        const lines = output.split("\n")
        output = lines.pop()
        for (const line of lines) {
          try {
            const ready = parseReadyLine(line, token)
            if (ready) acceptReady(ready)
          } catch (error) {
            failStartup(error)
            return
          }
        }
      })
      child.on("message", (message) => {
        if (generation !== this.generation || this.child !== child) return
        if (message?.type === READY_TYPE) {
          try {
            acceptReady(message)
          } catch (error) {
            failStartup(error)
          }
          return
        }
        if (message?.type !== "records:host-request") return
        let request
        try {
          request = validateHostRequest(message)
        } catch (error) {
          child.send?.({
            type: HOST_RESPONSE_TYPE,
            id: Number.isSafeInteger(message?.id) ? message.id : 0,
            error: { message: error.message }
          })
          return
        }
        Promise.resolve(this.handleHostRequest?.(request)).then(
          (result) =>
            child.send?.({
              type: HOST_RESPONSE_TYPE,
              id: request.id,
              result
            }),
          (error) =>
            child.send?.({
              type: HOST_RESPONSE_TYPE,
              id: request.id,
              error: { message: error?.message || "Native operation failed" }
            })
        )
      })
      child.once("error", failStartup)
      child.once("exit", (code, signal) => {
        clearStartupTimers()
        if (this.child === child) this.child = null
        this.startPromise = null
        if (settled && !readyReceived) return
        if (!settled) {
          settled = true
          reject(
            new Error(
              `Records backend exited during startup (${code ?? signal})${stderr ? `: ${stderr.trim()}` : ""}`
            )
          )
          return
        }
        if (this.stopping) return
        if (code === 75) {
          this.failures = 0
          this.emit("restarting", { reason: "profile-switch", delay: 0 })
          this.#scheduleRestart(0)
          return
        }
        if (readyAt !== null && this.now() - readyAt >= this.healthyRunMs) {
          this.failures = 0
        }
        const delay = Math.min(1000 * 2 ** this.failures, this.maximumBackoffMs)
        this.failures += 1
        this.emit("restarting", { reason: "crash", code, signal, delay })
        this.#scheduleRestart(delay)
      })
    })
  }

  #scheduleRestart(delay) {
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null
      if (this.stopping) return
      this.startPromise = this.#launch()
      this.startPromise.catch((error) => this.emit("error", error))
    }, delay)
    this.restartTimer.unref?.()
  }

  async stop() {
    this.stopping = true
    this.generation += 1
    this.clearTimer(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise((resolve) => {
      let escalation
      const done = () => {
        this.clearTimer(escalation)
        resolve()
      }
      child.once("exit", done)
      child.kill("SIGTERM")
      escalation = this.setTimer(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL")
        }
      }, this.shutdownTimeoutMs)
      escalation.unref?.()
    })
  }
}

export function createBackendSupervisor(options) {
  return new BackendSupervisor(options)
}
