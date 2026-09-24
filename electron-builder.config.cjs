const process = require("node:process")

const arch = process.env.RECORDS_MAC_ARCH
const signingEnabled = process.env.CSC_IDENTITY_AUTO_DISCOVERY === "true"
if (arch && !["arm64", "x64"].includes(arch)) {
  throw new Error(`Unsupported RECORDS_MAC_ARCH: ${arch}`)
}

module.exports = {
  appId: "io.github.zdehasek.records",
  productName: "Records",
  directories: {
    output: "dist-electron"
  },
  artifactName: "Records-${version}-mac-${arch}.${ext}",
  asar: true,
  files: [
    "package.json",
    "desktop/electron/**/*.js",
    "!desktop/electron/**/*.test.js",
    "!node_modules/**/*"
  ],
  extraResources: [
    {
      from: "runtime",
      to: "runtime",
      filter: ["**/*", "!**/*.test.js"]
    },
    {
      from: "frontend/dist",
      to: "frontend/dist",
      filter: ["**/*"]
    },
    {
      from: `vendor/mac-${arch || "${arch}"}`,
      to: "vendor",
      filter: ["**/*"]
    },
    "manifest.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md"
  ],
  mac: {
    category: "public.app-category.photography",
    icon: "assets/icons/icon.icns",
    minimumSystemVersion: "13.0",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    preAutoEntitlements: false,
    identity: signingEnabled ? undefined : null,
    notarize: signingEnabled ? undefined : false,
    sign: signingEnabled ? "./scripts/sign-macos.cjs" : null,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    target: ["dmg", "zip"]
  },
  dmg: {
    sign: false
  }
}
