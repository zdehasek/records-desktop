import { chromium } from "@playwright/test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startBackendFixture } from "../tests/browser/backend-fixture.js"

const root = path.resolve(import.meta.dirname, "..")
const backend = await startBackendFixture(root)
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true
})
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "records-preview-"))
const png = path.join(temporary, "preview.png")

try {
  let attachments = []
  for (let attempt = 0; attempt < 100 && attachments.length < 5; attempt++) {
    attachments = await backend.rpc("attachments:list-all", [{}])
    if (attachments.length < 5) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  await backend.rpc("settings:set", ["onboarding_completed", "true"])
  const photo = attachments.find((item) => item.file_name === "info.jpg")
  if (photo) {
    await backend.rpc("attachments:update", [
      photo.id,
      { content: "A quiet moment worth keeping", important: true }
    ])
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await backend.routeFrontend(page)
  await page.goto(`${backend.appUrl}#today`)
  await page.locator(".app-shell").waitFor()
  await page.screenshot({ path: png })

  const converted = spawnSync(
    "magick",
    [png, "-strip", "-quality", "86", path.join(root, "preview.webp")],
    { encoding: "utf8" }
  )
  if (converted.status !== 0) throw new Error(converted.stderr)
} finally {
  await browser.close()
  await backend.stop()
  fs.rmSync(temporary, { recursive: true, force: true })
}
