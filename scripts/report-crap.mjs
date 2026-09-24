import { ESLint } from "eslint"
import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const coveragePath = path.join(root, "coverage", "coverage-final.json")
const WARN_THRESHOLD = 15
const FAIL_THRESHOLD = 20
const HIGH_COMPLEXITY = 15
const LOW_COVERAGE = 50

function functionHits(fileCoverage, index) {
  const hits = fileCoverage.f?.[index]
  if (typeof hits === "number") return hits
  if (!hits || typeof hits !== "object") return 0
  return Object.values(hits).reduce((sum, value) => sum + Number(value || 0), 0)
}

function rangeContains(outer, inner) {
  if (!outer || !inner) return false
  const startsAfter =
    inner.start.line > outer.start.line ||
    (inner.start.line === outer.start.line &&
      inner.start.column >= outer.start.column)
  const endsBefore =
    inner.end.line < outer.end.line ||
    (inner.end.line === outer.end.line && inner.end.column <= outer.end.column)
  return startsAfter && endsBefore
}

function statementCoverage(fileCoverage, location, hits) {
  const statements = Object.entries(fileCoverage.statementMap || {})
    .map(([index, loc]) => ({ loc, hits: fileCoverage.s?.[index] ?? 0 }))
    .filter((statement) => rangeContains(location, statement.loc))
  if (statements.length === 0) return hits > 0 ? 100 : 0
  return (
    (statements.filter((statement) => statement.hits > 0).length /
      statements.length) *
    100
  )
}

function findCoverageFunction(fileCoverage, line, column) {
  const functions = Object.entries(fileCoverage.fnMap || {})
  const exact = functions.find(([, metadata]) => {
    const location = metadata.decl || metadata.loc
    return location?.start.line === line && location.start.column === column
  })
  if (exact) return exact
  return functions
    .filter(([, metadata]) => {
      const location = metadata.decl || metadata.loc
      return location?.start.line === line
    })
    .sort((left, right) => {
      const leftColumn = (left[1].decl || left[1].loc)?.start.column ?? 0
      const rightColumn = (right[1].decl || right[1].loc)?.start.column ?? 0
      return Math.abs(leftColumn - column) - Math.abs(rightColumn - column)
    })[0]
}

if (!fs.existsSync(coveragePath)) {
  console.error("Missing coverage data. Run `npm run test:coverage` first.")
  process.exit(1)
}

const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8"))
const eslint = new ESLint({
  overrideConfigFile: path.join(root, "eslint.config.mjs"),
  overrideConfig: [
    {
      files: ["runtime/**/*.js"],
      rules: { complexity: ["warn", 0] }
    }
  ]
})

const lintResults = await eslint.lintFiles(["runtime/**/*.js"])
const rows = []
const missingCoverage = []

for (const result of lintResults) {
  const fileCoverage = coverage[result.filePath]
  if (!fileCoverage) {
    missingCoverage.push(path.relative(root, result.filePath))
    continue
  }
  for (const message of result.messages) {
    if (message.ruleId !== "complexity") continue
    const complexity = Number(message.message.match(/complexity of (\d+)/)?.[1])
    if (!Number.isFinite(complexity)) continue
    const column = Math.max((message.column || 1) - 1, 0)
    const match = findCoverageFunction(fileCoverage, message.line, column)
    if (!match) continue
    const [index, metadata] = match
    const location = metadata.loc || metadata.decl
    const coveragePercent = statementCoverage(
      fileCoverage,
      location,
      functionHits(fileCoverage, index)
    )
    const uncovered = 1 - coveragePercent / 100
    const crap = complexity ** 2 * uncovered ** 3 + complexity
    rows.push({
      file: path.relative(root, result.filePath),
      function: metadata.name || "<anonymous>",
      line: message.line,
      complexity,
      coverage: `${coveragePercent}%`,
      crap: Number(crap.toFixed(1))
    })
  }
}

rows.sort((left, right) => right.crap - left.crap)
const warnings = rows.filter((row) => row.crap >= WARN_THRESHOLD).length
const failures = rows.filter(
  (row) =>
    row.crap >= FAIL_THRESHOLD ||
    (row.complexity >= HIGH_COMPLEXITY &&
      Number.parseFloat(row.coverage) < LOW_COVERAGE)
)
console.table(failures)
console.log(`Functions analyzed: ${rows.length}`)
console.log(`Functions at CRAP >= ${WARN_THRESHOLD}: ${warnings}`)
console.log(`Functions failing thresholds: ${failures.length}`)
if (missingCoverage.length > 0) {
  console.error("Runtime files missing coverage entries:")
  for (const file of missingCoverage) console.error(`- ${file}`)
}
if (failures.length > 0 || missingCoverage.length > 0) {
  process.exit(1)
}
