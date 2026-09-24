import { spawnSync } from "node:child_process"
import electron from "electron"

const result = spawnSync(
  electron,
  [
    "-e",
    "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE ok(value)'); process.stdout.write(process.versions.node)"
  ],
  {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  }
)
if (result.status !== 0) {
  throw new Error(result.stderr || "Electron embedded Node failed node:sqlite")
}
process.stdout.write(
  `Electron embedded Node ${result.stdout.trim()} supports node:sqlite\n`
)
