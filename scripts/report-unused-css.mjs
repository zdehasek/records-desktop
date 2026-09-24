import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { PurgeCSS } from "purgecss"
import config from "../purgecss.config.js"

const classSelectorPattern = /\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g
const classAttributePattern = /class=\{?[`"']([^`"']+)[`"']\}?/g
const classListKeyPattern = /["']([-_a-zA-Z0-9:]+)["']\s*:/g

async function listFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(filePath)))
    else files.push(filePath)
  }
  return files
}

const contentFiles = [
  ...(await listFiles("frontend/src")),
  ...(await listFiles("tests"))
].filter((file) => /\.(html|js|jsx|mjs)$/.test(file))
const content = await Promise.all(
  contentFiles.map((file) => readFile(file, "utf8").catch(() => ""))
).then((sources) => sources.join("\n"))
const usedClasses = new Set()

console.log(
  "Heuristic CSS candidates only; Solid classList and composed selectors can be false positives."
)

for (const match of content.matchAll(classAttributePattern)) {
  for (const token of match[1].split(/\s+/)) if (token) usedClasses.add(token)
}
for (const match of content.matchAll(classListKeyPattern))
  usedClasses.add(match[1])

const reports = (await new PurgeCSS().purge({ ...config, rejected: true }))
  .map((result) => ({
    file: result.file,
    selectors: [...new Set(result.rejected.map((selector) => selector.trim()))]
      .filter((selector) =>
        [...selector.matchAll(classSelectorPattern)]
          .map((match) => match[1])
          .some((className) => !usedClasses.has(className))
      )
      .sort()
  }))
  .filter((report) => report.selectors.length)

if (!reports.length) {
  console.log("No unused CSS classes found.")
  process.exit(0)
}

for (const report of reports) {
  console.log(`\n${report.file}`)
  for (const selector of report.selectors) console.log(`  ${selector}`)
}
console.log(
  `\nFound ${reports.reduce((sum, report) => sum + report.selectors.length, 0)} selectors for manual review.`
)
