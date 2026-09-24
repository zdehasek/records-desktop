import fs from "node:fs"
import path from "node:path"
import { build } from "esbuild"

const root = path.resolve(import.meta.dirname, "..")
const outputDirectory = path.join(root, "runtime", "vendor")

fs.mkdirSync(outputDirectory, { recursive: true })

const entries = {
  chokidar: 'export { watch } from "chokidar"',
  yaml: [
    'export { parseDocument, stringify } from "./node_modules/yaml/browser/index.js"'
  ].join("\n")
}

for (const [dependency, contents] of Object.entries(entries)) {
  await build({
    stdin: {
      contents,
      resolveDir: root,
      sourcefile: `${dependency}-vendor.js`
    },
    outfile: path.join(outputDirectory, `${dependency}.js`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "inline"
  })
}
