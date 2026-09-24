import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { validateLicenses } from "../../scripts/vendor/validate.mjs"

const root = path.resolve(import.meta.dirname, "../..")
const lockPath = path.join(root, "vendor", "sources.lock.json")
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"))

test("staged vendor licenses match every locked component", (context) => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "records-vendor-test-"))
  context.after(() => fs.rmSync(stage, { recursive: true, force: true }))

  for (const component of lock.components) {
    const directory = path.join(stage, "licenses", component.name)
    fs.mkdirSync(directory, { recursive: true })
    for (const file of component.licenseFiles) {
      fs.writeFileSync(path.join(directory, path.basename(file)), "license\n")
    }
  }
  fs.copyFileSync(lockPath, path.join(stage, "sources.lock.json"))

  assert.doesNotThrow(() => validateLicenses(stage))
})
