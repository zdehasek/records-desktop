import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { validateElectronStorage } from "../../scripts/validate-electron-storage.mjs"

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "records-storage-test-"))
  const data = path.join(home, "Library", "Application Support", "records")
  const userData = path.join(data, "electron")
  const sessionData = path.join(userData, "session")
  const marker = "records-storage-test-marker"
  fs.mkdirSync(sessionData, { recursive: true })
  fs.writeFileSync(path.join(sessionData, "state.log"), marker)
  return { home, userData, sessionData, marker }
}

test("storage validation accepts Chromium state only in configured roots", (t) => {
  const state = fixture()
  t.after(() => fs.rmSync(state.home, { recursive: true, force: true }))
  const result = validateElectronStorage(state)
  assert.equal(result.markerFiles.length, 1)
  assert.equal(result.sessionFiles.length, 1)
})

test("storage validation rejects empty precreated session data", (t) => {
  const state = fixture()
  t.after(() => fs.rmSync(state.home, { recursive: true, force: true }))
  fs.rmSync(path.join(state.sessionData, "state.log"))
  assert.throws(() => validateElectronStorage(state), /no Chromium state/)
})

test("storage validation rejects markers outside session data", (t) => {
  const state = fixture()
  t.after(() => fs.rmSync(state.home, { recursive: true, force: true }))
  fs.writeFileSync(path.join(state.userData, "escaped.log"), state.marker)
  assert.throws(() => validateElectronStorage(state), /escaped configured/)
})

test("storage validation rejects simultaneous default-profile artifacts", (t) => {
  const state = fixture()
  t.after(() => fs.rmSync(state.home, { recursive: true, force: true }))
  const defaultRoot = path.join(
    state.home,
    "Library",
    "Application Support",
    "records-desktop"
  )
  fs.mkdirSync(defaultRoot, { recursive: true })
  fs.writeFileSync(path.join(defaultRoot, "Local State"), "{}")
  assert.throws(() => validateElectronStorage(state), /outside userData/)
})
