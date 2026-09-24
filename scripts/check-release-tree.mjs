import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")))
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json")))
const packageLock = JSON.parse(
  fs.readFileSync(path.join(root, "package-lock.json"))
)
const textExtensions = new Set([
  "",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".lua",
  ".md",
  ".mjs",
  ".qml",
  ".svg",
  ".txt",
  ".yaml",
  ".yml"
])
const forbidden = [".dev/", ".opencode/", "node_modules/", "coverage/"]
const listing = spawnSync(
  "git",
  [
    "-c",
    `safe.directory=${root}`,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z"
  ],
  { cwd: root, encoding: "buffer" }
)
if (listing.status !== 0) throw new Error(listing.stderr.toString())

const files = listing.stdout
  .toString()
  .split("\0")
  .filter(Boolean)
  .filter(
    (relative) => relative !== ".opencode" && !relative.startsWith(".opencode/")
  )
  .filter((relative) => fs.existsSync(path.join(root, relative)))

if (files.length > 1_000) throw new Error(`Release has ${files.length} files`)
let textBytes = 0
for (const relative of files) {
  if (forbidden.some((prefix) => relative.startsWith(prefix))) {
    throw new Error(`Development-only release file: ${relative}`)
  }
  const absolute = path.join(root, relative)
  if (fs.lstatSync(absolute).isSymbolicLink()) {
    throw new Error(`Release symlink: ${relative}`)
  }
  const extension = path.extname(relative).toLowerCase()
  const base = path.basename(relative).toLowerCase()
  if (
    !textExtensions.has(extension) &&
    !["license", "copying"].includes(base)
  ) {
    continue
  }
  const size = fs.statSync(absolute).size
  if (size > 512 * 1024) {
    throw new Error(`Release text file exceeds 512 KiB: ${relative}`)
  }
  textBytes += size
}
if (textBytes > 8 * 1024 * 1024) {
  throw new Error(`Release text totals ${textBytes} bytes`)
}

const versions = [
  packageJson.version,
  packageLock.version,
  packageLock.packages?.[""]?.version,
  manifest.version
]
if (new Set(versions).size !== 1 || versions.some((version) => !version)) {
  throw new Error(`Release versions differ: ${versions.join(", ")}`)
}

process.stdout.write(
  `Release tree: ${files.length} files, ${textBytes} text bytes, version ${manifest.version}\n`
)
