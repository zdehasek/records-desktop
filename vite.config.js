import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(root, "frontend", "src"),
  base: "./",
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
          const name = chunk.name
            .replace(/^node_modules\//, "vendor/")
            .replace(/^frontend\//, "app/")
          return `assets/${name}-[hash].js`
        }
      }
    }
  }
})
