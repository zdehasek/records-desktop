import path from "node:path"
import { URL } from "node:url"

export const READY_PREFIX = "RECORDS_READY "
export const READY_TYPE = "records:ready"
export const HOST_REQUEST_TYPE = "records:host-request"
export const HOST_RESPONSE_TYPE = "records:host-response"

const ROUTES = new Set([
  "today",
  "week",
  "year",
  "photos",
  "map",
  "on-this-day",
  "on-this-day-story",
  "settings"
])

function record(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value
}

function string(value, name, maximum = 500) {
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function exactArguments(value, length) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`Host request requires ${length} arguments`)
  }
  return value
}

function absolutePath(value) {
  const filePath = string(value, "Native path", 4096)
  if (!path.isAbsolute(filePath) || filePath.includes("\0")) {
    throw new Error("Native path must be absolute")
  }
  return path.normalize(filePath)
}

export function validateRoute(value, fallback = "today") {
  return ROUTES.has(value) ? value : fallback
}

export function routeFromArguments(argv = []) {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const value = argv[index]
    if (ROUTES.has(value)) return value
  }
  return null
}

export function validateReadyMessage(value, expectedToken) {
  const message = record(value, "Readiness message")
  if (message.type !== undefined && message.type !== READY_TYPE) {
    throw new Error("Backend returned an invalid readiness message")
  }
  const url = new URL(string(message.url, "Readiness URL", 2048))
  const expectedPath = `/${string(expectedToken, "Backend token", 128)}/`
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== expectedPath
  ) {
    throw new Error("Backend returned an invalid private URL")
  }

  const profile = record(message.profile, "Backend profile")
  const id = string(profile.id, "Profile ID", 32)
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
    throw new Error("Backend returned an invalid profile ID")
  }
  return {
    url: url.href,
    profile: { id, name: string(profile.name, "Profile name", 200) }
  }
}

export function parseReadyLine(line, expectedToken) {
  if (typeof line !== "string" || !line.startsWith(READY_PREFIX)) return null
  try {
    return validateReadyMessage(
      JSON.parse(line.slice(READY_PREFIX.length)),
      expectedToken
    )
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Backend returned malformed readiness JSON")
    }
    throw error
  }
}

export function validateHostRequest(value) {
  const request = record(value, "Host request")
  if (
    request.type !== HOST_REQUEST_TYPE ||
    !Number.isSafeInteger(request.id) ||
    request.id < 1
  ) {
    throw new TypeError("Host request has an invalid type or ID")
  }
  const base = { type: HOST_REQUEST_TYPE, id: request.id }
  switch (request.method) {
    case "chooseFile":
    case "chooseFolder":
      exactArguments(request.args, 0)
      return { ...base, method: request.method, args: [] }
    case "moveToTrash":
    case "openFile":
    case "revealFile": {
      const args = exactArguments(request.args, 1)
      return { ...base, method: request.method, args: [absolutePath(args[0])] }
    }
    case "sendNotification": {
      const notification = record(
        exactArguments(request.args, 1)[0],
        "Notification"
      )
      if (!ROUTES.has(notification.route)) {
        throw new Error("Notification route is not allowed")
      }
      return {
        ...base,
        method: request.method,
        args: [
          {
            title: string(notification.title, "Notification title", 120),
            body: string(notification.body, "Notification body", 500),
            route: notification.route
          }
        ]
      }
    }
    default:
      throw new Error("Unknown host method")
  }
}
