import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const app = path.resolve(process.argv[2] || "")
if (process.platform !== "darwin" || !app.endsWith(".app")) {
  throw new Error(
    "Usage: node scripts/smoke-packaged-backend.mjs /path/Records.app"
  )
}
const resources = path.join(app, "Contents", "Resources")
const executable = path.join(app, "Contents", "MacOS", "Records")
const home = fs.mkdtempSync(path.join(os.tmpdir(), "records-packaged-smoke-"))
const records = path.join(home, "Library", "Application Support", "records")
const cache = path.join(home, "Library", "Caches", "records")
const child = spawn(
  executable,
  [path.join(resources, "runtime", "bootstrap.js")],
  {
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ELECTRON_RUN_AS_NODE: "1",
      RECORDS_HOST: "electron",
      RECORDS_PACKAGED: "1",
      RECORDS_CONFIG_DIR: records,
      RECORDS_DATA_DIR: records,
      RECORDS_CACHE_DIR: cache,
      RECORDS_RESOURCES_PATH: resources,
      RECORDS_VENDOR_ROOT: path.join(resources, "vendor")
    },
    stdio: ["ignore", "pipe", "pipe"]
  }
)
let output = ""
let errors = ""
const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000)
child.stderr.on("data", (chunk) => {
  errors = (errors + chunk).slice(-16_384)
})
child.stdout.on("data", (chunk) => {
  output += chunk
  if (!output.includes("RECORDS_READY ")) return
  child.kill("SIGTERM")
})
const [code, signal] = await new Promise((resolve) => {
  child.once("exit", (...args) => resolve(args))
})
clearTimeout(timeout)
fs.rmSync(home, { recursive: true, force: true })
if (
  !output.includes("RECORDS_READY ") ||
  (code !== 0 && signal !== "SIGTERM")
) {
  throw new Error(
    `Packaged backend smoke failed (${code ?? signal}): ${errors}`
  )
}
process.stdout.write(
  "Packaged backend reached readiness and shut down cleanly\n"
)
