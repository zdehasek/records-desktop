import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "records-validate-"))
const staged = path.join(temporary, "plugin")

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe"
  })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout)
    process.exitCode = result.status || 1
    return false
  }
  return true
}

function stageReleaseTree() {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "buffer" }
  )
  if (result.status !== 0) {
    process.stderr.write(result.stderr.toString())
    throw new Error("Could not enumerate release files")
  }
  for (const relative of result.stdout.toString().split("\0").filter(Boolean)) {
    if (relative === ".opencode" || relative.startsWith(".opencode/")) continue
    const source = path.join(root, relative)
    if (!fs.existsSync(source)) continue
    const destination = path.join(staged, relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
  }
}

try {
  stageReleaseTree()
  if (run("omarchy", ["plugin", "validate", staged])) {
    run(
      "qmllint",
      [
        "-I",
        "/usr/share/omarchy/shell",
        "BarWidget.qml",
        "Panel.qml",
        "Service.qml"
      ],
      staged
    )
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
