import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  otoolBody,
  validateLicenses,
  withSafeOtoolPath
} from "../../scripts/vendor/validate.mjs"

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

test("otool parser excludes the inspected file header", () => {
  const file = "/Users/runner/work/records/vendor/mac-x64/bin/ffmpeg"
  const dependency = "/usr/local/lib/libexample.dylib"

  assert.equal(
    otoolBody(`${file}:\n\t${dependency}\n`, file),
    `\t${dependency}\n`
  )
  assert.throws(
    () => otoolBody("different-file:\n", file),
    /unexpected otool output header/
  )
})

test("otool inspection aliases paths with shell punctuation", (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-otool-test-")
  )
  const file = path.join(directory, "Records Helper (GPU)")
  fs.writeFileSync(file, "binary")
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  let alias
  assert.equal(
    withSafeOtoolPath(file, (inspectedFile) => {
      alias = inspectedFile
      assert.equal(path.basename(inspectedFile), "binary")
      assert.equal(fs.realpathSync(inspectedFile), fs.realpathSync(file))
      return "inspected"
    }),
    "inspected"
  )
  assert.equal(fs.existsSync(alias), false)
})
