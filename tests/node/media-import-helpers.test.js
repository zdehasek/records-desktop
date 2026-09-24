import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  computeChecksum,
  extractGps,
  formatGps,
  sanitizeExif
} from "../../runtime/src/services/media-import-helpers.js"

test("media import helpers hash and sanitize files", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-media-"))
  const filePath = path.join(directory, "sample.jpg")
  fs.writeFileSync(filePath, "records")

  assert.equal(
    await computeChecksum(filePath),
    "a94e7bcfcbed3c846d491d4f47c948e53a23908d480248b3ffe9e126e83ea865"
  )
  assert.deepEqual(
    sanitizeExif({
      make: "Camera",
      capturedAt: new Date("2020-01-02T03:04:05.000Z"),
      binary: Buffer.from("private"),
      nested: [1, undefined, { model: "Lens" }]
    }),
    {
      make: "Camera",
      capturedAt: "2020-01-02T03:04:05.000Z",
      nested: [1, { model: "Lens" }]
    }
  )

  fs.rmSync(directory, { recursive: true, force: true })
})

test("media import helpers normalize GPS data", () => {
  assert.deepEqual(
    extractGps({
      GPSLatitude: [51, 30, 0],
      GPSLatitudeRef: "N",
      GPSLongitude: [0, 7, 30],
      GPSLongitudeRef: "W"
    }),
    { latitude: 51.5, longitude: -0.125 }
  )
  assert.equal(formatGps(51.5, -0.125), "51.5000N, 0.1250W")
  assert.equal(formatGps(null, null), "")
})
