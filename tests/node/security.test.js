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
const mode = (filePath) => fs.statSync(filePath).mode & 0o777
const launcherUrl = `http://127.0.0.1:1234/${"a".repeat(64)}/`

function startDefaultServer(dataHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", "runtime/bootstrap.js"],
      {
        cwd: root,
        env: {
          ...process.env,
          XDG_DATA_HOME: dataHome,
          XDG_CACHE_HOME: dataHome,
          XDG_CONFIG_HOME: dataHome,
          RECORDS_DB_PATH: ""
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    let output = ""
    let errors = ""
    child.stderr.on("data", (chunk) => {
      errors += chunk
    })
    child.stdout.on("data", (chunk) => {
      output += chunk
      if (output.includes("RECORDS_READY ")) resolve(child)
    })
    child.once("exit", (code) =>
      reject(new Error(`server exited ${code}: ${errors}`))
    )
  })
}

test("private runtime files repair permissive modes", async (context) => {
  const dataHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-permissions-")
  )
  const records = path.join(dataHome, "records")
  fs.mkdirSync(records, { mode: 0o755 })
  const database = path.join(records, "profiles", "production", "index.sqlite3")
  fs.mkdirSync(path.dirname(database), { recursive: true })
  fs.writeFileSync(database, "")
  fs.chmodSync(database, 0o644)
  const child = await startDefaultServer(dataHome)
  context.after(async () => {
    await new Promise((resolve) => {
      child.once("exit", resolve)
      child.kill("SIGTERM")
    })
    fs.rmSync(dataHome, { recursive: true, force: true })
  })
  assert.equal(mode(records), 0o700)
  assert.equal(mode(database), 0o600)
})

test("launcher uses a private isolated profile and preserves route arguments", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-launcher-"))
  const bin = path.join(directory, "bin")
  const argsFile = path.join(directory, "args.json")
  fs.mkdirSync(bin)
  const chromium = path.join(bin, "chromium")
  fs.writeFileSync(
    chromium,
    `#!/bin/sh\n"${process.execPath}" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' '${argsFile}' "$@"\n`
  )
  fs.chmodSync(chromium, 0o700)
  const result = spawnSync(
    process.execPath,
    ["runtime/launch.js", launcherUrl, "photos", "production"],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin`,
        XDG_DATA_HOME: directory
      },
      encoding: "utf8"
    }
  )
  assert.equal(result.status, 0, result.stderr)
  for (let attempt = 0; attempt < 20 && !fs.existsSync(argsFile); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const profile = path.join(
    directory,
    "records",
    "profiles",
    "production",
    "chromium-profile"
  )
  assert.equal(mode(profile), 0o700)
  const args = JSON.parse(fs.readFileSync(argsFile, "utf8"))
  assert.ok(args.includes(`--user-data-dir=${profile}`))
  assert.ok(args.includes(`--app=${launcherUrl}#photos`))
  fs.rmSync(directory, { recursive: true, force: true })
})

test("launcher reports a missing Chromium executable", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-no-browser-")
  )
  const result = spawnSync(
    process.execPath,
    ["runtime/launch.js", launcherUrl, "today", "production"],
    {
      cwd: root,
      env: { ...process.env, PATH: directory, XDG_DATA_HOME: directory },
      encoding: "utf8"
    }
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /could not launch Chromium/i)
  fs.rmSync(directory, { recursive: true, force: true })
})

test("launcher rejects URLs that only look like loopback URLs", () => {
  for (const url of [
    `http://127.0.0.1:1234@evil.example/${"a".repeat(64)}/`,
    `https://127.0.0.1:1234/${"a".repeat(64)}/`,
    "http://127.0.0.1:1234/not-a-server-token/"
  ]) {
    const result = spawnSync(
      process.execPath,
      ["runtime/launch.js", url, "today", "production"],
      { cwd: root, encoding: "utf8" }
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /invalid app URL/i)
  }
})
