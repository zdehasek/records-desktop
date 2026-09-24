import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
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

function startServer(databasePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", "runtime/server.js"],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          RECORDS_DB_PATH: databasePath,
          XDG_CACHE_HOME: path.dirname(databasePath),
          XDG_CONFIG_HOME: path.dirname(databasePath),
          XDG_DATA_HOME: path.dirname(databasePath),
          RECORDS_CONFIG_PATH: path.join(
            path.dirname(databasePath),
            "config.yaml"
          )
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.once("exit", (code) => {
      reject(new Error(`Server exited with ${code}: ${stderr}`))
    })
    let stdout = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
      const line = stdout
        .split("\n")
        .find((value) => value.startsWith("RECORDS_READY "))
      if (!line) return
      const message = JSON.parse(line.slice("RECORDS_READY ".length))
      resolve({ child, url: message.url })
    })
  })
}

function startProfileServer(directory, profileId) {
  const configHome = path.join(directory, "config")
  fs.mkdirSync(path.join(configHome, "records"), { recursive: true })
  if (profileId) {
    fs.writeFileSync(
      path.join(configHome, "records", "active-profile"),
      `${profileId}\n`
    )
  }
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CACHE_HOME: path.join(directory, "cache")
  }
  for (const name of [
    "RECORDS_CONFIG_PATH",
    "RECORDS_DB_PATH",
    "RECORDS_PROFILE_ID"
  ]) {
    delete env[name]
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", "runtime/bootstrap.js"],
      { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"] }
    )
    let stderr = ""
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.once("exit", (code) =>
      reject(new Error(`Server exited with ${code}: ${stderr}`))
    )
    child.stdout.on("data", (chunk) => {
      const line = String(chunk)
        .split("\n")
        .find((value) => value.startsWith("RECORDS_READY "))
      if (!line) return
      const ready = JSON.parse(line.slice("RECORDS_READY ".length))
      resolve({ child, ...ready })
    })
  })
}

async function stopServer(child) {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => child.once("exit", resolve))
}

async function call(url, method, ...args) {
  const response = await fetch(new URL("rpc", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args })
  })
  const payload = await response.json()
  assert.equal(response.status, 200, payload.error)
  return payload.result
}

async function waitFor(check, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Timed out waiting for condition")
}

const redPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/AAAZ4gk3AAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==",
  "base64"
)
const bluePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAP+KeNJXAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==",
  "base64"
)

function mediaConfig(rootPath, profileName = "Production") {
  return `version: 4
profile:
  name: ${profileName}
media:
  roots:
    - name: media
      path: ${rootPath}
      enabled: true
  defaultRoot: media
preferences: {}
`
}

