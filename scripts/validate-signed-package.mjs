import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { parseBooleanEntitlements } from "./validate-entitlements.mjs"

const require = createRequire(import.meta.url)
const { classifyCodeObject } = require("./sign-macos.cjs")

const app = path.resolve(process.argv[2] || "")
if (process.platform !== "darwin" || !app.endsWith(".app")) {
  throw new Error(
    "Usage: node scripts/validate-signed-package.mjs /path/Records.app"
  )
}

function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}`)
  }
  return result
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) return []
    return entry.isDirectory() ? walk(item) : [item]
  })
}

function walkBundles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return []
    const item = path.join(directory, entry.name)
    const bundle = /\.(?:app|appex|framework|plugin|xpc)$/.test(entry.name)
      ? [item]
      : []
    return [...bundle, ...walkBundles(item)]
  })
}

const machOFiles = walk(app).filter((file) =>
  run("file", ["-b", file]).stdout.includes("Mach-O")
)
const candidates = [app, ...walkBundles(app), ...machOFiles]
const inspected = []
const required = new Map([
  ["main", false],
  ["helper", false],
  ["framework", false],
  ["ffmpeg", false],
  ["ffprobe", false],
  ["magick", false],
  ["perl", false],
  ["libheif", false],
  ["libde265", false]
])

for (const candidate of candidates) {
  const result = run(
    "codesign",
    ["--display", "--entitlements", ":-", candidate],
    true
  )
  if (result.status !== 0) {
    throw new Error(
      `unsigned code in package: ${path.relative(app, candidate)}`
    )
  }
  const xmlOutput = `${result.stdout}\n${result.stderr}`
  const xmlStart = xmlOutput.indexOf("<?xml")
  const entitlements =
    xmlStart === -1 ? {} : parseBooleanEntitlements(xmlOutput.slice(xmlStart))
  const relative =
    path.relative(app, candidate).replaceAll(path.sep, "/") || "."
  const kind = classifyCodeObject(app, candidate)
  const expected =
    kind === "electron"
      ? { "com.apple.security.cs.allow-jit": true }
      : kind === "magick"
        ? { "com.apple.security.cs.disable-library-validation": true }
        : {}
  if (JSON.stringify(entitlements) !== JSON.stringify(expected)) {
    throw new Error(
      `${relative}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(entitlements)}`
    )
  }

  if (relative === "Contents/MacOS/Records") required.set("main", true)
  if (/^Contents\/Frameworks\/Records Helper.*\.app\//.test(relative))
    required.set("helper", true)
  if (relative.includes("Electron Framework.framework/Versions/"))
    required.set("framework", true)
  const vendorInventory = new Map([
    ["Contents/Resources/vendor/bin/ffmpeg", "ffmpeg"],
    ["Contents/Resources/vendor/bin/ffprobe", "ffprobe"],
    ["Contents/Resources/vendor/bin/magick", "magick"],
    ["Contents/Resources/vendor/perl/bin/perl", "perl"],
    ["Contents/Resources/vendor/lib/libheif.dylib", "libheif"],
    ["Contents/Resources/vendor/lib/libde265.dylib", "libde265"]
  ])
  const inventory = vendorInventory.get(relative)
  if (inventory) required.set(inventory, true)
  inspected.push(relative)
}

const missing = [...required]
  .filter(([, found]) => !found)
  .map(([name]) => name)
if (missing.length)
  throw new Error(
    `signed package inventory was not inspected: ${missing.join(", ")}`
  )
process.stdout.write(
  `Signed entitlements: ${inspected.length} code objects inspected; Magick exception is exclusive\n`
)
