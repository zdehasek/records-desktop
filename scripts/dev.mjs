import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { createServer as createViteServer } from "vite"

const root = path.resolve(import.meta.dirname, "..")
const developmentDirectory = path.join(root, ".dev")
const xdgDirectory = path.join(developmentDirectory, "xdg")
const dataHome = path.join(xdgDirectory, "data")
const configHome = path.join(xdgDirectory, "config")
const cacheHome = path.join(xdgDirectory, "cache")
const profileDataPath = path.join(dataHome, "records", "profiles", "production")
const databasePath = path.join(
  cacheHome,
  "records",
  "profiles",
  "production",
  "index.sqlite3"
)
const profilePath = path.join(profileDataPath, "chromium-profile")
const frontendPort = 43817
const noOpen = process.argv.includes("--no-open")
const clean = process.argv.includes("--clean")
const token = randomBytes(32).toString("hex")

let backend = null
let backendPort = 0
let browser = null
let restartTimer = null
let restarting = false
let shuttingDown = false
let vite = null

if (clean) fs.rmSync(developmentDirectory, { recursive: true, force: true })
for (const directory of [
  developmentDirectory,
  dataHome,
  configHome,
  cacheHome,
  profilePath
]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
}

function waitForBackend(child) {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout })
    const timeout = setTimeout(
      () => reject(new Error("Records backend startup timed out")),
      15_000
    )
    const onExit = (code) => {
      clearTimeout(timeout)
      reject(new Error(`Records backend exited during startup (${code})`))
    }

    child.once("exit", onExit)
    lines.on("line", (line) => {
      process.stdout.write(`[backend] ${line}\n`)
      if (!line.startsWith("RECORDS_READY ")) return
      clearTimeout(timeout)
      child.off("exit", onExit)
      try {
        resolve(new URL(JSON.parse(line.slice("RECORDS_READY ".length)).url))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function startBackend(port = 0) {
  const child = spawn(
    process.execPath,
    ["--no-warnings", "runtime/bootstrap.js"],
    {
      cwd: root,
      env: {
        ...process.env,
        RECORDS_BASE_TOKEN: token,
        RECORDS_PORT: String(port),
        XDG_CACHE_HOME: cacheHome,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome
      },
      stdio: ["ignore", "pipe", "inherit"]
    }
  )
  child.once("error", (error) => {
    process.stderr.write(`Backend launch failed: ${error.message}\n`)
  })
  return child
}

function monitorBackend(child) {
  child.once("exit", (code) => {
    if (backend === child && !restarting && !shuttingDown) {
      if (code === 75) {
        restartBackend()
        return
      }
      process.stderr.write(`Records backend exited (${code})\n`)
      shutdown(1)
    }
  })
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ])
  if (child.exitCode === null) child.kill("SIGKILL")
}

async function restartBackend() {
  if (restarting || shuttingDown) return
  restarting = true
  process.stdout.write("[dev] Runtime changed; restarting backend...\n")
  await stopChild(backend)
  backend = startBackend(backendPort)
  try {
    await waitForBackend(backend)
    monitorBackend(backend)
    process.stdout.write("[dev] Backend restarted\n")
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`)
  } finally {
    restarting = false
  }
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(restartTimer)
  await stopChild(browser)
  await vite?.close()
  await stopChild(backend)
  process.exit(exitCode)
}

try {
  backend = startBackend()
  const backendUrl = await waitForBackend(backend)
  backendPort = Number(backendUrl.port)
  monitorBackend(backend)

  const endpointPattern =
    `^${escapeRegex(backendUrl.pathname)}` +
    "(?:rpc|events|basemap\\.pmtiles|glyphs/|media/)"

  vite = await createViteServer({
    configFile: path.join(root, "vite.config.js"),
    base: backendUrl.pathname,
    plugins: [
      {
        name: "records-development-csp",
        transformIndexHtml(html) {
          return html.replace(
            "connect-src 'self'",
            "connect-src 'self' ws://127.0.0.1:*"
          )
        }
      }
    ],
    server: {
      host: "127.0.0.1",
      port: frontendPort,
      strictPort: true,
      proxy: {
        [endpointPattern]: {
          target: backendUrl.origin,
          changeOrigin: false
        }
      }
    }
  })
  await vite.listen()
  vite.watcher.add(path.join(root, "runtime"))
  vite.watcher.on("change", (filePath) => {
    if (!filePath.startsWith(path.join(root, "runtime"))) return
    clearTimeout(restartTimer)
    restartTimer = setTimeout(restartBackend, 150)
  })

  const address = vite.httpServer.address()
  if (!address || typeof address === "string") {
    throw new Error("Vite did not expose a TCP port")
  }

  const appUrl = `http://127.0.0.1:${address.port}${backendUrl.pathname}#today`
  process.stdout.write(
    `RECORDS_DEV_READY ${JSON.stringify({ url: appUrl, databasePath })}\n`
  )
  process.stdout.write("[dev] Frontend edits use Vite HMR\n")
  process.stdout.write("[dev] Runtime edits restart the backend\n")

  if (!noOpen) {
    browser = spawn(
      "chromium",
      [
        `--user-data-dir=${profilePath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--class=records-dev",
        `--app=${appUrl}`
      ],
      { stdio: "inherit" }
    )
    browser.once("error", (error) => {
      process.stderr.write(`Could not launch Chromium: ${error.message}\n`)
      shutdown(1)
    })
  }
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`)
  await shutdown(1)
}

process.once("SIGINT", () => shutdown(0))
process.once("SIGTERM", () => shutdown(0))
