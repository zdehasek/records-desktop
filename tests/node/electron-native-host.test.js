import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createNativeHost } from "../../desktop/electron/native-host.js"
import { HOST_REQUEST_TYPE } from "../../desktop/electron/protocol.js"

function request(id, method, args = []) {
  return { type: HOST_REQUEST_TYPE, id, method, args }
}

test("native host dispatches dialogs, shell operations, and notifications", async () => {
  const calls = []
  const dialogResults = [
    { canceled: true, filePaths: [] },
    { canceled: false, filePaths: ["/tmp/media"] }
  ]
  class FakeNotification extends EventEmitter {
    constructor(options) {
      super()
      calls.push(["notification", options])
    }
    show() {
      this.emit("click")
    }
  }
  const handler = createNativeHost({
    dialog: {
      showOpenDialog: async (options) => {
        calls.push(["dialog", options.properties])
        return dialogResults.shift()
      }
    },
    shell: {
      trashItem: async (filePath) => calls.push(["trash", filePath]),
      openPath: async (filePath) => {
        calls.push(["open", filePath])
        return ""
      },
      showItemInFolder: (filePath) => calls.push(["reveal", filePath])
    },
    Notification: FakeNotification,
    focusRoute: (route) => calls.push(["route", route])
  })

  assert.equal(await handler(request(1, "chooseFile")), null)
  assert.equal(await handler(request(2, "chooseFolder")), "/tmp/media")
  await handler(request(3, "moveToTrash", ["/tmp/photo.jpg"]))
  await handler(request(4, "openFile", ["/tmp/photo.jpg"]))
  await handler(request(5, "revealFile", ["/tmp/photo.jpg"]))
  await handler(
    request(6, "sendNotification", [
      { title: "Memory", body: "Open it", route: "on-this-day-story" }
    ])
  )
  assert.deepEqual(
    calls.filter(([name]) => name === "route"),
    [["route", "on-this-day-story"]]
  )
})

test("native host surfaces shell open errors", async () => {
  const handler = createNativeHost({
    dialog: {},
    shell: { openPath: async () => "No application can open this file" },
    Notification: class {},
    focusRoute() {}
  })
  await assert.rejects(
    handler(request(1, "openFile", ["/tmp/photo.jpg"])),
    /No application/
  )
})
