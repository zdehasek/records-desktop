import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
)
const tools = {
  exiftool: "/usr/bin/vendor_perl/exiftool",
  magick: "/usr/bin/magick",
  ffprobe: "/usr/bin/ffprobe",
  ffmpeg: "/usr/bin/ffmpeg"
}
const retiredMethods = [
  "messages:update",
  "attachments:list-scan-duplicates",
  "attachments:adopt-scan-duplicate-path",
  "attachments:remove-scan-duplicate",
  "attachments:list-duplicates",
  "attachments:get-duplicate-canonical",
  "attachments:confirm-duplicate-resolution"
]

function requireTools() {
  for (const [name, filePath] of Object.entries(tools)) {
    assert.ok(
      fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
      `Required real tool is missing: ${name} (${filePath})`
    )
    assert.doesNotThrow(
      () => fs.accessSync(filePath, fs.constants.X_OK),
      `Required real tool is not executable: ${name} (${filePath})`
    )
  }
}

function runTool(name, args) {
  const result = spawnSync(tools[name], args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000
  })
  assert.equal(
    result.error,
    undefined,
    `${tools[name]} could not run: ${result.error?.message}`
  )
  assert.equal(
    result.status,
    0,
    `${tools[name]} failed (${result.status}): ${result.stderr}`
  )
}

function isolatedEnvironment(directory) {
  const env = {
    ...process.env,
    HOME: path.join(directory, "home"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    PATH: `/usr/bin/vendor_perl:/usr/bin:/bin`,
    RECORDS_LOG_LEVEL: "warn"
  }
  for (const name of [
    "RECORDS_CONFIG_PATH",
    "RECORDS_DB_PATH",
    "RECORDS_PROFILE_ID",
    "RECORDS_PORT"
  ]) {
    delete env[name]
  }
  fs.mkdirSync(env.HOME, { recursive: true })
  return env
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/node",
      ["--no-warnings", "runtime/bootstrap.js"],
      {
        cwd: repositoryRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    let stdout = ""
    let stderr = ""
    let settled = false
    const timeout = setTimeout(() => {
      child.kill("SIGTERM")
      finish(new Error(`Server readiness timed out:\n${stderr}`))
    }, 30_000)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(value)
    }
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      const line = stdout
        .split("\n")
        .find((value) => value.startsWith("RECORDS_READY "))
      if (!line) return
      const ready = JSON.parse(line.slice("RECORDS_READY ".length))
      finish(null, { child, stderr: () => stderr, ...ready })
    })
    child.once("error", finish)
    child.once("exit", (code, signal) => {
      finish(
        new Error(
          `Server exited before readiness (${code ?? signal}):\n${stderr}`
        )
      )
    })
  })
}

async function stopServer(server) {
  const { child } = server
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once("exit", resolve))
  child.kill("SIGTERM")
  let timeout
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`Server shutdown timed out:\n${server.stderr()}`)),
          15_000
        )
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function rpc(server, method, ...args) {
  const response = await fetch(new URL("rpc", server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args })
  })
  const payload = await response.json()
  assert.equal(response.status, 200, `${method}: ${payload.error}`)
  return payload.result
}

async function waitFor(check, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Timed out waiting for condition")
}

async function rejectedRpc(server, method) {
  const response = await fetch(new URL("rpc", server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args: [] })
  })
  const payload = await response.json()
  assert.equal(response.status, 500, `${method} unexpectedly remained callable`)
  assert.match(payload.error, /^Unsupported method:/)
}

function authoritativeSnapshot(env) {
  const snapshot = {}
  const visit = (root, label, directory = root) => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(root, label, filePath)
      } else if (entry.isFile()) {
        const relative = path.relative(root, filePath).split(path.sep).join("/")
        snapshot[`${label}/${relative}`] = {
          bytes: fs.readFileSync(filePath).toString("base64"),
          mode: fs.statSync(filePath).mode & 0o7777
        }
      }
    }
  }
  visit(env.XDG_CONFIG_HOME, "config")
  visit(env.XDG_DATA_HOME, "data")
  return snapshot
}

function assertOnlyAttachmentTable(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.deepEqual(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all()
        .map((row) => row.name),
      ["attachments"]
    )
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
      3
    )
  } finally {
    database.close()
  }
}

function removeIndexFamily(databasePath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true })
  }
}

