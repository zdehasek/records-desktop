import { runCommand } from "../../host-tools.js"
import { platform as selectedPlatform } from "../../platform.js"

const DEFAULT_TIME = "09:00"
const CHECK_INTERVAL_MS = 60_000

function localDate(now) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function minutesSinceMidnight(now) {
  return now.getHours() * 60 + now.getMinutes()
}

function notificationMinute(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || "")
  if (!match) return 9 * 60
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return 9 * 60
  return hours * 60 + minutes
}

export async function sendOnThisDayNotification(command) {
  if (!command) throw new Error("Omarchy notifications are unavailable")
  await runCommand(command, [
    "--app-name",
    "Records",
    "A memory is waiting",
    "See what happened around this day in the past.",
    "--exec",
    "omarchy-shell",
    "records",
    "open",
    "on-this-day-story"
  ])
}

export function createOnThisDayNotifications(options) {
  const {
    config,
    memoryDays,
    notificationCommand,
    platform = selectedPlatform,
    notify = notificationCommand === undefined
      ? () =>
          platform.sendNotification({
            title: "A memory is waiting",
            body: "See what happened around this day in the past.",
            route: "on-this-day-story"
          })
      : () => sendOnThisDayNotification(notificationCommand),
    now = () => new Date(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    logger = console
  } = options
  let interval = null
  let checking = false

  const check = async () => {
    if (checking) return false
    if (
      (config.getSetting("on_this_day_notifications") ?? "true") === "false"
    ) {
      return false
    }

    const current = now()
    const today = localDate(current)
    const targetMinute = notificationMinute(
      config.getSetting("on_this_day_notification_time") || DEFAULT_TIME
    )
    if (minutesSinceMidnight(current) < targetMinute) return false
    if (config.getSetting("on_this_day_last_notified") === today) return false

    checking = true
    try {
      const memories = await memoryDays(today, {
        nsfwMode: "hidden",
        dotFilesVisible: false
      })
      if (!memories.length) return false
      await notify()
      config.setSetting("on_this_day_last_notified", today)
      return true
    } catch (error) {
      logger.warn?.(`[on-this-day] Notification failed: ${error.message}`)
      return false
    } finally {
      checking = false
    }
  }

  const start = () => {
    if (interval) return
    void check()
    interval = setIntervalFn(() => void check(), CHECK_INTERVAL_MS)
    interval?.unref?.()
  }

  const stop = () => {
    if (!interval) return
    clearIntervalFn(interval)
    interval = null
  }

  return { check, start, stop }
}