test("serves hardened frontend, streams images, emits events, and watches media", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-test-"))
  const databasePath = path.join(directory, "records.sqlite3")
  const mediaDirectory = path.join(
    directory,
    "records",
    "profiles",
    "production",
    "media"
  )
  fs.mkdirSync(mediaDirectory, { recursive: true })
  fs.writeFileSync(path.join(mediaDirectory, "initial.png"), redPng)
  fs.writeFileSync(
    path.join(directory, "config.yaml"),
    mediaConfig(mediaDirectory)
  )
  const { child, url } = await startServer(databasePath)

  context.after(() => {
    child.kill("SIGTERM")
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get("cache-control"), "no-store")
  assert.equal(page.headers.get("x-content-type-options"), "nosniff")
  assert.match(
    page.headers.get("content-security-policy"),
    /default-src 'self'/
  )
  assert.match(await page.text(), /<title>Records<\/title>/)
  const origin = new URL(url).origin
  assert.equal((await fetch(origin)).status, 404)
  assert.equal((await fetch(new URL("missing", url))).status, 404)
  assert.equal(
    (await fetch(new URL("rpc", url), { method: "PUT" })).status,
    405
  )

  const events = await fetch(new URL("events", url))
  assert.equal(events.status, 200)
  assert.equal(events.headers.get("content-type"), "text/event-stream")
  assert.equal(events.headers.get("cache-control"), "no-store")
  const reader = events.body.getReader()
  const decoder = new TextDecoder()
  let eventSource = decoder.decode((await reader.read()).value)
  assert.match(eventSource, /event: ready/)
  assert.match(eventSource, /event: photos-import-progress/)
  await call(url, "settings:set", "week_start_day", "sunday")
  await waitFor(async () => {
    const read = await reader.read()
    eventSource += decoder.decode(read.value)
    return eventSource.includes('data: {"method":"settings:set"}')
  })
  await reader.cancel()

  const [initial] = await waitFor(async () => {
    const items = await call(url, "attachments:list-all", {})
    return items.length ? items : null
  })
  assert.equal(initial.relative_path, "initial.png")
  const media = await fetch(new URL(`media/${initial.id}`, url))
  assert.equal(media.status, 200)
  assert.equal(media.headers.get("content-type"), "image/png")
  assert.equal(media.headers.get("cache-control"), "private, no-store")
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), redPng)
  let thumbnailEtag = null
  for (const variant of ["thumb", "micro", "year"]) {
    const thumbnail = await fetch(
      new URL(`media/${initial.id}/${variant}`, url)
    )
    assert.equal(thumbnail.status, 200)
    assert.equal(thumbnail.headers.get("content-type"), "image/jpeg")
    assert.equal(thumbnail.headers.get("cache-control"), "private, no-cache")
    assert.ok((await thumbnail.arrayBuffer()).byteLength > 0)
    if (variant === "thumb") thumbnailEtag = thumbnail.headers.get("etag")
  }
  assert.ok(thumbnailEtag)
  const unchangedThumbnail = await fetch(
    new URL(`media/${initial.id}/thumb`, url),
    { headers: { "If-None-Match": thumbnailEtag } }
  )
  assert.equal(unchangedThumbnail.status, 304)
  assert.equal(
    unchangedThumbnail.headers.get("cache-control"),
    "private, no-cache"
  )
  const revisionedThumbnail = await fetch(
    new URL(`media/${initial.id}/thumb?rev=fixture`, url)
  )
  assert.equal(revisionedThumbnail.status, 200)
  assert.equal(
    revisionedThumbnail.headers.get("cache-control"),
    "private, max-age=31536000, immutable"
  )
  assert.equal(
    (await fetch(new URL(`media/${initial.id}/stream`, url))).status,
    415
  )
  const partialMedia = await fetch(new URL(`media/${initial.id}`, url), {
    headers: { Range: "bytes=0-3" }
  })
  assert.equal(partialMedia.status, 206)
  assert.equal(
    partialMedia.headers.get("content-range"),
    `bytes 0-3/${redPng.length}`
  )
  assert.deepEqual(
    Buffer.from(await partialMedia.arrayBuffer()),
    redPng.subarray(0, 4)
  )
  assert.equal(partialMedia.headers.get("x-content-type-options"), "nosniff")
  const suffixMedia = await fetch(new URL(`media/${initial.id}`, url), {
    headers: { Range: "bytes=-4" }
  })
  assert.equal(suffixMedia.status, 206)
  assert.equal(
    suffixMedia.headers.get("content-range"),
    `bytes ${redPng.length - 4}-${redPng.length - 1}/${redPng.length}`
  )
  assert.deepEqual(
    Buffer.from(await suffixMedia.arrayBuffer()),
    redPng.subarray(-4)
  )
  const malformedRange = await fetch(new URL(`media/${initial.id}`, url), {
    headers: { Range: "invalid" }
  })
  assert.equal(malformedRange.status, 416)
  const impossibleRange = await fetch(new URL(`media/${initial.id}`, url), {
    headers: { Range: "bytes=10-2" }
  })
  assert.equal(impossibleRange.status, 416)

  const originalMediaDirectory = `${mediaDirectory}-original`
  const replacementDirectory = path.join(directory, "replacement-media")
  fs.mkdirSync(replacementDirectory)
  fs.writeFileSync(path.join(replacementDirectory, "initial.png"), bluePng)
  fs.renameSync(mediaDirectory, originalMediaDirectory)
  fs.symlinkSync(replacementDirectory, mediaDirectory)
  assert.equal((await fetch(new URL(`media/${initial.id}`, url))).status, 404)
  fs.unlinkSync(mediaDirectory)
  fs.renameSync(originalMediaDirectory, mediaDirectory)

  fs.writeFileSync(path.join(mediaDirectory, "watched.png"), bluePng)
  const watched = await waitFor(async () => {
    const rows = await call(url, "attachments:list-all", {})
    return rows.length === 2 ? rows : null
  })
  assert.deepEqual(watched.map((row) => row.relative_path).sort(), [
    "initial.png",
    "watched.png"
  ])
  const database = new DatabaseSync(databasePath, { readOnly: true })
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    2
  )
  database.close()

  await call(url, "map-tiles:put", 1, 1, 1, [1, 2, 3, 4])
  assert.equal(
    fs.existsSync(
      path.join(
        directory,
        "records",
        "profiles",
        "production",
        "map-tiles.sqlite3"
      )
    ),
    true
  )
  assert.equal(
    fs
      .statSync(
        path.join(directory, "records", "profiles", "production", "thumbnails")
      )
      .isDirectory(),
    true
  )
  assert.deepEqual(await call(url, "map-tiles:get", 1, 1, 1), [1, 2, 3, 4])
  const tileStats = await call(url, "map-tiles:stats")
  assert.equal(tileStats.tileCount, 1)
  await call(url, "map-tiles:clear")

  const thumbnailWarmup = await call(url, "thumbnails:warmup")
  assert.ok(thumbnailWarmup.done >= 0)
})