function writeLegacyIndex(databasePath) {
  removeIndexFamily(databasePath)
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      PRAGMA application_id = 1380270916;
      PRAGMA user_version = 1;
      CREATE TABLE diary_days(id INTEGER PRIMARY KEY, date TEXT NOT NULL);
      CREATE TABLE diary_messages(
        id INTEGER PRIMARY KEY,
        day_id INTEGER NOT NULL,
        content TEXT
      );
      CREATE TABLE attachments(
        id INTEGER PRIMARY KEY,
        message_id INTEGER,
        file_path TEXT
      );
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO diary_days VALUES(1, '1999-01-01');
      INSERT INTO diary_messages VALUES(1, 1, 'legacy cache data');
      INSERT INTO attachments VALUES(1, 1, '/tmp/legacy.jpg');
      INSERT INTO settings VALUES('legacy', 'true');
      INSERT INTO tags VALUES(1, 'retired');
    `)
  } finally {
    database.close()
  }
}

function writeVersionTwoIndex(databasePath) {
  removeIndexFamily(databasePath)
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      PRAGMA application_id = 1380270916;
      PRAGMA user_version = 2;
      CREATE TABLE attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK(
          mime_type GLOB 'image/?*' OR
          mime_type GLOB 'audio/?*' OR
          mime_type GLOB 'video/?*'
        ),
        byte_size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        duration_seconds REAL,
        important INTEGER NOT NULL DEFAULT 0,
        note_color TEXT,
        transcript_status TEXT,
        content_fingerprint TEXT,
        exif_data TEXT,
        source_revision TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(root_name, relative_path)
      );
      INSERT INTO attachments
        (root_name, relative_path, mime_type, byte_size, mtime_ms,
         transcript_status, created_at)
      VALUES ('records', 'legacy-audio.mp3', 'audio/mpeg', 99, 1,
              'done', '1999-01-01T00:00:00Z');
    `)
  } finally {
    database.close()
  }
}

function assertDurableMedia(rows) {
  assert.equal(rows.length, 3)
  const byPath = new Map(rows.map((row) => [row.relative_path, row]))
  const photo = byPath.get("authority-photo.jpg")
  const duplicate = byPath.get("authority-photo-copy.jpg")
  const video = byPath.get("authority-video.mp4")
  assert.ok(photo)
  assert.ok(duplicate)
  assert.ok(video)

  assert.equal(photo.message_content, "Durable photo caption")
  assert.equal(photo.metadata.important, true)
  assert.equal(photo.metadata.note_style.color, "lavender")
  assert.equal(photo.created_at, "2026-02-03T04:05:06+02:00")
  assert.equal(photo.exif_data.Make, "Authority Camera Co")
  assert.equal(photo.exif_data.Model, "Lifecycle One")
  assert.ok(Math.abs(photo.latitude - 50.087) < 0.000001)
  assert.ok(Math.abs(photo.longitude - 14.421) < 0.000001)

  assert.equal(video.message_content, "Durable video note\n")
  assert.equal(video.metadata.important, true)
  assert.equal(video.metadata.note_style.color, "sky")
  assert.equal(video.created_at, "2025-11-12T13:14:15.000Z")
  assert.ok(video.metadata.duration_seconds > 0)
  assert.equal(video.mime_type, "video/mp4")
  assert.equal(photo.content_fingerprint, duplicate.content_fingerprint)
}

async function assertReconstructed(server, paths, expectedAuthority) {
  const rows = await waitFor(async () => {
    const attachments = await rpc(server, "attachments:list-all", {})
    return attachments.length === 3 ? attachments : null
  })
  assertDurableMedia(rows)
  assertOnlyAttachmentTable(paths.database)

  assert.equal((await rpc(server, "settings:all")).week_start_day, "monday")
  const [duplicates] = await rpc(server, "attachments:list-duplicate-groups")
  assert.ok(duplicates)
  assert.equal(duplicates.members.length, 2)
  assert.equal(duplicates.canonical.path, "authority-photo.jpg")
  for (const method of retiredMethods) await rejectedRpc(server, method)
  assert.deepEqual(authoritativeSnapshot(paths.env), expectedAuthority)
}

