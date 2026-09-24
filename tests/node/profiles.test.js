import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  activeProfileId,
  activeProfilePath,
  assertManagedProfileEnvironment,
  commitStartupProfile,
  createProfile,
  listProfiles,
  pendingProfilePath,
  profileCacheDirectory,
  profileConfigDirectory,
  profileConfigPath,
  profileDataDirectory,
  requestProfileSwitch,
  rollbackPendingProfile,
  validateProfileId
} from "../../runtime/src/profiles.js"

const mode = (filePath) => fs.statSync(filePath).mode & 0o777

function withProfileHomes(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-profiles-"))
  const names = [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "RECORDS_PROFILE_ID",
    "RECORDS_CONFIG_PATH",
    "RECORDS_DB_PATH"
  ]
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]])
  )
  Object.assign(process.env, {
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CACHE_HOME: path.join(directory, "cache")
  })
  for (const name of [
    "RECORDS_PROFILE_ID",
    "RECORDS_CONFIG_PATH",
    "RECORDS_DB_PATH"
  ]) {
    delete process.env[name]
  }
  return Promise.resolve()
    .then(() => run(directory))
    .finally(() => {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name]
        else process.env[name] = previous[name]
      }
      fs.rmSync(directory, { recursive: true, force: true })
    })
}

test("profile IDs and paths are isolated", () =>
  withProfileHomes(() => {
    for (const id of ["production", "demo", "work_2"]) {
      assert.equal(validateProfileId(id), id)
    }
    for (const id of ["", "Demo", "../demo", "a/b", "-demo"]) {
      assert.throws(() => validateProfileId(id), /Profile ID/)
    }
    assert.match(profileConfigDirectory("demo"), /profiles[/\\]demo$/)
    assert.match(profileDataDirectory("demo"), /profiles[/\\]demo$/)
    assert.match(profileCacheDirectory("demo"), /profiles[/\\]demo$/)
    assert.notEqual(
      profileDataDirectory("demo"),
      profileDataDirectory("production")
    )
  }))

test("managed profile startup rejects storage overrides", () =>
  withProfileHomes(() => {
    for (const name of ["RECORDS_CONFIG_PATH", "RECORDS_DB_PATH"]) {
      process.env[name] = "/tmp/not-profile-owned"
      assert.throws(() => assertManagedProfileEnvironment(), new RegExp(name))
      delete process.env[name]
    }
  }))

test("active and pending profile markers are private transactions", () =>
  withProfileHomes(() => {
    fs.mkdirSync(profileConfigDirectory("production"), { recursive: true })
    fs.writeFileSync(profileConfigPath("production"), "version: 1\n")
    fs.mkdirSync(profileConfigDirectory("demo"), { recursive: true })
    fs.writeFileSync(profileConfigPath("demo"), "version: 1\n")

    commitStartupProfile("production")
    assert.equal(activeProfileId(), "production")
    assert.equal(mode(activeProfilePath()), 0o600)
    assert.equal(mode(path.dirname(activeProfilePath())), 0o700)

    requestProfileSwitch("demo")
    assert.equal(fs.readFileSync(pendingProfilePath(), "utf8").trim(), "demo")
    assert.equal(activeProfileId(), "production")
    rollbackPendingProfile("demo")
    assert.equal(fs.existsSync(pendingProfilePath()), false)

    requestProfileSwitch("demo")
    commitStartupProfile("demo")
    assert.equal(activeProfileId(), "demo")
    assert.equal(fs.existsSync(pendingProfilePath()), false)
  }))

test("profile creation creates private data and empty media configuration", () =>
  withProfileHomes(async () => {
    const created = await createProfile({ name: "Demo Reel" })
    const dataDirectory = profileDataDirectory("demo-reel")
    assert.deepEqual(created, { id: "demo-reel", name: "Demo Reel" })
    assert.deepEqual(fs.readdirSync(dataDirectory), [])
    assert.equal(mode(dataDirectory), 0o700)
    const source = fs.readFileSync(profileConfigPath("demo-reel"), "utf8")
    assert.match(source, /version: 4/)
    assert.match(source, /roots: \[\]/)
    assert.match(source, /defaultRoot: null/)
    assert.doesNotMatch(source, /onboarding_completed/)
    assert.deepEqual(listProfiles(), [{ id: "demo-reel", name: "Demo Reel" }])
    await assert.rejects(createProfile({ name: "Demo Reel" }), /already exists/)
  }))

test("profile creation rejects names without a usable ID", () =>
  withProfileHomes(async () => {
    await assert.rejects(createProfile({ name: "!!!" }), /Profile ID/)
    assert.equal(fs.existsSync(profileConfigDirectory("production")), false)
  }))

test("concurrent profile creation cannot overwrite the winning profile", () =>
  withProfileHomes(async () => {
    const results = await Promise.allSettled([
      createProfile({ name: "Demo" }),
      createProfile({ name: "Demo" })
    ])
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1
    )
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1
    )
    assert.equal(fs.existsSync(profileConfigPath("demo")), true)
    assert.equal(listProfiles().length, 1)
  }))
