import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(import.meta.dirname, "..")

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
}

export function parseBooleanEntitlements(xml) {
  const dictionary = xml.match(/<dict\b[^>]*>([\s\S]*?)<\/dict>/)?.[1]
  if (dictionary === undefined) {
    if (/<dict\b[^>]*\/>/.test(xml)) return {}
    throw new Error("plist has no dictionary")
  }
  const entitlements = {}
  const item = /<key\b[^>]*>([\s\S]*?)<\/key>\s*<(true|false)\s*\/>/g
  let match
  while ((match = item.exec(dictionary))) {
    const key = decodeXml(match[1].trim())
    if (Object.hasOwn(entitlements, key)) {
      throw new Error(`duplicate entitlement: ${key}`)
    }
    entitlements[key] = match[2] === "true"
  }
  const structure = dictionary
    .replace(item, "")
    .replace(/<!--[^]*?-->/g, "")
    .trim()
  if (structure) throw new Error("plist contains unsupported dictionary values")
  return entitlements
}

export function validateEntitlementFiles(directory = path.join(root, "build")) {
  const allowJit = { "com.apple.security.cs.allow-jit": true }
  const disableLibraryValidation = {
    "com.apple.security.cs.disable-library-validation": true
  }
  const expected = new Map([
    ["entitlements.mac.plist", allowJit],
    ["entitlements.mac.inherit.plist", {}],
    ["entitlements.magick.plist", disableLibraryValidation]
  ])
  for (const [name, wanted] of expected) {
    const actual = parseBooleanEntitlements(
      fs.readFileSync(path.join(directory, name), "utf8")
    )
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      throw new Error(
        `${name}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`
      )
    }
  }
  return expected.size
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const count = validateEntitlementFiles()
  process.stdout.write(
    `Entitlements: ${count} narrowly scoped plists verified\n`
  )
}
