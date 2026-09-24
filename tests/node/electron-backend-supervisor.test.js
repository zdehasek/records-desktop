import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import test from "node:test"
import { BackendSupervisor } from "../../desktop/electron/backend-supervisor.js"

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.exitCode = null
    this.signalCode = null
    this.signals = []
    this.messages = []
  }

  kill(signal) {
    this.signals.push(signal)
    return true
  }
  send(message) {
    this.messages.push(message)
  }

  exit(code, signal = null) {
    this.exitCode = code
    this.signalCode = signal
    this.emit("exit", code, signal)
  }
}

const token = "b".repeat(64)

function harness(overrides = {}) {
  const children = []
  const spawns = []
  const timers = []
  const supervisor = new BackendSupervisor({
    executable: "/opt/Records/records",
    repositoryRoot: "/app",
    environment: { HOME: "/home/user" },
    handleHostRequest: async (request) =>
      request.method === "chooseFile" ? "/photo.jpg" : true,
    randomToken: () => token,
    spawn: (...args) => {
      spawns.push(args)
      const child = new FakeChild()
      children.push(child)
      return child
    },
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true
    },
    ...overrides
  })
  return { supervisor, children, spawns, timers }
}

function makeReady(port = 4040, profile = "production") {
  return `RECORDS_READY ${JSON.stringify({
    url: `http://127.0.0.1:${port}/${token}/`,
    profile: { id: profile, name: profile }
  })}\n`
}

test("backend starts under Electron's executable and validates readiness", async () => {
  const { supervisor, children, spawns } = harness()
  const started = supervisor.start()
  assert.deepEqual(spawns[0].slice(0, 2), [
    "/opt/Records/records",
    ["/app/runtime/bootstrap.js"]
  ])
  assert.equal(spawns[0][2].env.ELECTRON_RUN_AS_NODE, "1")
  assert.equal(spawns[0][2].env.RECORDS_BASE_TOKEN, token)
  assert.deepEqual(spawns[0][2].stdio, ["ignore", "pipe", "pipe", "ipc"])
  children[0].emit("message", {
    type: "records:ready",
    url: `http://127.0.0.1:4040/${token}/`,
    profile: { id: "production", name: "production" }
  })
  assert.deepEqual(await started, {
    url: `http://127.0.0.1:4040/${token}/`,
    profile: { id: "production", name: "production" }
  })
})

test("backend native requests receive typed responses", async () => {
  const { supervisor, children } = harness()
  const started = supervisor.start()
  children[0].stdout.write(makeReady())
  await started
  children[0].emit("message", {
    type: "records:host-request",
    id: 9,
    method: "chooseFile",
    args: []
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(children[0].messages, [
    { type: "records:host-response", id: 9, result: "/photo.jpg" }
  ])
})

test("startup timeout terminates the backend", async () => {
  const { supervisor, children, timers } = harness()
  const started = supervisor.start()
  timers[0].callback()
  await assert.rejects(started, /startup timed out/)
  assert.deepEqual(children[0].signals, ["SIGTERM"])
})

test("profile switches restart immediately and rapid crashes back off", async () => {
  let time = 0
  const { supervisor, children, timers } = harness({ now: () => time })
  const restarts = []
  supervisor.on("restarting", (event) => restarts.push(event))
  const first = supervisor.start()
  children[0].stdout.write(makeReady())
  await first
  children[0].exit(75)
  assert.deepEqual(restarts[0], { reason: "profile-switch", delay: 0 })
  timers.at(-1).callback()
  children[1].stdout.write(makeReady(4041, "family"))
  await supervisor.start()
  children[1].exit(1)
  assert.equal(restarts[1].reason, "crash")
  assert.equal(restarts[1].delay, 1000)
  timers.at(-1).callback()
  children[2].stdout.write(makeReady(4042, "family"))
  await supervisor.start()
  children[2].exit(1)
  assert.equal(restarts[2].delay, 2000)
  timers.at(-1).callback()
  children[3].stdout.write(makeReady(4043, "family"))
  await supervisor.start()
  children[3].exit(1)
  assert.equal(restarts[3].delay, 4000)

  timers.at(-1).callback()
  children[4].stdout.write(makeReady(4044, "family"))
  await supervisor.start()
  time = 30_000
  children[4].exit(1)
  assert.equal(restarts[4].delay, 1000)
})

test("stopping a pending restart prevents another spawn", async () => {
  const { supervisor, children, spawns, timers } = harness()
  const started = supervisor.start()
  children[0].stdout.write(makeReady())
  await started
  children[0].exit(1)
  const restart = timers.at(-1)

  await supervisor.stop()
  restart.callback()
  assert.equal(spawns.length, 1)
})

test("scheduled startup failures are emitted", async () => {
  const { supervisor, children, timers } = harness()
  const errors = []
  supervisor.on("error", (error) => errors.push(error))
  const started = supervisor.start()
  children[0].stdout.write(makeReady())
  await started
  children[0].exit(1)
  timers.at(-1).callback()
  children[1].emit("error", new Error("spawn failed"))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /spawn failed/)
})

test("shutdown escalates from SIGTERM to SIGKILL", async () => {
  const { supervisor, children, timers } = harness()
  const started = supervisor.start()
  children[0].stdout.write(makeReady())
  await started
  const stopped = supervisor.stop()
  assert.deepEqual(children[0].signals, ["SIGTERM"])
  timers.at(-1).callback()
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"])
  children[0].exit(null, "SIGKILL")
  await stopped
})
