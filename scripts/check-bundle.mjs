import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const expected = path.join(root, "frontend", "dist")
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "records-bundle-"))
const actual = path.join(temporaryRoot, "dist")

function inventory(directory, prefix = "") {
  const result = new Map()
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const item of inventory(absolute, relative)) result.set(...item)
    } else {
      result.set(
        relative,
        createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")
      )
    }
  }
  return result
}

try {
  const result = spawnSync(
    path.join(root, "node_modules", ".bin", "vite"),
    ["build", "--outDir", actual, "--emptyOutDir"],
    { cwd: root, encoding: "utf8" }
  )
  if (result.status !== 0) {
    process.stderr.write(
      result.stderr ||
        result.stdout ||
        `${result.error?.message || "Vite failed"}\n`
    )
    process.exitCode = result.status || 1
  } else {
    const expectedFiles = inventory(expected)
    const actualFiles = inventory(actual)
    const differences = new Set([
      ...expectedFiles.keys(),
      ...actualFiles.keys()
    ])
    for (const name of [...differences]) {
      if (expectedFiles.get(name) === actualFiles.get(name))
        differences.delete(name)
    }
    if (differences.size) {
      process.stderr.write(
        `Committed frontend bundle is stale:\n${[...differences].sort().join("\n")}\n`
      )
      process.exitCode = 1
    }
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
