import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"
import {
  parseBooleanEntitlements,
  validateEntitlementFiles
} from "../../scripts/validate-entitlements.mjs"

const require = createRequire(import.meta.url)
const {
  classifyCodeObject,
  electronEntitlements,
  emptyEntitlements,
  magickEntitlements,
  withScopedEntitlements
} = require("../../scripts/sign-macos.cjs")

test("custom signing applies exact per-object entitlements", () => {
  const calls = []
  const original = (file) => {
    calls.push(file)
    return { entitlements: "inherit.plist", hardenedRuntime: true }
  }
  const app = "/tmp/Records.app"
  const optionsForFile = withScopedEntitlements(original, app)
  const cases = [
    [app, "electron", electronEntitlements],
    [`${app}/Contents/MacOS/Records`, "electron", electronEntitlements],
    [
      `${app}/Contents/Frameworks/Records Helper (Renderer).app/Contents/MacOS/Records Helper (Renderer)`,
      "electron",
      electronEntitlements
    ],
    [
      `${app}/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`,
      "electron",
      electronEntitlements
    ],
    [
      `${app}/Contents/Resources/vendor/bin/magick`,
      "magick",
      magickEntitlements
    ],
    [`${app}/Contents/Resources/vendor/bin/ffmpeg`, "other", emptyEntitlements],
    [
      `${app}/Contents/Resources/vendor/bin/ffprobe`,
      "other",
      emptyEntitlements
    ],
    [
      `${app}/Contents/Resources/vendor/perl/bin/perl`,
      "other",
      emptyEntitlements
    ],
    [
      `${app}/Contents/Resources/vendor/lib/libheif.dylib`,
      "other",
      emptyEntitlements
    ],
    [
      `${app}/Contents/Resources/vendor/lib/libde265.dylib`,
      "other",
      emptyEntitlements
    ],
    [
      `${app}/Contents/Resources/vendor/bin/magick-helper`,
      "other",
      emptyEntitlements
    ],
    [
      `${app}/Contents/Frameworks/Records Helper Evil.app/Contents/MacOS/Evil`,
      "other",
      emptyEntitlements
    ],
    ["/tmp/Other.app/Contents/MacOS/Records", "other", emptyEntitlements]
  ]
  for (const [file, kind, entitlements] of cases) {
    assert.equal(classifyCodeObject(app, file), kind)
    assert.deepEqual(optionsForFile(file), {
      entitlements,
      hardenedRuntime: true
    })
  }
  assert.equal(calls.length, cases.length)

  const windowsApp = "C:\\Apps\\Records.app"
  const windowsMain = `${windowsApp}\\Contents\\MacOS\\Records`
  assert.equal(classifyCodeObject(windowsApp, windowsMain), "electron")
})

test("entitlement plists have exact production scopes", () => {
  assert.equal(validateEntitlementFiles(), 3)
  assert.equal(path.basename(magickEntitlements), "entitlements.magick.plist")
})

test("entitlement parser rejects non-boolean and duplicate values", () => {
  assert.deepEqual(
    parseBooleanEntitlements("<plist><dict><key>a</key><true/></dict></plist>"),
    { a: true }
  )
  assert.throws(() =>
    parseBooleanEntitlements(
      "<plist><dict><key>a</key><true/><key>a</key><false/></dict></plist>"
    )
  )
  assert.throws(() =>
    parseBooleanEntitlements(
      "<plist><dict><key>a</key><string>unsafe</string></dict></plist>"
    )
  )
})
