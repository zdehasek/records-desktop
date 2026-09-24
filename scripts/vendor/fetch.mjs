import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../..")
const lockPath = path.join(root, "vendor", "sources.lock.json")
const downloadDirectory = path.join(root, ".build", "vendor", "downloads")
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"))

function archiveName(component) {
  const parts = new URL(component.url).pathname.split("/").filter(Boolean)
  return parts.at(-1) === "download" ? parts.at(-2) : parts.at(-1)
}

function sha256(file) {
  const hash = crypto.createHash("sha256")
  hash.update(fs.readFileSync(file))
  return hash.digest("hex")
}

function assertComplete(component) {
  for (const field of [
    "name",
    "version",
    "url",
    "sha256",
    "directory",
    "license"
  ]) {
    if (!component[field])
      throw new Error(
        `${component.name || "source"}: missing ${field} in ${lockPath}`
      )
  }
  if (!/^https:\/\//.test(component.url))
    throw new Error(`${component.name}: source URL must use HTTPS`)
  if (!/^[a-f0-9]{64}$/.test(component.sha256)) {
    throw new Error(`${component.name}: incomplete SHA-256 in ${lockPath}`)
  }
}

async function download(component) {
  assertComplete(component)
  fs.mkdirSync(downloadDirectory, { recursive: true })
  const destination = path.join(downloadDirectory, archiveName(component))
  if (fs.existsSync(destination)) {
    const actual = sha256(destination)
    if (actual === component.sha256) {
      process.stdout.write(`verified ${component.name}: ${actual}\n`)
      return
    }
    fs.rmSync(destination)
  }

  const temporary = `${destination}.part`
  fs.rmSync(temporary, { force: true })
  const result = spawnSync(
    "curl",
    [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--proto",
      "=https",
      "--tlsv1.2",
      "--user-agent",
      "records-desktop-source-builder/0.1",
      "--output",
      temporary,
      component.url
    ],
    { encoding: "utf8" }
  )
  if (result.status !== 0) {
    fs.rmSync(temporary, { force: true })
    throw new Error(
      `${component.name}: download failed: ${result.stderr.trim()}`
    )
  }
  const actual = sha256(temporary)
  if (actual !== component.sha256) {
    fs.rmSync(temporary, { force: true })
    throw new Error(
      `${component.name}: SHA-256 mismatch; expected ${component.sha256}, got ${actual}`
    )
  }
  fs.renameSync(temporary, destination)
  process.stdout.write(`fetched ${component.name}: ${actual}\n`)
}

if (
  lock.schemaVersion !== 1 ||
  !Array.isArray(lock.components) ||
  !lock.components.length
) {
  throw new Error(`Incomplete source lock: ${lockPath}`)
}

const requested = process.argv.slice(2)
const components = requested.length
  ? requested.map((name) => {
      const component = lock.components.find(
        (candidate) => candidate.name === name
      )
      if (!component) throw new Error(`Unknown locked source: ${name}`)
      return component
    })
  : lock.components

for (const component of components) await download(component)
