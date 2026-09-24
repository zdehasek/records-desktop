import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  runCommand,
  terminateActiveProcessTrees
} from "../../runtime/host-tools.js"

function processExists(pid) {
  try {
    process.kill(pid, 0)
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
      const state = stat.slice(stat.lastIndexOf(") ") + 2, -1).split(" ")[0]
      if (state === "Z") return false
    }
    return true
  } catch (error) {
    if (error.code === "ESRCH" || error.code === "ENOENT") return false
    throw error
  }
}

async function waitFor(check, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Timed out waiting for condition")
}

test("command timeouts escalate to kill TERM-ignoring process trees", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-timeout-"))
  const parentPidPath = path.join(directory, "parent.pid")
  const childPidPath = path.join(directory, "child.pid")
  const scriptPath = path.join(directory, "command.js")
  fs.writeFileSync(
    scriptPath,
    `import { spawn } from "node:child_process"
import fs from "node:fs"
fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid))
const child = spawn(process.execPath, ["-e", ${JSON.stringify("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)")}])
fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))
process.on("SIGTERM", () => {})
setInterval(() => {}, 1000)
`
  )

  const running = runCommand(process.execPath, [scriptPath], {
    timeout: 2_000,
    killGraceMs: 100
  })
  const rejected = assert.rejects(running, (error) => {
    assert.equal(error.code, "ETIMEDOUT")
    return true
  })
  await waitFor(() => fs.existsSync(childPidPath))
  const parentPid = Number(fs.readFileSync(parentPidPath, "utf8"))
  const childPid = Number(fs.readFileSync(childPidPath, "utf8"))

  await rejected
  await waitFor(() => !processExists(parentPid) && !processExists(childPid))
  fs.rmSync(directory, { recursive: true, force: true })
})

test("terminating commands kills their descendant process trees", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-tools-"))
  const parentPidPath = path.join(directory, "parent.pid")
  const childPidPath = path.join(directory, "child.pid")
  const scriptPath = path.join(directory, "command.js")
  fs.writeFileSync(
    scriptPath,
    `import { spawn } from "node:child_process"
import fs from "node:fs"
fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid))
const child = spawn(process.execPath, ["-e", ${JSON.stringify("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)")}])
fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))
process.on("SIGTERM", () => {})
setInterval(() => {}, 1000)
`
  )

  const running = runCommand(process.execPath, [scriptPath], { timeout: 0 })
  const rejected = assert.rejects(running)
  await waitFor(() => fs.existsSync(childPidPath))
  const parentPid = Number(fs.readFileSync(parentPidPath, "utf8"))
  const childPid = Number(fs.readFileSync(childPidPath, "utf8"))

  await terminateActiveProcessTrees({ graceMs: 50 })
  await rejected
  await waitFor(() => !processExists(parentPid) && !processExists(childPid))
  fs.rmSync(directory, { recursive: true, force: true })
})