test("readiness allows startup media to reconstruct in the background", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-server-readiness-")
  )
  const databasePath = path.join(directory, "records.sqlite3")
  const mediaDirectory = path.join(
    directory,
    "records",
    "profiles",
    "production",
    "media"
  )
  fs.mkdirSync(mediaDirectory, { recursive: true })
  fs.writeFileSync(path.join(mediaDirectory, "seed.jpg"), redPng)
  fs.writeFileSync(
    path.join(directory, "config.yaml"),
    mediaConfig(mediaDirectory)
  )
  try {
    const server = await startServer(databasePath)
    try {
      const media = await waitFor(async () => {
        const attachments = await call(server.url, "attachments:list-all", {})
        return attachments.length ? attachments : null
      })
      assert.equal(media.length, 1)
      assert.equal(media[0].relative_path, "seed.jpg")
    } finally {
      await stopServer(server.child)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("startup replaces an old projection when a media root path changes", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-server-folder-restart-")
  )
  const databasePath = path.join(directory, "records.sqlite3")
  const configPath = path.join(directory, "config.yaml")
  const oldRecords = path.join(directory, "old")
  const nextRecords = path.join(directory, "next")
  const relativePath = "collision.png"
  const red = redPng
  const blue = bluePng
  assert.equal(red.length, blue.length)
  for (const root of [oldRecords, nextRecords]) {
    fs.mkdirSync(path.join(root, "media"), { recursive: true })
  }
  const oldPath = path.join(oldRecords, "media", relativePath)
  const nextPath = path.join(nextRecords, "media", relativePath)
  fs.writeFileSync(oldPath, red)
  fs.writeFileSync(nextPath, blue)
  const sharedTime = new Date("2026-09-18T12:00:00.000Z")
  fs.utimesSync(oldPath, sharedTime, sharedTime)
  fs.utimesSync(nextPath, sharedTime, sharedTime)
  const configSource = (rootParent) =>
    mediaConfig(path.join(rootParent, "media"))
  fs.writeFileSync(configPath, configSource(oldRecords))

  try {
    const first = await startServer(databasePath)
    let oldProjection
    try {
      const attachments = await waitFor(async () => {
        const items = await call(first.url, "attachments:list-all", {})
        return items.length ? items : null
      })
      assert.equal(attachments.length, 1)
      oldProjection = attachments[0]
      assert.equal(oldProjection.file_path, oldPath)
      assert.deepEqual(
        Buffer.from(
          await (
            await fetch(new URL(`media/${oldProjection.id}`, first.url))
          ).arrayBuffer()
        ),
        red
      )
    } finally {
      await stopServer(first.child)
    }

    const stale = new DatabaseSync(databasePath, { readOnly: true })
    const staleProjection = stale
      .prepare(
        "SELECT root_name, relative_path, byte_size, mtime_ms, source_revision FROM attachments"
      )
      .get()
    stale.close()
    assert.equal(staleProjection.root_name, "media")
    assert.equal(staleProjection.relative_path, relativePath)
    assert.equal(staleProjection.byte_size, red.length)
    assert.equal(staleProjection.mtime_ms, fs.statSync(nextPath).mtimeMs)
    fs.writeFileSync(configPath, configSource(nextRecords))

    const second = await startServer(databasePath)
    try {
      const attachments = await waitFor(async () => {
        const items = await call(second.url, "attachments:list-all", {})
        return items[0]?.file_path === nextPath ? items : null
      })
      assert.equal(attachments.length, 1)
      assert.equal(attachments[0].file_path, nextPath)
      assert.equal(attachments[0].relative_path, relativePath)
      assert.equal(attachments[0].byte_size, blue.length)
      assert.notEqual(
        attachments[0].source_revision,
        staleProjection.source_revision
      )
      const response = await fetch(
        new URL(`media/${attachments[0].id}`, second.url)
      )
      assert.equal(response.status, 200)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), blue)
      assert.equal(
        fs.readFileSync(configPath, "utf8"),
        configSource(nextRecords)
      )
      assert.deepEqual(fs.readFileSync(oldPath), red)
      assert.deepEqual(fs.readFileSync(nextPath), blue)
    } finally {
      await stopServer(second.child)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("startup hard-cuts legacy indexes and restarts cleanly", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-server-hard-cut-")
  )
  const databasePath = path.join(directory, "records.sqlite3")
  const thumbnailPath = path.join(directory, "thumbnails", "thumbnails.sqlite3")
  try {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE diary_days(id INTEGER PRIMARY KEY, date TEXT);
      CREATE TABLE diary_messages(id INTEGER PRIMARY KEY, day_id INTEGER);
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
    `)
    legacy.close()
    fs.mkdirSync(path.dirname(thumbnailPath))
    fs.writeFileSync(thumbnailPath, "stale thumbnail ids")

    const first = await startServer(databasePath)
    assert.deepEqual(await call(first.url, "attachments:list-all", {}), [])
    await stopServer(first.child)

    const rebuilt = new DatabaseSync(databasePath, { readOnly: true })
    assert.deepEqual(
      rebuilt
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
        )
        .all()
        .map((row) => row.name),
      ["attachments"]
    )
    rebuilt.close()
    assert.equal(fs.readFileSync(thumbnailPath, "utf8"), "stale thumbnail ids")

    const second = await startServer(databasePath)
    assert.deepEqual(await call(second.url, "attachments:list-all", {}), [])
    await stopServer(second.child)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("profiles isolate authoritative files and disposable state", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-profile-server-")
  )
  try {
    const productionMediaDirectory = path.join(directory, "production-media")
    const productionConfig = path.join(
      directory,
      "config",
      "records",
      "profiles",
      "production",
      "config.yaml"
    )
    fs.mkdirSync(path.dirname(productionConfig), { recursive: true })
    fs.mkdirSync(productionMediaDirectory)
    fs.writeFileSync(productionConfig, mediaConfig(productionMediaDirectory))
    const production = await startProfileServer(directory, "production")
    assert.deepEqual(production.profile, {
      id: "production",
      name: "Production"
    })
    await call(production.url, "settings:set", "week_start_day", "sunday")
    const productionMedia = path.join(
      productionMediaDirectory,
      "production.png"
    )
    fs.writeFileSync(productionMedia, redPng)
    await waitFor(
      async () =>
        (await call(production.url, "attachments:list-all", {})).length === 1
    )
    await call(production.url, "profiles:create", {
      name: "Demo"
    })
    const productionExit = new Promise((resolve) =>
      production.child.once("exit", resolve)
    )
    assert.deepEqual(await call(production.url, "profiles:switch", "demo"), {
      switching: true,
      profile: { id: "demo", name: "Demo" }
    })
    assert.equal(await productionExit, 75)

    const demoMediaDirectory = path.join(directory, "demo-media")
    const demoConfig = path.join(
      directory,
      "config",
      "records",
      "profiles",
      "demo",
      "config.yaml"
    )
    fs.mkdirSync(demoMediaDirectory)
    fs.writeFileSync(demoConfig, mediaConfig(demoMediaDirectory, "Demo"))
    const demo = await startProfileServer(directory)
    assert.deepEqual(demo.profile, { id: "demo", name: "Demo" })
    assert.equal(
      (await call(demo.url, "settings:all")).week_start_day,
      undefined
    )
    assert.equal((await call(demo.url, "attachments:list-all", {})).length, 0)
    await call(demo.url, "settings:set", "week_start_day", "monday")
    const demoMedia = path.join(demoMediaDirectory, "demo.png")
    fs.writeFileSync(demoMedia, bluePng)
    await waitFor(
      async () =>
        (await call(demo.url, "attachments:list-all", {})).length === 1
    )
    const demoExit = new Promise((resolve) => demo.child.once("exit", resolve))
    await call(demo.url, "profiles:switch", "production")
    assert.equal(await demoExit, 75)

    const productionAgain = await startProfileServer(directory)
    assert.equal(
      (await call(productionAgain.url, "settings:all")).week_start_day,
      "sunday"
    )
    const productionRows = await call(
      productionAgain.url,
      "attachments:list-all",
      {}
    )
    assert.equal(productionRows.length, 1)
    assert.equal(productionRows[0].relative_path, "production.png")
    assert.equal(fs.existsSync(demoMedia), true)
    await stopServer(productionAgain.child)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("failed startup emits no readiness and rolls back a pending profile", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-profile-startup-failure-")
  )
  const configHome = path.join(directory, "config")
  const recordsConfig = path.join(configHome, "records")
  fs.mkdirSync(recordsConfig, { recursive: true })
  fs.writeFileSync(path.join(recordsConfig, "active-profile"), "production\n")
  fs.writeFileSync(path.join(recordsConfig, "pending-profile"), "demo\n")
  const occupied = net.createServer()
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve))
  const port = occupied.address().port
  try {
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_CACHE_HOME: path.join(directory, "cache"),
      RECORDS_PORT: String(port)
    }
    for (const name of [
      "RECORDS_CONFIG_PATH",
      "RECORDS_DB_PATH",
      "RECORDS_PROFILE_ID"
    ]) {
      delete env[name]
    }
    const result = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["--no-warnings", "runtime/bootstrap.js"],
        { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"] }
      )
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.stderr.on("data", (chunk) => (stderr += chunk))
      child.once("exit", (code) => resolve({ code, stdout, stderr }))
    })
    assert.equal(result.code, 1, result.stderr)
    assert.doesNotMatch(result.stdout, /RECORDS_READY /)
    assert.equal(
      fs.readFileSync(path.join(recordsConfig, "active-profile"), "utf8"),
      "production\n"
    )
    assert.equal(
      fs.existsSync(path.join(recordsConfig, "pending-profile")),
      false
    )
  } finally {
    await new Promise((resolve) => occupied.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
