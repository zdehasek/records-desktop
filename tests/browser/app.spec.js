import { expect, test } from "@playwright/test"
import path from "node:path"
import { startBackendFixture } from "./backend-fixture.js"

const root = path.resolve(import.meta.dirname, "..", "..")
let appUrl
let backend

test.setTimeout(60_000)

test.beforeAll(async ({ browserName }, testInfo) => {
  if (browserName !== "chromium") throw new Error("Chromium is required")
  testInfo.setTimeout(90_000)
  backend = await startBackendFixture(root)
  appUrl = backend.appUrl
})

test.beforeEach(async ({ page }, testInfo) => {
  await backend.routeFrontend(page)
  if (testInfo.title !== "onboarding is opaque and persists essential setup") {
    await backend.rpc("settings:set", ["onboarding_completed", "true"])
  }
})

test.afterAll(async () => {
  await backend?.stop()
})

test("onboarding is opaque and persists essential setup", async ({ page }) => {
  await page.goto(`${appUrl}#today`)
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(page.locator(".app-shell")).toHaveAttribute("inert", "")
  await expect(
    page.getByRole("heading", { name: "Set Up Records" })
  ).toBeVisible()
  await expect(page.getByText("Records folder", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Managed media folder")).toHaveCount(0)
  await expect(page.getByText("Default journal folder")).toHaveCount(0)
  await expect(page.getByText("Additional journal folders")).toHaveCount(0)
  await expect(page.getByText("Folders to scan", { exact: true })).toBeVisible()
  await expect(page.getByText(/copies it into records\//)).toBeVisible()
  await expect(page.getByText("NSFW media", { exact: true })).toBeVisible()
  await expect(page.getByText("Week starts")).toBeVisible()
  await expect(page.getByText("Week Overview Photos")).toBeHidden()

  const setupSections = dialog.locator(".onboarding__section")
  await expect(setupSections.nth(0)).toContainText("Folders to scan")
  const folderCard = dialog.locator(".media-folder").first()
  const [folderBox, nsfwBox, weekBox] = await Promise.all([
    folderCard.boundingBox(),
    dialog.getByText("NSFW media", { exact: true }).boundingBox(),
    dialog.getByText("Week starts", { exact: true }).boundingBox()
  ])
  expect(folderBox.width).toBeGreaterThan(500)
  expect(folderBox.height).toBeLessThan(120)
  expect(Math.abs(nsfwBox.y - weekBox.y)).toBeLessThan(10)
  await expect(
    page.getByRole("button", { name: "media is the default folder" })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(
    page.getByRole("button", { name: "Set watched as the default folder" })
  ).toHaveAttribute("aria-pressed", "false")
  await page
    .getByRole("button", { name: "Set watched as the default folder" })
    .click()
  await expect(
    page.getByRole("button", { name: "watched is the default folder" })
  ).toHaveAttribute("aria-pressed", "true")
  await page.reload()
  await expect(
    page.getByRole("button", { name: "watched is the default folder" })
  ).toHaveAttribute("aria-pressed", "true")
  await page
    .getByRole("button", { name: "Set media as the default folder" })
    .click()
  const backgrounds = await page.evaluate(() => ({
    panel: getComputedStyle(document.querySelector(".onboarding__panel"))
      .backgroundColor,
    backdrop: getComputedStyle(document.querySelector(".onboarding__backdrop"))
      .backgroundColor
  }))
  expect(backgrounds.panel).not.toMatch(/rgba\([^)]*,\s*0(?:\.\d+)?\)/)
  expect(backgrounds.backdrop).not.toMatch(/rgba\([^)]*,\s*0(?:\.\d+)?\)/)

  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await page.getByRole("button", { name: "Skip setup" }).click()
  await expect(dialog).toBeHidden()
  await page.evaluate(async () => {
    await fetch(new URL("rpc", document.baseURI), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "settings:set",
        args: ["onboarding_completed", "false"]
      })
    })
  })
  await page.reload()
  await expect(dialog).toBeVisible()

  await expect(page.getByText("Location capture")).toHaveCount(0)
  await expect(page.getByText("NSFW media", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Visible" }).click()
  await page.getByRole("button", { name: "Sunday" }).click()
  await expect(page.getByText("Editor", { exact: true })).toBeHidden()
  await page.getByRole("button", { name: "Finish" }).click()
  await expect(dialog).toBeHidden()

  await page.reload()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(page.locator(".top-bar__profile")).toHaveCount(0)
  const saved = await page.evaluate(async () => {
    const response = await fetch(new URL("rpc", document.baseURI), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "settings:all", args: [] })
    })
    return (await response.json()).result
  })
  expect(saved).toMatchObject({
    onboarding_completed: "true",
    week_start_day: "sunday",
    nsfw_mode: "visible"
  })
  expect(saved.vim_mode).toBeUndefined()

  await page.goto(`${appUrl}#settings`)
  await expect(page.getByText("Profiles", { exact: true })).toBeVisible()
  await expect(page.locator(".settings-view__profile")).toHaveText("Production")
  await expect(page.getByText("Week Overview Photos")).toBeVisible()
  const profileBadge = page.locator(".settings-panel__badge")
  const badgeStyles = await profileBadge.evaluate((element) => {
    const styles = getComputedStyle(element)
    return {
      background: styles.backgroundColor,
      color: styles.color,
      flexShrink: styles.flexShrink,
      height: element.getBoundingClientRect().height
    }
  })
  expect(badgeStyles.height).toBeGreaterThanOrEqual(24)
  expect(badgeStyles.flexShrink).toBe("0")
  expect(badgeStyles.color).not.toBe(badgeStyles.background)
  await expect(page.getByText("Records folder", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Folders to scan", { exact: true })).toBeVisible()
  await expect(page.getByText("Location capture")).toHaveCount(0)
  await expect(page.getByText("Location Enrichment")).toHaveCount(0)
  await expect(page.getByText("IP Provider")).toHaveCount(0)
  await expect(page.getByText(/Capture runs only when saving/)).toHaveCount(0)
  const settingsFolder = page.locator(".settings-view .media-folder").first()
  const [identityBox, actionsBox, settingsFolderBox, addFolderBox] =
    await Promise.all([
      settingsFolder.locator(".media-folder__identity").boundingBox(),
      settingsFolder.locator(".tile-grid__actions").boundingBox(),
      settingsFolder.boundingBox(),
      page.getByRole("button", { name: "Add Folder" }).boundingBox()
    ])
  expect(actionsBox.y).toBeGreaterThanOrEqual(
    identityBox.y + identityBox.height
  )
  expect(addFolderBox.y).toBeGreaterThan(
    settingsFolderBox.y + settingsFolderBox.height
  )
  await page.getByRole("button", { name: "Create profile" }).click()
  await expect(page.getByText("Profile name")).toBeVisible()
  const createProfile = page.getByRole("button", {
    name: "Create profile"
  })
  await expect(createProfile).not.toHaveClass(/btn--primary/)
  await expect(createProfile).toHaveCSS("background-image", "none")
  await expect(page.locator(".top-bar__wordmark-text")).toHaveCSS(
    "background-image",
    /linear-gradient/
  )
  await expect(page.getByText("Journal fixtures")).toHaveCount(0)
  await expect(page.getByText("Media fixtures")).toHaveCount(0)
  await expect(page.getByText("New entry", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Record audio" })).toHaveCount(
    0
  )
  await expect(page.getByText("Import Tags in Photos")).toBeHidden()
  await expect(page.getByRole("button", { name: "Trash" })).toBeHidden()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Run onboarding again" }).click()
  await expect(dialog).toBeVisible()
  await expect(page.locator(".onboarding__footer")).toBeVisible()
  expect((await dialog.boundingBox()).width).toBeLessThanOrEqual(390)
  const watchedMobileBox = await setupSections.nth(0).boundingBox()
  const managedMobileBox = await setupSections.nth(1).boundingBox()
  expect(watchedMobileBox.y).toBeLessThan(managedMobileBox.y)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await page.evaluate(async () => {
    await fetch(new URL("rpc", document.baseURI), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "settings:set",
        args: ["onboarding_completed", "true"]
      })
    })
  })
})