test(
  "authoritative files reconstruct every disposable index lifecycle",
  { timeout: 180_000 },
  async (context) => {
    requireTools()
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "records-authority-lifecycle-")
    )
    const env = isolatedEnvironment(directory)
    const profileData = path.join(
      env.XDG_DATA_HOME,
      "records",
      "profiles",
      "production"
    )
    const media = path.join(profileData, "media")
    const profileConfig = path.join(
      env.XDG_CONFIG_HOME,
      "records",
      "profiles",
      "production"
    )
    const cache = path.join(
      env.XDG_CACHE_HOME,
      "records",
      "profiles",
      "production"
    )
    const paths = {
      env,
      database: path.join(cache, "index.sqlite3"),
      photo: path.join(media, "authority-photo.jpg"),
      duplicatePhoto: path.join(media, "authority-photo-copy.jpg"),
      video: path.join(media, "authority-video.mp4"),
      legacyJournal: path.join(profileData, "journal", "1999-01-01.md"),
      legacyAudio: path.join(profileData, "audio", "legacy-recording.mp3"),
      config: path.join(profileConfig, "config.yaml")
    }
    let running = null
    context.after(async () => {
      if (running) await stopServer(running).catch(() => {})
      fs.rmSync(directory, { recursive: true, force: true })
    })

    for (const target of [media, profileConfig]) {
      fs.mkdirSync(target, { recursive: true })
    }
    fs.writeFileSync(
      paths.config,
      `# authority config comment
version: 4
profile:
  name: Production
media:
  roots:
    - name: records
      path: ${JSON.stringify(media)}
      enabled: true
  defaultRoot: records
preferences: {}
`
    )
    fs.chmodSync(paths.config, 0o640)

    runTool("magick", [
      "-size",
      "32x24",
      "gradient:#24506f-#e8c07d",
      paths.photo
    ])
    fs.copyFileSync(paths.photo, paths.duplicatePhoto)
    fs.mkdirSync(path.dirname(paths.legacyJournal), { recursive: true })
    fs.mkdirSync(path.dirname(paths.legacyAudio), { recursive: true })
    fs.writeFileSync(paths.legacyJournal, "# Legacy journal\n\nDo not touch.\n")
    fs.writeFileSync(
      paths.legacyAudio,
      Buffer.from([0x49, 0x44, 0x33, 1, 2, 3])
    )
    runTool("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=#354052:s=32x24:r=10:d=0.6",
      "-c:v",
      "mpeg4",
      "-metadata",
      "creation_time=2024-01-02T03:04:05.000Z",
      paths.video
    ])
    runTool("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration",
      paths.video
    ])
    const fixtureTime = new Date("2024-01-02T03:04:05.000Z")
    for (const filePath of [paths.photo, paths.duplicatePhoto, paths.video]) {
      fs.utimesSync(filePath, fixtureTime, fixtureTime)
      fs.chmodSync(filePath, 0o640)
    }

    running = await startServer(env)
    assert.deepEqual(running.profile, { id: "production", name: "Production" })
    const initialRows = await waitFor(async () => {
      const attachments = await rpc(running, "attachments:list-all", {})
      return attachments.length === 3 ? attachments : null
    })
    assert.equal(initialRows.length, 3)
    const initialByPath = new Map(
      initialRows.map((row) => [row.relative_path, row])
    )
    await rpc(
      running,
      "attachments:update",
      initialByPath.get("authority-photo.jpg").id,
      {
        content: "Durable photo caption",
        important: true,
        noteColor: "lavender",
        createdAt: "2026-02-03T04:05:06+02:00",
        Make: "Authority Camera Co",
        Model: "Lifecycle One",
        latitude: 50.087,
        longitude: 14.421
      }
    )
    await rpc(
      running,
      "attachments:update",
      initialByPath.get("authority-video.mp4").id,
      {
        content: "Durable video note",
        important: true,
        noteColor: "sky",
        createdAt: "2025-11-12T13:14:15.000Z"
      }
    )
    await rpc(running, "settings:set", "week_start_day", "monday")

    const videoId = initialByPath.get("authority-video.mp4").id
    const videoResponse = await fetch(new URL(`media/${videoId}`, running.url))
    assert.equal(videoResponse.status, 200)
    assert.equal(videoResponse.headers.get("content-type"), "video/mp4")
    assert.equal(
      videoResponse.headers.get("cache-control"),
      "private, no-store"
    )
    assert.ok((await videoResponse.arrayBuffer()).byteLength > 0)
    const streamResponse = await fetch(
      new URL(`media/${videoId}`, running.url),
      {
        headers: { Range: "bytes=0-31" }
      }
    )
    assert.equal(streamResponse.status, 206)
    assert.equal(streamResponse.headers.get("content-type"), "video/mp4")
    assert.equal(
      streamResponse.headers.get("cache-control"),
      "private, no-store"
    )
    assert.match(streamResponse.headers.get("content-range"), /^bytes 0-31\//)
    assert.equal((await streamResponse.arrayBuffer()).byteLength, 32)

    let [duplicateGroup] = await rpc(
      running,
      "attachments:list-duplicate-groups"
    )
    assert.equal(duplicateGroup.members.length, 2)
    const copiedMember = duplicateGroup.members.find(
      (member) => member.path === "authority-photo-copy.jpg"
    )
    await rpc(
      running,
      "attachments:set-duplicate-canonical",
      duplicateGroup.checksum,
      copiedMember.attachmentId
    )
    const duplicatePath = path.join(
      profileData,
      "duplicates",
      `${duplicateGroup.checksum}.yaml`
    )
    const duplicateSource = fs.readFileSync(duplicatePath, "utf8")
    fs.writeFileSync(
      duplicatePath,
      duplicateSource.replace(
        "canonical:",
        "# duplicate authority comment\nfuture_duplicate:\n  nested:\n    value: keep # unknown duplicate value\ncanonical:"
      )
    )
    duplicateGroup = (
      await rpc(running, "attachments:list-duplicate-groups")
    )[0]
    const originalMember = duplicateGroup.members.find(
      (member) => member.path === "authority-photo.jpg"
    )
    await rpc(
      running,
      "attachments:set-duplicate-canonical",
      duplicateGroup.checksum,
      originalMember.attachmentId
    )
    assert.match(
      fs.readFileSync(duplicatePath, "utf8"),
      /# duplicate authority comment/
    )
    assert.match(
      fs.readFileSync(duplicatePath, "utf8"),
      /value: keep # unknown duplicate value/
    )

    await rpc(running, "map-tiles:put", 1, 1, 1, [1, 2, 3, 4])
    const warmup = await rpc(running, "thumbnails:warmup")
    assert.equal(warmup.done, 3)
    assert.equal(fs.existsSync(path.join(cache, "map-tiles.sqlite3")), true)
    assert.equal(
      fs.existsSync(path.join(cache, "thumbnails", "thumbnails.sqlite3")),
      true
    )

    fs.chmodSync(duplicatePath, 0o640)
    await stopServer(running)
    running = null
    const authority = authoritativeSnapshot(env)
    assert.ok(Object.keys(authority).length >= 6)

    fs.rmSync(path.join(cache, "map-tiles.sqlite3"), { force: true })
    fs.rmSync(path.join(cache, "thumbnails"), {
      recursive: true,
      force: true
    })
    running = await startServer(env)
    await assertReconstructed(running, paths, authority)
    assert.equal(await rpc(running, "map-tiles:get", 1, 1, 1), null)
    assert.equal((await rpc(running, "thumbnails:warmup")).done, 3)
    await stopServer(running)
    running = null
    assert.deepEqual(authoritativeSnapshot(env), authority)

    const scenarios = [
      {
        name: "deleted index family",
        damage() {
          removeIndexFamily(paths.database)
        }
      },
      {
        name: "corrupt index replacement",
        damage() {
          removeIndexFamily(paths.database)
          fs.writeFileSync(paths.database, "not a sqlite database\n")
        }
      },
      {
        name: "legacy multi-table replacement",
        damage() {
          writeLegacyIndex(paths.database)
        }
      },
      {
        name: "version two attachment replacement",
        damage() {
          writeVersionTwoIndex(paths.database)
        }
      }
    ]

    for (const scenario of scenarios) {
      scenario.damage()
      running = await startServer(env)
      await assertReconstructed(running, paths, authority)
      await scenario.extra?.(running)
      assert.deepEqual(
        authoritativeSnapshot(env),
        authority,
        `${scenario.name} changed authoritative files`
      )
      await stopServer(running)
      running = null

      running = await startServer(env)
      await assertReconstructed(running, paths, authority)
      await stopServer(running)
      running = null
      assert.deepEqual(
        authoritativeSnapshot(env),
        authority,
        `${scenario.name} clean restart changed authoritative files`
      )
    }
  }
)
