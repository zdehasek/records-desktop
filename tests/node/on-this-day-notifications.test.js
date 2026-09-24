import assert from "node:assert/strict"
import test from "node:test"
import { createOnThisDayNotifications } from "../../runtime/src/services/on-this-day-notifications.js"

function setup(options = {}) {
  const settings = new Map(Object.entries(options.settings || {}))
  const notifications = []
  const memoryCalls = []
  const config = {
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => settings.set(key, value)
  }
  const service = createOnThisDayNotifications({
    config,
    now: () => options.now || new Date(2026, 8, 17, 9, 0),
    memoryDays: async (date, visibility) => {
      memoryCalls.push({ date, visibility })
      return options.memories ?? [{ date: "2025-09-17" }]
    },
    notify: async () => {
      if (options.notifyError) throw options.notifyError
      notifications.push(true)
    },
    logger: { warn: () => {} }
  })
  return { config, memoryCalls, notifications, service, settings }
}

test("notifies once after the configured local time when memories exist", async () => {
  const current = setup()

  assert.equal(await current.service.check(), true)
  assert.equal(await current.service.check(), false)
  assert.equal(current.notifications.length, 1)
  assert.equal(current.settings.get("on_this_day_last_notified"), "2026-09-17")
  assert.deepEqual(current.memoryCalls[0], {
    date: "2026-09-17",
    visibility: { nsfwMode: "hidden", dotFilesVisible: false }
  })
})

test("respects disabled reminders and a later configured time", async () => {
  const disabled = setup({ settings: { on_this_day_notifications: "false" } })
  assert.equal(await disabled.service.check(), false)
  assert.equal(disabled.memoryCalls.length, 0)

  const early = setup({
    now: new Date(2026, 8, 17, 8, 59),
    settings: { on_this_day_notification_time: "09:00" }
  })
  assert.equal(await early.service.check(), false)
  assert.equal(early.memoryCalls.length, 0)
})

test("does not notify or mark the date when there are no memories", async () => {
  const current = setup({ memories: [] })

  assert.equal(await current.service.check(), false)
  assert.equal(current.notifications.length, 0)
  assert.equal(current.settings.has("on_this_day_last_notified"), false)
})

test("retries after notification delivery fails", async () => {
  const current = setup({ notifyError: new Error("not available") })

  assert.equal(await current.service.check(), false)
  assert.equal(current.settings.has("on_this_day_last_notified"), false)
})

test("start checks immediately and stop clears the minute timer", async () => {
  let callback
  let cleared = null
  const current = setup()
  const service = createOnThisDayNotifications({
    config: current.config,
    now: () => new Date(2026, 8, 17, 9, 0),
    memoryDays: async () => [],
    notify: async () => {},
    setIntervalFn: (next) => {
      callback = next
      return 42
    },
    clearIntervalFn: (value) => {
      cleared = value
    }
  })

  service.start()
  assert.equal(typeof callback, "function")
  service.stop()
  assert.equal(cleared, 42)
})
