import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
)

test("plugin contract and install-like tree validate without dependencies", async () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8")
  )
  for (const file of [
    "Service.qml",
    "BarWidget.qml",
    "Panel.qml",
    "runtime/bootstrap.js",
    "runtime/server.js",
    "runtime/src/profiles.js",
    "frontend/dist/index.html"
  ]) {
    assert.equal(
      fs.existsSync(path.join(root, file)),
      true,
      `${file} is missing`
    )
  }
  assert.equal(manifest.id, "io.github.zdehasek.records")
  assert.equal(manifest.barWidget.defaultSection, "center")
  const panel = fs.readFileSync(path.join(root, "Panel.qml"), "utf8")
  const service = fs.readFileSync(path.join(root, "Service.qml"), "utf8")
  for (const route of ["on-this-day", "on-this-day-story"]) {
    assert.match(panel, new RegExp(`"${route}"`))
  }
  assert.match(panel, /Open Records/)
  assert.doesNotMatch(panel, /New entry/)
  assert.match(service, /days:memory/)
  assert.match(service, /settings:all/)
  assert.match(
    service,
    /autoPhoto: settings\.auto_photo_in_week_overview === "true"/
  )
  assert.doesNotMatch(service, /autoPhoto: true/)
  assert.match(service, /media\/.*\/micro/)
  assert.match(panel, /memoryThumbnailUrl/)
  assert.match(panel, /cache: false/)
  assert.match(panel, /sourceSize\.width: width/)
  assert.doesNotMatch(panel, /source: visible &&/)
  assert.doesNotMatch(service, /visible: false/)
  assert.match(service, /backendRestart\.restart\(\)/)
  assert.match(service, /runtime\/bootstrap\.js/)
  assert.match(service, /message\.profile\.id/)
  assert.match(service, /root\.appUrl = ""/)

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "records-plugin-"))
  const staged = path.join(temporary, "plugin")
  const releaseFiles = spawnSync(
    "git",
    [
      "-c",
      `safe.directory=${root}`,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z"
    ],
    { cwd: root, encoding: "buffer" }
  )
  assert.equal(releaseFiles.status, 0, releaseFiles.stderr.toString())
  for (const relative of releaseFiles.stdout
    .toString()
    .split("\0")
    .filter(Boolean)) {
    if (relative === ".opencode" || relative.startsWith(".opencode/")) continue
    const source = path.join(root, relative)
    if (!fs.existsSync(source)) continue
    const destination = path.join(staged, relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
  }
  const omarchy = spawnSync("omarchy", ["--version"], { encoding: "utf8" })
  if (!omarchy.error) {
    const result = spawnSync("omarchy", ["plugin", "validate", staged], {
      encoding: "utf8"
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }

  const child = spawn(
    process.execPath,
    ["--no-warnings", "runtime/bootstrap.js"],
    {
      cwd: staged,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(temporary, "config"),
        XDG_DATA_HOME: path.join(temporary, "data"),
        XDG_CACHE_HOME: path.join(temporary, "cache"),
        RECORDS_CONFIG_PATH: "",
        RECORDS_DB_PATH: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  )
  try {
    await new Promise((resolve, reject) => {
      let output = ""
      let errors = ""
      const timeout = setTimeout(
        () => reject(new Error(`staged backend did not start: ${errors}`)),
        10_000
      )
      child.stderr.on("data", (chunk) => {
        errors += chunk
      })
      child.stdout.on("data", (chunk) => {
        output += chunk
        if (!output.includes("RECORDS_READY ")) return
        clearTimeout(timeout)
        resolve()
      })
      child.once("exit", (code) => {
        clearTimeout(timeout)
        reject(new Error(`staged backend exited ${code}: ${errors}`))
      })
    })
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM")
      await new Promise((resolve) => child.once("exit", resolve))
    }
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
