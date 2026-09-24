const path = require("node:path")
const { signAsync } = require("@electron/osx-sign")

const magickEntitlements = path.resolve(
  path.dirname(require.resolve("../package.json")),
  "build/entitlements.magick.plist"
)
const electronEntitlements = path.resolve(
  path.dirname(require.resolve("../package.json")),
  "build/entitlements.mac.plist"
)
const emptyEntitlements = path.resolve(
  path.dirname(require.resolve("../package.json")),
  "build/entitlements.mac.inherit.plist"
)

function normalize(filePath) {
  return path.posix.normalize(filePath.replaceAll("\\", "/")).replace(/\/$/, "")
}

function classifyCodeObject(appPath, filePath) {
  const app = normalize(appPath)
  const candidate = normalize(filePath)
  if (candidate !== app && !candidate.startsWith(`${app}/`)) return "other"
  const relative = candidate === app ? "." : candidate.slice(app.length + 1)
  if (relative === "Contents/Resources/vendor/bin/magick") return "magick"
  if (
    relative === "." ||
    relative === "Contents/MacOS/Records" ||
    /^Contents\/Frameworks\/Records Helper(?: \((?:GPU|Plugin|Renderer)\))?\.app(?:\/|$)/.test(
      relative
    ) ||
    /^Contents\/Frameworks\/Electron Framework\.framework(?:\/|$)/.test(
      relative
    )
  ) {
    return "electron"
  }
  return "other"
}

function withScopedEntitlements(optionsForFile, appPath) {
  return (filePath) => {
    const options = optionsForFile ? optionsForFile(filePath) : {}
    const kind = classifyCodeObject(appPath, filePath)
    const entitlements =
      kind === "electron"
        ? electronEntitlements
        : kind === "magick"
          ? magickEntitlements
          : emptyEntitlements
    return { ...options, entitlements }
  }
}

async function signMac(configuration) {
  return signAsync({
    ...configuration,
    optionsForFile: withScopedEntitlements(
      configuration.optionsForFile,
      configuration.app
    )
  })
}

module.exports = signMac
module.exports.classifyCodeObject = classifyCodeObject
module.exports.electronEntitlements = electronEntitlements
module.exports.emptyEntitlements = emptyEntitlements
module.exports.magickEntitlements = magickEntitlements
module.exports.withScopedEntitlements = withScopedEntitlements
