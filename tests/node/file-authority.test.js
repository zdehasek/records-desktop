import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  defaultConfigPath,
  openRecordsConfig,
  RecordsConfig
} from "../../runtime/src/services/config-store.js"
import {
  fileIdentity,
  normalizeRelativePath,
  resolveRootPath,
  validateRootName,
  validateRoots
} from "../../runtime/src/file-roots.js"
import {
  DuplicateStore,
  defaultDuplicatesDirectory
} from "../../runtime/src/services/duplicate-store.js"
import { defaultDatabasePath } from "../../runtime/database.js"
import { createSystemTrash } from "../../runtime/src/services/system-trash.js"
import {
  moveVisibility,
  parseVisibilityPath,
  validateCategory
} from "../../runtime/src/services/visibility-path.js"
import { companionPath } from "../../runtime/src/services/media-companion.js"
import {
  cleanupImportDirectories,
  deleteOwnedMedia,
  prepareImportDestination
} from "../../runtime/src/services/media-destination.js"

test("Records YAML config retains comments across owned mutations", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-config-test-")
  )
  const configPath = path.join(directory, "config", "config.yaml")
  fs.mkdirSync(path.dirname(configPath))
  fs.writeFileSync(
    configPath,
    `# keep this comment\nversion: 4\nmedia:\n  roots: []\n  defaultRoot: null\npreferences: {}\n`
  )
  try {
    const config = openRecordsConfig(configPath)
    const watched = path.join(directory, "watched")
    fs.mkdirSync(watched)
    const entry = config.addMediaRoot(watched)
    config.setSetting("week_start_day", "sunday")
    config.setSetting("auto_photo_in_week_overview", "true")

    const reloaded = new RecordsConfig(configPath)
    reloaded.load()
    assert.equal(entry.name, "watched")
    assert.equal(reloaded.mediaRoots()[0].path, watched)
    assert.equal(reloaded.defaultMediaRoot().name, "watched")
    assert.equal(reloaded.getSetting("week_start_day"), "sunday")
    assert.equal(reloaded.getSetting("auto_photo_in_week_overview"), "true")
    const contents = fs.readFileSync(configPath, "utf8")
    assert.match(contents, /# keep this comment/)
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("root list mutations preserve surviving YAML nodes", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-config-roots-")
  )
  const configPath = path.join(directory, "config.yaml")
  const watchedOne = path.join(directory, "watched-one")
  const watchedTwo = path.join(directory, "watched-two")
  const watchedThree = path.join(directory, "watched-three")
  fs.mkdirSync(watchedOne)
  fs.mkdirSync(watchedTwo)
  fs.mkdirSync(watchedThree)
  fs.writeFileSync(
    configPath,
    `# exact top comment
version: 4
media:
  roots:
    - name: watched-one # watched one name
      path: ${directory}/watched-shadow/../watched-one # watched one path
      enabled: true # watched one enabled
    - name: watched-two # watched two name
      path: ${watchedTwo} # watched two path
      enabled: true # watched two enabled
  defaultRoot: watched-one
preferences: {}
`
  )
  try {
    const config = openRecordsConfig(configPath)

    config.addMediaRoot(watchedThree)
    config.setDefaultMediaRoot(watchedThree)
    config.toggleMediaRoot(watchedOne, false)
    config.removeMediaRoot(watchedTwo)

    assert.deepEqual(
      config.mediaRoots().map(({ name, path: rootPath, enabled }) => ({
        name,
        path: rootPath,
        enabled
      })),
      [
        { name: "watched-one", path: watchedOne, enabled: false },
        { name: "watched-three", path: watchedThree, enabled: true }
      ]
    )

    const contents = fs.readFileSync(configPath, "utf8")
    for (const exact of [
      "# exact top comment",
      `    - name: watched-one # watched one name
      path: ${watchedOne} # watched one path
      enabled: false # watched one enabled`
    ]) {
      assert.equal(contents.includes(exact), true, exact)
    }
    assert.ok(contents.indexOf(watchedOne) < contents.indexOf(watchedThree))

    assert.throws(
      () =>
        config.setRootNodes(
          ["media", "roots"],
          [
            { name: "duplicate", path: watchedOne, enabled: true },
            { name: "duplicate", path: watchedThree, enabled: true }
          ]
        ),
      /duplicate media root name/
    )
    assert.equal(fs.readFileSync(configPath, "utf8"), contents)
    assert.equal(config.mediaRoots()[0].name, "watched-one")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("failed config saves restore the persisted in-memory document", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-config-rollback-")
  )
  const configPath = path.join(directory, "config.yaml")
  fs.writeFileSync(
    configPath,
    `version: 4\nmedia:\n  roots: []\n  defaultRoot: null\npreferences:\n  week_start_day: monday\n`
  )
  try {
    const config = openRecordsConfig(configPath)
    config.document.setIn(["preferences", "week_start_day"], "sunday")
    const blocker = path.join(directory, "not-a-directory")
    fs.writeFileSync(blocker, "block")
    config.filePath = path.join(blocker, "config.yaml")
    assert.throws(() => config.save())
    config.filePath = configPath
    assert.equal(config.document.getIn(["version"]), 4)
    assert.equal(config.getSetting("week_start_day"), "monday")
    assert.equal(
      config.document.getIn(["preferences", "week_start_day"]),
      "monday"
    )
    assert.match(fs.readFileSync(configPath, "utf8"), /version: 4/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("invalid Records config throws without overwriting the source", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-invalid-"))
  try {
    for (const [name, invalid] of [
      ["malformed", "version: [unterminated\n"],
      ["invalid", "version: 4\n"],
      ["old-version", "version: 1\n"],
      [
        "version-two",
        `version: 3\nrecordsFolder: ${directory}\nmedia:\n  watchedRoots: []\npreferences: {}\n`
      ],
      [
        "obsolete-field",
        `version: 4\nmedia:\n  roots: []\n  defaultRoot: null\npreferences:\n  transcription_enabled: true\n`
      ],
      [
        "obsolete-journal",
        `version: 4\nmedia:\n  roots: []\n  defaultRoot: null\npreferences: {}\njournal:\n  roots: []\n`
      ],
      [
        "unknown-media",
        `version: 4\nmedia:\n  roots: []\n  defaultRoot: null\n  fallback: true\npreferences: {}\n`
      ],
      [
        "unknown-root",
        `version: 4\nmedia:\n  roots:\n    - name: camera\n      path: ${directory}/camera\n      enabled: true\n      legacy: true\n  defaultRoot: camera\npreferences: {}\n`
      ]
    ]) {
      const configPath = path.join(directory, `${name}.yaml`)
      fs.writeFileSync(configPath, invalid)
      assert.throws(() => openRecordsConfig(configPath))
      assert.equal(fs.readFileSync(configPath, "utf8"), invalid)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("config loading rejects symlinked files without mutating their targets", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-config-link-")
  )
  const target = path.join(directory, "outside.yaml")
  const configPath = path.join(directory, "config.yaml")
  const source = `version: 4\nmedia:\n  roots: []\n  defaultRoot: null\npreferences: {}\n`
  fs.writeFileSync(target, source, { mode: 0o644 })
  fs.symlinkSync(target, configPath)
  try {
    assert.throws(() => openRecordsConfig(configPath), /ordinary file/)
    assert.equal(fs.readFileSync(target, "utf8"), source)
    assert.equal(fs.statSync(target).mode & 0o777, 0o644)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("root primitives reject unsafe names, traversal, overlap, and symlink escape", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-roots-"))
  const rootPath = path.join(directory, "root")
  const outside = path.join(directory, "outside")
  fs.mkdirSync(rootPath)
  fs.mkdirSync(outside)
  fs.symlinkSync(rootPath, path.join(directory, "root-link"))
  fs.symlinkSync(outside, path.join(rootPath, "escape"))
  try {
    assert.equal(validateRootName("camera_roll-2"), "camera_roll-2")
    assert.throws(() => validateRootName("Camera Roll"), /invalid root name/)
    assert.equal(
      normalizeRelativePath("2026\\09//photo.jpg"),
      "2026/09/photo.jpg"
    )
    assert.throws(() => normalizeRelativePath("../photo.jpg"), /traverse/)
    assert.throws(() => normalizeRelativePath("/tmp/photo.jpg"), /absolute/)
    assert.equal(
      fileIdentity({ root: "records", path: "./2026/photo.jpg" }),
      "records:2026/photo.jpg"
    )
    assert.throws(
      () =>
        validateRoots([
          { name: "one", path: rootPath },
          { name: "two", path: path.join(rootPath, "nested") }
        ]),
      /overlapping/
    )
    assert.throws(
      () =>
        validateRoots([
          { name: "same", path: rootPath },
          { name: "same", path: outside }
        ]),
      /duplicate root name/
    )
    assert.throws(
      () =>
        validateRoots([
          { name: "one", path: rootPath },
          { name: "alias", path: path.join(directory, "root-link") }
        ]),
      /overlapping/
    )
    assert.throws(
      () =>
        resolveRootPath({ name: "records", path: rootPath }, "escape/file.jpg"),
      /unsafe root resolution/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("media roots enforce a usable default", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-relocate-"))
  const previousDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = path.join(directory, "data-home")
  try {
    const config = openRecordsConfig(
      path.join(directory, "config", "config.yaml")
    )
    const watched = path.join(directory, "camera-roll")
    const other = path.join(directory, "other")
    fs.mkdirSync(watched)
    fs.mkdirSync(other)
    config.addMediaRoot(watched)
    config.addMediaRoot(other)
    assert.equal(config.defaultMediaRoot().path, watched)
    assert.throws(() => config.removeMediaRoot(watched), /another default/)
    assert.throws(
      () => config.toggleMediaRoot(watched, false),
      /another default/
    )
    config.setDefaultMediaRoot(other)
    config.removeMediaRoot(watched)

    const reloaded = new RecordsConfig(
      path.join(directory, "config", "config.yaml")
    )
    reloaded.load()
    assert.equal(reloaded.defaultMediaRoot().path, other)
    assert.deepEqual(
      reloaded.mediaRoots().map((root) => root.path),
      [other]
    )
    assert.equal(reloaded.removeMediaRoot(other), true)
    assert.deepEqual(reloaded.mediaRoots(), [])
    assert.equal(reloaded.defaultMediaRoot(), null)
  } finally {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("owned media deletion is confined to ordinary files below its root", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-owned-"))
  const root = path.join(directory, "records")
  fs.mkdirSync(root)
  const file = path.join(root, "photo.jpg")
  fs.writeFileSync(file, "photo")
  try {
    assert.equal(
      deleteOwnedMedia({ file_path: file, root_path: root }, root),
      true
    )
    assert.equal(
      deleteOwnedMedia({ file_path: file, root_path: root }, root),
      false
    )
    assert.equal(deleteOwnedMedia(null, root), false)
    assert.equal(
      deleteOwnedMedia({ file_path: path.join(directory, "outside") }, root),
      false
    )
    assert.equal(
      deleteOwnedMedia({ file_path: file, root_path: "relative" }, root),
      false
    )
    const destination = prepareImportDestination(root)
    assert.equal(destination.root, root)
    assert.equal(fs.statSync(path.join(root, "records")).isDirectory(), true)
    cleanupImportDirectories(destination.created)
    assert.throws(() => prepareImportDestination("relative"), /absolute path/)
    assert.throws(
      () => prepareImportDestination(path.join(directory, "missing")),
      /exist and be writable/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("owned media deletion rejects links, directories, and unsafe roots", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-owned-unsafe-")
  )
  const root = path.join(directory, "root")
  const outside = path.join(directory, "outside.jpg")
  fs.mkdirSync(root)
  fs.writeFileSync(outside, "outside")
  const link = path.join(root, "link.jpg")
  fs.symlinkSync(outside, link)
  try {
    assert.equal(
      deleteOwnedMedia({ file_path: link, root_path: root }, root),
      false
    )
    assert.equal(
      deleteOwnedMedia({ file_path: root, root_path: directory }, directory),
      false
    )
    assert.equal(
      deleteOwnedMedia(
        { file_path: outside, root_path: path.parse(root).root },
        root
      ),
      false
    )
    assert.throws(
      () => prepareImportDestination(outside),
      /must be an ordinary directory/
    )
    assert.throws(
      () => prepareImportDestination(path.parse(root).root),
      /filesystem root/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("XDG defaults separate config, durable data, and cache", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-xdg-"))
  const previous = {
    config: process.env.XDG_CONFIG_HOME,
    data: process.env.XDG_DATA_HOME,
    cache: process.env.XDG_CACHE_HOME,
    configOverride: process.env.RECORDS_CONFIG_PATH,
    dbOverride: process.env.RECORDS_DB_PATH
  }
  Object.assign(process.env, {
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    RECORDS_CONFIG_PATH: "",
    RECORDS_DB_PATH: ""
  })
  try {
    assert.equal(
      defaultConfigPath(),
      path.join(
        directory,
        "config",
        "records",
        "profiles",
        "production",
        "config.yaml"
      )
    )
    assert.equal(
      defaultDatabasePath(),
      path.join(
        directory,
        "cache",
        "records",
        "profiles",
        "production",
        "index.sqlite3"
      )
    )
    assert.equal(
      defaultDuplicatesDirectory(),
      path.join(
        directory,
        "data",
        "records",
        "profiles",
        "production",
        "duplicates"
      )
    )
    const config = openRecordsConfig()
    assert.deepEqual(config.mediaRoots(), [])
    assert.equal(config.defaultMediaRoot(), null)
  } finally {
    for (const [key, value] of [
      ["XDG_CONFIG_HOME", previous.config],
      ["XDG_DATA_HOME", previous.data],
      ["XDG_CACHE_HOME", previous.cache],
      ["RECORDS_CONFIG_PATH", previous.configOverride],
      ["RECORDS_DB_PATH", previous.dbOverride]
    ]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("duplicate YAML store persists canonical references and retains metadata", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-dupes-"))
  const store = new DuplicateStore(path.join(directory, "duplicates"))
  const fingerprint = "abc123"
  try {
    store.write(fingerprint, {
      canonical: { root: "records", path: "2026/one.jpg" },
      duplicates: [{ root: "offline", path: "camera/two.jpg" }],
      future: "keep-me"
    })
    const filePath = store.filePath(fingerprint)
    const original = fs.readFileSync(filePath, "utf8")
    fs.writeFileSync(filePath, `# duplicate comment\n${original}`)
    store.write(fingerprint, {
      canonical: { root: "records", path: "2026/three.jpg" },
      duplicates: [{ root: "offline", path: "camera/two.jpg" }]
    })
    assert.deepEqual(store.read(fingerprint).canonical, {
      root: "records",
      path: "2026/three.jpg"
    })
    assert.equal(store.read(fingerprint).future, "keep-me")
    assert.equal(store.list().length, 1)
    const contents = fs.readFileSync(filePath, "utf8")
    assert.match(contents, /# duplicate comment/)
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
    assert.throws(() => store.filePath("../escape"), /fingerprint/)
    assert.throws(
      () =>
        store.write("safe", {
          canonical: { root: "Bad Root", path: "../escape" }
        }),
      /root name/
    )
    assert.throws(
      () =>
        store.write("safe", {
          canonical: { root: "records", path: "../escape" }
        }),
      /traverse/
    )
    assert.equal(store.delete(fingerprint), true)
    assert.equal(store.read(fingerprint), null)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("duplicate YAML updates preserve nested metadata and comments while selecting a canonical", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-dupes-metadata-")
  )
  const store = new DuplicateStore(path.join(directory, "duplicates"))
  const filePath = store.filePath("metadata")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    `# top comment
version: 1
fingerprint: metadata
future:
  enabled: true # top-level unknown
canonical:
  root: records # original root
  path: old/original.jpg
  details:
    label: original # canonical nested
duplicates:
  - root: camera # selected root
    path: roll/selected.jpg
    details:
      label: selected # selected nested
  - root: archive
    path: saved/survivor.jpg # survivor path
    details:
      label: survivor # survivor nested
`
  )
  try {
    store.write("metadata", {
      canonical: { root: "camera", path: "roll/selected.jpg" },
      duplicates: [
        { root: "archive", path: "saved/survivor.jpg" },
        { root: "records", path: "old/original.jpg" }
      ]
    })

    assert.deepEqual(store.read("metadata").canonical, {
      root: "camera",
      path: "roll/selected.jpg"
    })
    const contents = fs.readFileSync(filePath, "utf8")
    for (const preserved of [
      "# top comment",
      "enabled: true # top-level unknown",
      "root: camera # selected root",
      "label: selected # selected nested",
      "path: saved/survivor.jpg # survivor path",
      "label: survivor # survivor nested",
      "root: records # original root",
      "label: original # canonical nested"
    ]) {
      assert.match(
        contents,
        new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      )
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("duplicate YAML sequence growth, reordering, and shrinkage preserve surviving nodes", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-dupes-sequence-")
  )
  const store = new DuplicateStore(path.join(directory, "duplicates"))
  const filePath = store.filePath("sequence")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    `version: 1
fingerprint: sequence
canonical:
  root: records
  path: canonical.jpg
duplicates:
  - root: camera
    path: first.jpg
    future: first # first survives reorder only
  - root: archive
    path: second.jpg
    future: second # second survives shrink
`
  )
  try {
    store.write("sequence", {
      canonical: { root: "records", path: "canonical.jpg" },
      duplicates: [
        { root: "archive", path: "second.jpg" },
        { root: "import", path: "new.jpg" },
        { root: "camera", path: "first.jpg" }
      ]
    })
    assert.deepEqual(store.read("sequence").duplicates, [
      { root: "archive", path: "second.jpg" },
      { root: "import", path: "new.jpg" },
      { root: "camera", path: "first.jpg" }
    ])
    let contents = fs.readFileSync(filePath, "utf8")
    assert.match(contents, /future: first # first survives reorder only/)
    assert.match(contents, /future: second # second survives shrink/)

    store.write("sequence", {
      canonical: { root: "archive", path: "second.jpg" },
      duplicates: [{ root: "import", path: "new.jpg" }]
    })
    assert.deepEqual(store.read("sequence").canonical, {
      root: "archive",
      path: "second.jpg"
    })
    assert.deepEqual(store.read("sequence").duplicates, [
      { root: "import", path: "new.jpg" }
    ])
    contents = fs.readFileSync(filePath, "utf8")
    assert.match(contents, /future: second # second survives shrink/)
    assert.doesNotMatch(contents, /first survives reorder only/)
    assert.doesNotMatch(contents, /canonical\.jpg/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("visibility paths preserve original subpaths and move companions", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-visibility-")
  )
  const source = path.join(directory, "year", "clip.webm")
  fs.mkdirSync(path.dirname(source))
  fs.writeFileSync(source, "media")
  fs.writeFileSync(companionPath(source), "companion")
  try {
    assert.deepEqual(parseVisibilityPath(".nsfw/travel/year/clip.webm"), {
      category: "travel",
      originalPath: "year/clip.webm",
      relativePath: ".nsfw/travel/year/clip.webm",
      visibility: "travel"
    })
    assert.throws(() => validateCategory("../bad"), /safe single/)
    const hidden = moveVisibility({
      root: { name: "records", path: directory },
      relativePath: "year/clip.webm",
      visibility: "hidden",
      category: "private"
    })
    assert.equal(hidden, ".hidden/private/year/clip.webm")
    assert.equal(fs.existsSync(path.join(directory, hidden)), true)
    assert.equal(
      fs.existsSync(companionPath(path.join(directory, hidden))),
      true
    )
    fs.mkdirSync(path.join(directory, "year"), { recursive: true })
    fs.writeFileSync(source, "collision")
    assert.throws(
      () =>
        moveVisibility({
          root: { name: "records", path: directory },
          relativePath: hidden,
          visibility: "visible"
        }),
      /destination exists/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("visibility moves restore duplicate YAML after a later write fails", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-visibility-rollback-")
  )
  const duplicateDirectory = path.join(directory, "duplicates")
  const store = new DuplicateStore(duplicateDirectory)
  const rootPath = path.join(directory, "media")
  const source = path.join(rootPath, "year", "clip.webm")
  const target = path.join(rootPath, ".hidden", "private", "year", "clip.webm")
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, "media")
  fs.writeFileSync(companionPath(source), "companion")
  store.write("first", {
    canonical: { root: "records", path: "year/clip.webm" },
    duplicates: [{ root: "camera", path: "other.webm" }],
    future: { keep: "first" }
  })
  store.write("second", {
    canonical: { root: "camera", path: "other.webm" },
    duplicates: [{ root: "records", path: "year/clip.webm" }],
    future: { keep: "second" }
  })
  const firstPath = store.filePath("first")
  const secondPath = store.filePath("second")
  fs.writeFileSync(firstPath, `# first comment\n${fs.readFileSync(firstPath)}`)
  fs.writeFileSync(
    secondPath,
    `# second comment\n${fs.readFileSync(secondPath)}`
  )
  fs.chmodSync(firstPath, 0o640)
  fs.chmodSync(secondPath, 0o604)
  const snapshots = [firstPath, secondPath].map((filePath) => ({
    contents: fs.readFileSync(filePath),
    filePath,
    mode: fs.statSync(filePath).mode & 0o7777
  }))
  const renameSync = fs.renameSync
  const writeError = new Error("second duplicate write failed")
  let duplicateWrites = 0
  fs.renameSync = (from, to) => {
    if (path.basename(from).startsWith(".duplicate-") && to.endsWith(".yaml")) {
      duplicateWrites += 1
      if (duplicateWrites === 2) throw writeError
    }
    return renameSync(from, to)
  }
  try {
    assert.throws(
      () =>
        moveVisibility({
          root: { name: "records", path: rootPath },
          relativePath: "year/clip.webm",
          visibility: "hidden",
          category: "private",
          duplicateStore: store
        }),
      (error) => {
        assert.equal(error, writeError)
        return true
      }
    )
  } finally {
    fs.renameSync = renameSync
  }
  try {
    assert.equal(fs.existsSync(source), true)
    assert.equal(fs.existsSync(target), false)
    assert.equal(fs.existsSync(companionPath(source)), true)
    assert.equal(fs.existsSync(companionPath(target)), false)
    for (const snapshot of snapshots) {
      assert.deepEqual(fs.readFileSync(snapshot.filePath), snapshot.contents)
      assert.equal(fs.statSync(snapshot.filePath).mode & 0o7777, snapshot.mode)
    }
    assert.deepEqual(
      fs
        .readdirSync(duplicateDirectory)
        .filter((name) => name.endsWith(".tmp")),
      []
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("system Trash is move-only and rejects unavailable or ineffective backends", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-trash-"))
  const filePath = path.join(directory, "photo.jpg")
  fs.writeFileSync(filePath, "photo")
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  await assert.rejects(createSystemTrash(null).move(filePath), /Install glib2/)
  await assert.rejects(
    createSystemTrash("gio", { run: async () => ({}) }).move(filePath),
    /did not remove/
  )
  const trash = createSystemTrash("gio", {
    run: async (_gio, args) => fs.rmSync(args[1])
  })
  assert.equal(await trash.move(filePath), true)
})
