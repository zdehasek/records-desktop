import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { validateElectronStorage } from "./validate-electron-storage.mjs"

const sourceApp = path.resolve(process.argv[2] || "")
if (process.platform !== "darwin" || !sourceApp.endsWith(".app")) {
  throw new Error(
    "Usage: node scripts/smoke-packaged-gui.mjs /path/Records.app"
  )
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "Records GUI smoke "))
const app = path.join(workspace, "Relocated Records.app")
const home = path.join(workspace, "isolated home")
const recordsData = path.join(home, "Library", "Application Support", "records")
const recordsCache = path.join(home, "Library", "Caches", "records")
const userData = path.join(recordsData, "electron")
const sessionData = path.join(userData, "session")
fs.mkdirSync(home, { recursive: true })
fs.cpSync(sourceApp, app, {
  recursive: true,
  preserveTimestamps: true,
  verbatimSymlinks: true
})

const executable = path.join(app, "Contents", "MacOS", "Records")
const child = spawn(
  executable,
  ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
  {
    env: {
      HOME: home,
      LANG: process.env.LANG || "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      RECORDS_CONFIG_DIR: recordsData,
      RECORDS_DATA_DIR: recordsData,
      RECORDS_CACHE_DIR: recordsCache
    },
    stdio: ["ignore", "pipe", "pipe"]
  }
)
const childExit = new Promise((resolve) => child.once("exit", resolve))
let output = ""
child.stdout.on("data", (chunk) => {
  output = (output + chunk).slice(-16_384)
})
child.stderr.on("data", (chunk) => {
  output = (output + chunk).slice(-16_384)
})

async function waitForDebuggingPort() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Records exited early: ${output}`)
    const loggedPort = output.match(
      /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//
    )?.[1]
    if (loggedPort) return Number(loggedPort)
    for (const directory of [userData, sessionData]) {
      const portFile = path.join(directory, "DevToolsActivePort")
      if (!fs.existsSync(portFile)) continue
      const [port] = fs.readFileSync(portFile, "utf8").trim().split("\n")
      if (/^\d+$/.test(port)) return Number(port)
    }
    await delay(100)
  }
  throw new Error(`timed out waiting for remote debugging: ${output}`)
}

async function waitForUi(port) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(
      () => null
    )
    if (response?.ok) {
      const targets = await response.json()
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          /^http:\/\/127\.0\.0\.1:\d+\//.test(target.url) &&
          target.webSocketDebuggerUrl
      )
      if (page) {
        const evaluation = await evaluate(page.webSocketDebuggerUrl)
        if (evaluation.readyState === "complete" && evaluation.hasRoot)
          return page
      }
    }
    await delay(100)
  }
  throw new Error(`timed out waiting for the packaged UI: ${output}`)
}

function cdp(webSocketUrl, method, params = {}, waitForResponse = true) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`CDP ${method} timed out`))
    }, 5_000)
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method, params }))
      if (!waitForResponse) {
        clearTimeout(timer)
        resolve()
      }
    })
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error(`CDP ${method} connection failed`))
    })
  })
}

async function evaluate(webSocketUrl) {
  const result = await cdp(webSocketUrl, "Runtime.evaluate", {
    expression:
      "({readyState: document.readyState, hasRoot: Boolean(document.querySelector('#root')?.childElementCount)})",
    returnByValue: true
  })
  return result.result.value
}

async function persistStorageMarker(webSocketUrl, marker) {
  const encoded = JSON.stringify(marker)
  const result = await cdp(webSocketUrl, "Runtime.evaluate", {
    expression: `(async () => {
      localStorage.setItem("records-storage-smoke", ${encoded});
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("records-storage-smoke", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("state");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("state", "readwrite");
          transaction.objectStore("state").put(${encoded}, "marker");
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      });
      return localStorage.getItem("records-storage-smoke");
    })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails)
    throw new Error(
      `storage marker evaluation failed: ${result.exceptionDetails.text}`
    )
  if (result.result.value !== marker)
    throw new Error("storage marker could not be read back from the renderer")
}

async function closeCleanly(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`)
  const browser = await response.json()
  await cdp(browser.webSocketDebuggerUrl, "Browser.close", {}, false)
  await Promise.race([
    childExit,
    delay(10_000).then(() => {
      throw new Error("Records did not exit after Browser.close")
    })
  ])
}

try {
  const port = await waitForDebuggingPort()
  const page = await waitForUi(port)
  const marker = `records-storage-smoke-${randomUUID()}`
  await persistStorageMarker(page.webSocketDebuggerUrl, marker)
  await closeCleanly(port)
  if (child.signalCode)
    throw new Error(`Records exited with ${child.signalCode}`)
  if (child.exitCode !== 0)
    throw new Error(`Records exited with status ${child.exitCode}`)
  const storage = validateElectronStorage({
    home,
    userData,
    sessionData,
    marker
  })
  process.stdout.write(
    `Packaged GUI ready at ${page.url} from a relocated app\nuserData: ${userData}\nsessionData: ${sessionData}\nmarker files: ${storage.markerFiles.length}\n`
  )
} finally {
  if (child.exitCode === null) child.kill("SIGKILL")
  fs.rmSync(workspace, { recursive: true, force: true })
}