test("all shell routes load without page errors", async ({ page }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  for (const route of [
    "today",
    "week",
    "year",
    "photos",
    "map",
    "on-this-day",
    "settings"
  ]) {
    await page.goto(`${appUrl}#${route}`)
    await expect(page).toHaveTitle("Records - Production")
    await expect(page.locator("main")).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`#${route}$`))
  }
  expect(errors).toEqual([])
})

test("navigation keeps the URL route in sync", async ({ page }) => {
  await page.goto(`${appUrl}#today`)
  await page.getByRole("button", { name: "Week", exact: true }).click()
  await expect(page).toHaveURL(/#week$/)
  await page.locator('[data-view="year"]').click()
  await expect(page).toHaveURL(/#year$/)
  await page.evaluate(() => {
    window.location.hash = "today"
  })
  await expect(page).toHaveURL(/#today$/)
  await expect(page.locator('[data-view="timeline"]')).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(page.getByText("Journal", { exact: true })).toHaveCount(0)
  await expect(page.getByText("New entry", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Record audio" })).toHaveCount(
    0
  )
})

test("On This Day is available from navigation and Alt+5", async ({ page }) => {
  await page.goto(`${appUrl}#today`)
  await page.getByRole("button", { name: "On This Day", exact: true }).click()
  await expect(page).toHaveURL(/#on-this-day$/)
  await page.getByRole("button", { name: "Today", exact: true }).click()
  await page.getByRole("button", { name: "Today", exact: true }).focus()
  await page.keyboard.press("Alt+5")
  await expect(page).toHaveURL(/#on-this-day$/)
  await expect(
    page.getByRole("heading", { name: "On This Day", exact: true })
  ).toBeVisible()
  await expect(page.locator(".top-bar__day-label")).toHaveText("On This Day")
  await expect(page.getByText("No memories for today yet")).toBeVisible()

  await page.goto(`${appUrl}#settings`)
  const time = page.locator("#on-this-day-time")
  await expect(time).toHaveValue("09:00")
  await time.focus()
  await page.keyboard.press("Alt+5")
  await expect(page).toHaveURL(/#settings$/)
})

test("restrictive visibility changes clear stale memory cards", async ({
  page
}) => {
  const pending = []
  let memoryRequests = 0
  await page.route("**/rpc", async (route) => {
    const body = route.request().postDataJSON()
    if (body.method !== "days:memory") {
      await route.continue()
      return
    }

    memoryRequests += 1
    if (memoryRequests === 1) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          result: [
            {
              id: "2025-09-19",
              date: "2025-09-19",
              created_at: "2025-09-19T00:00:00.000Z",
              updated_at: "2025-09-19T00:00:00.000Z",
              photo_attachment_id: null,
              photo_count: 1,
              label: "1Y",
              period: "1y"
            }
          ]
        })
      })
      return
    }

    let release
    const blocked = new Promise((resolve) => {
      release = resolve
    })
    pending.push({ options: body.args[1], release })
    await blocked
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "fixture failure" })
    })
  })

  await page.goto(`${appUrl}#on-this-day`)
  await expect(page.locator(".on-this-day__card")).toHaveCount(1)
  await expect
    .poll(() => page.locator(".day-section").count())
    .toBeGreaterThan(0)
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
  )

  await page.keyboard.press("Control+.")
  await expect.poll(() => pending.length).toBe(1)
  expect(pending[0].options.dotFilesVisible).toBe(true)
  await expect(page.locator(".on-this-day__card")).toHaveCount(1)
  await expect(page.getByText("Updating memories...")).toBeVisible()
  pending[0].release()
  await expect(page.getByText("Updating memories...")).toBeHidden()
  await expect(page.locator(".on-this-day__card")).toHaveCount(1)

  await page.keyboard.press("Control+.")
  await expect.poll(() => pending.length).toBe(2)
  expect(pending[1].options.dotFilesVisible).toBe(false)
  await expect(page.locator(".on-this-day__card")).toHaveCount(0)
  await expect(page.getByText("Looking through your memories...")).toBeVisible()
  pending[1].release()
  await expect(page.getByText("No memories for today yet")).toBeVisible()
  await expect(page.locator(".on-this-day__card")).toHaveCount(0)
})

