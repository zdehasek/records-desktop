import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

const root = path.dirname(fileURLToPath(import.meta.url))
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
).version

function bundleName(name) {
  return name
    .replace(/(^|\/)node_modules\//g, "$1vendor/")
    .replace(/^frontend\//, "app/")
}

export default defineConfig({
  root: path.join(root, "frontend", "src"),
  base: "./",
  define: {
    "globalThis.__RECORDS_VERSION__": JSON.stringify(packageVersion)
  },
  plugins: [solid()],
  resolve: {
    alias: [
      {
        find: /^maplibre-gl$/,
        replacement: path.join(
          root,
          "node_modules",
          "maplibre-gl",
          "src",
          "index.ts"
        )
      }
    ]
  },
  server: {
    host: "127.0.0.1",
    port: 43817,
    strictPort: true
  },
  build: {
    outDir: path.join(root, "frontend", "dist"),
    emptyOutDir: true,
    rollupOptions: {
      preserveEntrySignatures: "strict",
      output: {
        preserveModules: true,
        preserveModulesRoot: root,
        entryFileNames: (chunk) => {
          return `assets/${bundleName(chunk.name)}-[hash].js`
        },
        assetFileNames: (asset) => {
          const name = bundleName(asset.names[0])
          const extension = path.posix.extname(name)
          const stem = extension ? name.slice(0, -extension.length) : name
          return `assets/${stem}-[hash][extname]`
        }
      }
    }
  }
})
