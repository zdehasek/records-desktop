import assert from "node:assert/strict"
import test from "node:test"
import { configureElectronPaths } from "../../desktop/electron/paths.js"

test("Electron paths are stable and independent of the product name", () => {
  const created = []
  const configured = []
  const app = {
    getPath(name) {
      return {
        appData: "/Users/example/Library/Application Support",
        cache: "/Users/example/Library/Caches"
      }[name]
    },
    setPath(name, value) {
      configured.push([name, value])
    },
    getName() {
      return "Renamed Product"
    }
  }

  const paths = configureElectronPaths(app, {
    makeDirectory: (directory, options) => created.push([directory, options])
  })

  assert.deepEqual(paths, {
    configDirectory: "/Users/example/Library/Application Support/records",
    dataDirectory: "/Users/example/Library/Application Support/records",
    cacheDirectory: "/Users/example/Library/Caches/records",
    userDataDirectory:
      "/Users/example/Library/Application Support/records/electron",
    sessionDataDirectory:
      "/Users/example/Library/Application Support/records/electron/session"
  })
  assert.deepEqual(configured, [
    ["userData", paths.userDataDirectory],
    ["sessionData", paths.sessionDataDirectory]
  ])
  assert.equal(created.length, 4)
  for (const [, options] of created) {
    assert.deepEqual(options, { recursive: true, mode: 0o700 })
  }
})
