import fs from "node:fs"
import path from "node:path"
import { runCommand } from "../../host-tools.js"

export function createSystemTrash(gio, options = {}) {
  const run = options.run || runCommand
  const move = async (filePath) => {
    if (!gio) throw new Error("Install glib2 to use system Trash")
    const absolutePath = path.resolve(filePath)
    await run(gio, ["trash", absolutePath])
    if (fs.existsSync(absolutePath))
      throw new Error(`System Trash did not remove: ${absolutePath}`)
    return true
  }
  return { available: Boolean(gio), move }
}
