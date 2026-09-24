import { createHash } from "node:crypto"
import fs from "node:fs"

export function checksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = fs.createReadStream(filePath)
    stream.on("error", reject)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}
