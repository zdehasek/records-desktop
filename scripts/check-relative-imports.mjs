import fs from "node:fs"
import path from "node:path"

const roots = ["frontend/src", "runtime", "scripts", "tests"]
const extensions = ["", ".js", ".jsx", ".cjs", ".mjs"]
const indexExtensions = ["/index.js", "/index.jsx", "/index.cjs", "/index.mjs"]
const files = []

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(fullPath)
    else if (/\.(js|jsx|cjs|mjs)$/.test(entry.name)) files.push(fullPath)
  }
}

for (const root of roots) {
  if (fs.existsSync(root)) walk(root)
}

const importPattern =
  /(?:import\s+[^\n]*?from\s+|import\()(?:"|')([.]{1,2}\/[^"')]+)(?:"|')/g
const missing = []
const deep = []

for (const file of files) {
  const source = fs.readFileSync(file, "utf8")
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1]
    const resolved = path.resolve(path.dirname(file), specifier)
    if (
      ![...extensions, ...indexExtensions].some((suffix) =>
        fs.existsSync(resolved + suffix)
      )
    ) {
      missing.push({ file, specifier })
    } else if (specifier.startsWith("../../../../")) {
      deep.push({ file, specifier })
    }
  }
}

if (missing.length) {
  console.error("Missing relative imports detected:")
  for (const item of missing)
    console.error(`- ${item.file} -> ${item.specifier}`)
  process.exit(1)
}

if (deep.length) {
  console.warn("Deep relative imports (4+ levels) detected:")
  for (const item of deep) console.warn(`- ${item.file} -> ${item.specifier}`)
}

console.log("Relative import check passed")