test("settings react when capabilities finish loading", async ({ page }) => {
  let releaseCapabilities
  let capabilityRequests = 0
  const capabilitiesReleased = new Promise((resolve) => {
    releaseCapabilities = resolve
  })
  await page.route("**/rpc", async (route) => {
    const request = route.request()
    const body = request.postDataJSON()
    if (body.method === "system:capabilities") {
      capabilityRequests += 1
      await capabilitiesReleased
    }
    await route.continue()
  })

  try {
    await page.goto(`${appUrl}#settings`, { waitUntil: "domcontentloaded" })
    await expect(page.locator(".app-shell")).toBeVisible()
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible()
    await expect(page.locator(".settings-view__profile")).toHaveText("")
    await expect(page.getByText("Thumbnail Cache")).toHaveCount(0)
  } finally {
    releaseCapabilities()
  }
  await expect(page.locator(".settings-view__profile")).toHaveText("Production")
  await expect(page.getByText("Thumbnail Cache")).toBeVisible()
  await expect(page).toHaveTitle("Records - Production")
  expect(capabilityRequests).toBe(1)
})

test("story deep link opens On This Day without blocking alerts", async ({
  page
}) => {
  page.on("dialog", (dialog) => dialog.dismiss())
  await page.goto(`${appUrl}#on-this-day-story`)
  await expect(page).toHaveURL(/#on-this-day$/)
  await expect(
    page.getByRole("heading", { name: "On This Day", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("No important memories to play yet.")
  ).toBeVisible()
})

test("timeline styles and dark mode are applied", async ({ page }) => {
  await page.goto(`${appUrl}#today`)
  const buttonStyles = await page
    .locator(".day-section__icon-btn")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        display: style.display,
        width: style.width,
        height: style.height,
        borderRadius: style.borderRadius
      }
    })
  expect(buttonStyles).toEqual({
    display: "flex",
    width: "32px",
    height: "32px",
    borderRadius: "999px"
  })

  expect(
    await page.evaluate(() => ({
      darkClass: document.documentElement.classList.contains("dark"),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      canvas: getComputedStyle(document.documentElement)
        .getPropertyValue("--color-canvas")
        .trim()
    }))
  ).toEqual({ darkClass: true, colorScheme: "dark", canvas: "#101827" })
})

