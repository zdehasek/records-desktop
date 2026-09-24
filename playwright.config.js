import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "tests/browser",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: {
      executablePath: "/usr/bin/chromium",
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream"
      ]
    }
  }
})