test("timeline photos copy a full Instax share image", async ({ page }) => {
  await page.addInitScript(() => {
    window.ClipboardItem = class ClipboardItem {
      constructor(data) {
        this.data = data
        this.types = Object.keys(data)
      }

      async getType(type) {
        return this.data[type]
      }
    }
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (items) => {
          const blob = await items[0].getType("image/png")
          const bitmap = await createImageBitmap(blob)
          window.__shareImage = {
            type: blob.type,
            width: bitmap.width,
            height: bitmap.height
          }
          bitmap.close()
        }
      }
    })
  })
  await page.goto(`${appUrl}#today`)
  const photoCard = page.getByRole("img", { name: "info.jpg" }).locator("..")
  const share = photoCard.getByRole("button", { name: "Copy share image" })
  await expect(share).toBeAttached()
  await share.click()
  await expect(
    photoCard.getByRole("button", { name: "Copied share image" })
  ).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.__shareImage))
    .toEqual({
      type: "image/png",
      width: 900,
      height: 1230
    })
  const videoCard = page.getByRole("img", { name: "tone.mp4" }).locator("..")
  await expect(
    videoCard.getByRole("button", { name: /share image/i })
  ).toHaveCount(0)
})

test("startup reconstructs photos from every configured folder", async ({
  page
}) => {
  const photos = await backend.rpc("attachments:list-all", [{}])
  expect(photos.map((photo) => photo.file_name)).toEqual(
    expect.arrayContaining([
      "info.jpg",
      "duplicate-one.png",
      "duplicate-two.png",
      "watched-startup.png"
    ])
  )
  expect(photos.map((photo) => photo.file_name)).toContain("tone.mp4")
  expect(photos.map((photo) => photo.file_name)).not.toContain("ignored.mp3")
  expect(photos.map((photo) => photo.file_name)).not.toContain("audio-only.mp4")
  expect(
    photos.find((photo) => photo.file_name === "watched-startup.png").file_path
  ).toBe(path.join(backend.watchedFolder, "watched-startup.png"))

  await page.goto(`${appUrl}#photos`)
  await expect(
    page.getByRole("img", { name: "watched-startup.png" })
  ).toBeVisible()
  await expect(page.getByTitle("Browse by month")).toBeVisible()
  await expect(page.getByText(/Duplicated \(\d+\)/)).toBeVisible()
  await expect(page.getByText(/Not found pictures \(\d+\)/)).toBeVisible()
  await expect(page.getByText(/No EXIF date \(\d+\)/)).toBeVisible()

  await page.goto(`${appUrl}#settings`)
  await expect(page.getByText("watched", { exact: true })).toBeVisible()
  await expect(
    page.getByText(backend.watchedFolder, { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Watching", { exact: true }).first()
  ).toBeVisible()
  await expect(page.getByText(/Last scan: [\d,]+ indexed/)).toBeVisible()
  await expect(
    page.getByText(/[\d,]+ indexed/, { exact: true }).first()
  ).toBeVisible()
})

test("overview grids request sized derivatives instead of originals", async ({
  page
}) => {
  const variants = []
  page.on("request", (request) => {
    const match = /\/media\/\d+(?:\/(thumb|micro|year|stream))?(?:\?|$)/.exec(
      request.url()
    )
    if (match) variants.push(match[1] || "original")
  })
  const renderedVariants = async (selector) => {
    const urls = await page
      .locator(`${selector} img, ${selector}[src]`)
      .evaluateAll((images) =>
        images.map((image) => image.currentSrc || image.src).filter(Boolean)
      )
    return urls.flatMap((url) => {
      const match = /\/media\/\d+(?:\/(thumb|micro|year|stream))?(?:\?|$)/.exec(
        url
      )
      return match ? [match[1] || "original"] : []
    })
  }
  const visit = async (route, selector) => {
    variants.length = 0
    await page.goto(`${appUrl}?thumbnail-view=${route}#${route}`)
    await expect(page.locator(selector).first()).toBeVisible()
    const mediaImages = page.locator(`${selector} img, ${selector}[src]`)
    await expect
      .poll(async () => (await renderedVariants(selector)).length)
      .toBeGreaterThan(0)
    await expect
      .poll(() =>
        mediaImages.evaluateAll((images) =>
          images.some((image) => image.complete && image.naturalWidth > 0)
        )
      )
      .toBe(true)
    const visibleVariants = await renderedVariants(selector)
    expect(variants).not.toContain("original")
    expect(variants).not.toContain("stream")
    expect(visibleVariants).not.toContain("original")
    expect(visibleVariants).not.toContain("stream")
    return visibleVariants
  }

  expect(await visit("today", ".message__instax-image")).toContain("thumb")

  await backend.rpc("settings:set", ["auto_photo_in_week_overview", "true"])
  let yearVariants
  try {
    const weekVariants = await visit("week", ".week-view")
    expect(weekVariants).toContain("thumb")
    variants.length = 0
    await page.getByTitle("Show full view").click()
    await expect
      .poll(
        async () =>
          (await renderedVariants(".week-view__photo-thumb")).includes("thumb"),
        { timeout: 10_000 }
      )
      .toBe(true)
    expect(variants).not.toContain("original")

    yearVariants = await visit("year", ".year-view")
  } finally {
    await backend.rpc("settings:set", ["auto_photo_in_week_overview", "false"])
  }

  expect(yearVariants).toContain("thumb")
  expect(await visit("photos", ".records-layout")).toContain("thumb")
  await expect(page.locator(".records__thumb").first()).toHaveAttribute(
    "src",
    /[?&]rev=/
  )

  variants.length = 0
  await page.goto(`${appUrl}?thumbnail-view=map#map`)
  const noGpsToggle = page.getByTitle("Toggle no-GPS photos (G)")
  await expect(noGpsToggle).toBeVisible()
  await expect(page.locator(".no-gps-drawer")).toHaveClass(
    /no-gps-drawer--open/
  )
  await expect(
    page.locator(".no-gps-drawer__strip img").first()
  ).toHaveAttribute("src", /\/media\/\d+\/thumb(?:\?|$)/)
  await expect(
    page.locator(".no-gps-drawer__strip img").first()
  ).toHaveJSProperty("complete", true)
  expect(
    await page
      .locator(".no-gps-drawer__strip img")
      .first()
      .evaluate((image) => image.naturalWidth)
  ).toBeGreaterThan(0)
  expect(variants).not.toContain("original")
  expect(variants).not.toContain("stream")
})

test("photo notes preserve UTF-8 captions and colors", async ({ page }) => {
  const photo = (await backend.rpc("attachments:list-all", [{}])).find(
    (attachment) => attachment.file_name === "info.jpg"
  )
  expect(photo).toBeTruthy()

  await page.goto(`${appUrl}#today`)
  const card = page.locator(".message--media", {
    has: page.getByRole("img", { name: "info.jpg" })
  })
  const nextPhotoUpdate = () =>
    page.waitForResponse((response) => {
      const request = response.request()
      return (
        response.url().endsWith("/rpc") &&
        request.method() === "POST" &&
        request.postDataJSON().method === "attachments:update" &&
        request.postDataJSON().args?.[0] === photo.id
      )
    })

  const caption = "Tohle potřebují koupit nové"
  await card.locator(".message__instax-bottom").click()
  await card.getByPlaceholder("Write a note...").fill(caption)
  const [captionResponse] = await Promise.all([
    nextPhotoUpdate(),
    card.getByPlaceholder("Write a note...").press("Control+Enter")
  ])
  expect(captionResponse.ok()).toBe(true)
  await expect(card.getByText(caption, { exact: true })).toBeVisible()

  const frame = card.locator(".message__instax")
  const originalFrameColor = await frame.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  )
  const [colorResponse] = await Promise.all([
    nextPhotoUpdate(),
    card.getByRole("button", { name: "Set note color to mint" }).click()
  ])
  expect(colorResponse.ok()).toBe(true)
  await expect(
    card.getByRole("button", { name: "Set note color to mint" })
  ).toHaveClass(/sticky-note__swatch--active/)
  await expect(frame).toHaveClass(/message__instax--mint/)
  await expect
    .poll(() =>
      frame.evaluate((element) => getComputedStyle(element).backgroundColor)
    )
    .not.toBe(originalFrameColor)

  await expect
    .poll(async () => {
      const attachments = await backend.rpc("attachments:list-all", [{}])
      return attachments.find((attachment) => attachment.id === photo.id)
    })
    .toMatchObject({
      message_content: caption,
      metadata: { note_style: { color: "mint" } }
    })
})

async function embeddedAudioVideoWorkflow({ page }) {
  const video = (await backend.rpc("attachments:list-all", [{}])).find(
    (attachment) => attachment.file_name === "tone.mp4"
  )
  expect(video).toBeTruthy()

  const ranged = await fetch(new URL(`media/${video.id}/stream`, appUrl), {
    headers: { Range: "bytes=0-63" }
  })
  expect(ranged.status).toBe(206)
  expect(ranged.headers.get("content-type")).toBe("video/mp4")
  expect((await ranged.arrayBuffer()).byteLength).toBe(64)

  await page.goto(`${appUrl}#today`)
  const card = page.locator(".message--media", {
    has: page.getByRole("img", { name: "tone.mp4" })
  })
  await expect(card).toBeVisible()
  const nextVideoUpdate = () =>
    page.waitForResponse((response) => {
      const request = response.request()
      return (
        response.url().endsWith("/rpc") &&
        request.method() === "POST" &&
        request.postDataJSON().method === "attachments:update"
      )
    })
  await card.locator(".message__instax-bottom").click()
  await card.getByPlaceholder("Write a note...").fill("Browser video caption")
  await Promise.all([
    nextVideoUpdate(),
    card.getByPlaceholder("Write a note...").press("Control+Enter")
  ])
  await Promise.all([
    nextVideoUpdate(),
    card.getByRole("button", { name: "Mark important" }).click()
  ])
  const colorUpdates = []
  const recordColorUpdate = (request) => {
    if (!request.url().endsWith("/rpc") || request.method() !== "POST") return
    const payload = request.postDataJSON()
    if (
      payload.method === "attachments:update" &&
      payload.args?.[1]?.noteColor === "sky"
    ) {
      colorUpdates.push(request)
    }
  }
  page.on("request", recordColorUpdate)
  await Promise.all([
    nextVideoUpdate(),
    card.getByRole("button", { name: "Set note color to sky" }).click()
  ])
  await expect(
    card.getByRole("button", { name: "Set note color to sky" })
  ).toHaveClass(/sticky-note__swatch--active/)
  await page.waitForTimeout(100)
  page.off("request", recordColorUpdate)
  expect(colorUpdates).toHaveLength(1)

  await card.getByRole("img", { name: "tone.mp4" }).click()
  const player = page.locator("video.photos-lightbox__video")
  await expect(player).toBeVisible()
  await expect
    .poll(() => player.evaluate((element) => element.readyState))
    .toBeGreaterThanOrEqual(1)
  await player.evaluate((element) => element.play())
  await expect
    .poll(() => player.evaluate((element) => element.currentTime))
    .toBeGreaterThan(0)

  await page.getByRole("button", { name: "Media info" }).click()
  const infoPanel = page.locator(".photo-info-panel")
  await expect(
    infoPanel.getByRole("heading", { name: "Media Info" })
  ).toBeVisible()
  await expect(infoPanel.getByLabel("Make")).toHaveCount(0)
  await expect(infoPanel.getByLabel("Latitude")).toHaveCount(0)
  await infoPanel.getByRole("button", { name: "Edit date taken date" }).click()
  await page.locator('.compact-date-picker__day[aria-selected="true"]').click()
  const infoUpdate = page.waitForRequest((request) => {
    if (!request.url().endsWith("/rpc") || request.method() !== "POST") {
      return false
    }
    return request.postDataJSON().method === "attachments:update"
  })
  await infoPanel.getByRole("button", { name: "Save" }).click()
  expect((await infoUpdate).postDataJSON().args[1]).toEqual({
    createdAt: expect.any(String)
  })
  await infoPanel.getByRole("button", { name: "Close panel" }).click()

  await expect
    .poll(async () => {
      const messages = await backend.rpc("messages:list", [video.day_id])
      return messages.find((message) => message.id === video.id)
    })
    .toMatchObject({
      content: /^Browser video caption\s*$/,
      metadata: { important: true, note_style: { color: "sky" } }
    })
  await page.waitForTimeout(500)
}

test("Media Info sends only supported photo metadata and exposes validation errors", async ({
  page
}) => {
  await page.goto(`${appUrl}#photos`)
  await page.getByRole("img", { name: "info.jpg" }).click()
  await page.getByRole("button", { name: "Media info" }).click()

  const panel = page.locator(".photo-info-panel")
  await expect(panel.getByRole("heading", { name: "Media Info" })).toBeVisible()
  await expect(panel.getByLabel("Caption")).toHaveCount(0)
  await expect(panel.getByLabel("Visibility")).toHaveCount(0)
  await expect(panel.getByLabel("Tags")).toHaveCount(0)

  await panel.getByLabel("Make").fill("Browser Camera")
  await panel.getByLabel("Model").fill("Contract 1")
  await panel.getByLabel("Latitude").fill("50.087")
  await panel.getByRole("button", { name: "Save" }).click()
  await expect(panel.getByRole("alert")).toHaveText(
    "Enter both latitude and longitude, or leave both blank."
  )

  await panel.getByLabel("Longitude").fill("14.421")
  const updateResponse = page.waitForResponse((response) => {
    const request = response.request()
    if (!response.url().endsWith("/rpc") || request.method() !== "POST") {
      return false
    }
    return request.postDataJSON().method === "attachments:update"
  })
  await panel.getByRole("button", { name: "Save" }).click()
  const response = await updateResponse
  const responsePayload = await response.json()
  const payload = response.request().postDataJSON()

  expect(payload.args[1]).toMatchObject({
    Make: "Browser Camera",
    Model: "Contract 1",
    latitude: 50.087,
    longitude: 14.421
  })
  expect(Object.keys(payload.args[1]).sort()).toEqual(
    ["Make", "Model", "createdAt", "latitude", "longitude"].sort()
  )
  if (response.ok()) {
    await expect(panel.getByRole("button", { name: "Save" })).toBeDisabled()
    await expect(panel.getByRole("alert")).toHaveCount(0)
    const saved = await backend.rpc("attachments:get", [payload.args[0]])
    expect(saved).toMatchObject({ latitude: 50.087, longitude: 14.421 })
    expect(saved.exif_data).toMatchObject({
      Make: "Browser Camera",
      Model: "Contract 1"
    })
  } else {
    expect(responsePayload.error).toBeTruthy()
    await expect(panel.getByRole("alert")).toHaveText(responsePayload.error)
    await expect(panel.getByRole("button", { name: "Save" })).toBeEnabled()
  }
})

test(
  "embedded-audio video displays, streams by range, plays, and edits durable metadata",
  embeddedAudioVideoWorkflow
)

test("duplicate actions use returned checksum and messageId without retired scan RPC", async ({
  page
}) => {
  const [group] = await backend.rpc("attachments:list-duplicate-groups")
  expect(group.members).toHaveLength(2)
  const nextCanonical = group.members.find(
    (member) => member.fileName === "duplicate-two.png"
  )
  const toDelete = group.members.find(
    (member) => member.fileName === "duplicate-one.png"
  )
  const calls = []
  page.on("request", (request) => {
    if (!request.url().endsWith("/rpc") || request.method() !== "POST") return
    calls.push(request.postDataJSON())
  })

  await page.goto(`${appUrl}#photos`)
  await page.getByRole("button", { name: `Duplicated (1)` }).click()
  const secondCopy = page
    .locator(".records__dup-copy")
    .filter({ hasText: "duplicate-two.png" })
  await secondCopy.getByRole("button", { name: "Set default" }).click()

  await expect
    .poll(async () => {
      const [updated] = await backend.rpc("attachments:list-duplicate-groups")
      return updated.canonicalAttachmentId
    })
    .toBe(nextCanonical.attachmentId)
  expect(
    calls.find((call) => call.method === "attachments:set-duplicate-canonical")
      .args
  ).toEqual([group.checksum, nextCanonical.attachmentId])

  const firstCopy = page
    .locator(".records__dup-copy")
    .filter({ hasText: "duplicate-one.png" })
  await expect(firstCopy.getByRole("button", { name: "Delete" })).toBeEnabled()
  const deleteResponse = page.waitForResponse((response) => {
    const request = response.request()
    if (!response.url().endsWith("/rpc") || request.method() !== "POST") {
      return false
    }
    return request.postDataJSON().method === "messages:delete"
  })
  await firstCopy.getByRole("button", { name: "Delete" }).click()
  await expect(page.getByRole("alertdialog")).toContainText(
    "Move this duplicate to Trash?"
  )
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "OK" })
    .click()
  const response = await deleteResponse
  expect(response.ok(), await response.text()).toBe(true)
  expect(response.request().postDataJSON().args).toEqual([toDelete.messageId])

  await expect
    .poll(async () => backend.rpc("attachments:list-duplicate-groups"))
    .toEqual([])
  expect(calls.map((call) => call.method)).not.toContain(
    "attachments:remove-scan-duplicate"
  )
})

test("revealed NSFW media has a clickable hide control", async ({ page }) => {
  const photo = (await backend.rpc("attachments:list-all", [{}])).find(
    (attachment) => attachment.file_name === "info.jpg"
  )
  await backend.rpc("settings:set", ["nsfw_mode", "blurred"])
  await backend.rpc("messages:set-visibility", [photo.id, "test"])

  await page.goto(`${appUrl}#today`)
  const card = page.locator(".message--media", {
    has: page.getByRole("img", { name: "info.jpg" })
  })
  const overlay = card.locator(".nsfw-overlay")
  await expect(overlay.getByText("Click to reveal")).toBeVisible()
  await overlay.click()

  const hide = overlay.getByRole("button", { name: "Hide" })
  await expect(hide).toBeVisible()
  await expect(hide).toBeEnabled()
  await hide.click()
  await expect(overlay.getByText("Click to reveal")).toBeVisible()
})

test("a stale memory-day response cannot replace the selected day", async ({
  page
}) => {
  const monthlyDate = (monthsAgo) => {
    const target = new Date()
    const total =
      target.getUTCFullYear() * 12 + target.getUTCMonth() - monthsAgo
    const year = Math.floor(total / 12)
    const month = total % 12
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    const day = Math.min(target.getUTCDate(), lastDay)
    return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10)
  }
  const oneMonthAgo = monthlyDate(1)
  const twoMonthsAgo = monthlyDate(2)
  const attachments = await backend.rpc("attachments:list-all", [{}])
  const photo = attachments.find(
    (attachment) => attachment.file_name === "info.jpg"
  )
  const video = attachments.find(
    (attachment) => attachment.file_name === "tone.mp4"
  )
  await backend.rpc("settings:set", ["nsfw_mode", "visible"])
  await backend.rpc("attachments:update", [
    photo.id,
    { createdAt: `${oneMonthAgo}T12:00:00.000Z`, important: false }
  ])
  await backend.rpc("attachments:update", [
    video.id,
    { createdAt: `${twoMonthsAgo}T12:00:00.000Z`, important: true }
  ])

  let releaseOldRequest
  let oldRequestBlocked = false
  const oldRequestGate = new Promise((resolve) => {
    releaseOldRequest = resolve
  })
  await page.route("**/rpc", async (route) => {
    const body = route.request().postDataJSON()
    if (
      !oldRequestBlocked &&
      body.method === "messages:list" &&
      body.args?.[0] === oneMonthAgo
    ) {
      oldRequestBlocked = true
      await oldRequestGate
    }
    await route.continue()
  })

  await page.goto(`${appUrl}#on-this-day`)
  await expect(
    page.locator(".on-this-day__card", { hasText: "2M" }).locator("img")
  ).toHaveAttribute("src", new RegExp(`/media/${video.id}/thumb`))
  await page.getByRole("button", { name: /^1M,/ }).click()
  await expect.poll(() => oldRequestBlocked).toBe(true)
  await page.locator(".memory-cards__card", { hasText: "2M" }).click()
  await expect(
    page.locator(".memory-cards__card--active", { hasText: "2M" })
  ).toBeVisible()
  await expect(page.getByRole("img", { name: "tone.mp4" })).toBeVisible()

  releaseOldRequest()
  await page.waitForTimeout(100)
  await expect(page.getByRole("img", { name: "tone.mp4" })).toBeVisible()
  await expect(page.getByRole("img", { name: "info.jpg" })).toHaveCount(0)
})
