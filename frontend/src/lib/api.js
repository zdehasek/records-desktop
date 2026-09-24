import { createRecordsApi } from "./platform/records-api.js"

const api = createRecordsApi()
let initializationPromise = null

export function getPlatformApi() {
  return api
}

export async function initializePlatformApi() {
  initializationPromise ||= api.system.capabilities().then((capabilities) => {
    Object.assign(api.capabilities, capabilities)
    return api
  })
  return initializationPromise
}

export function getOptionalPlatformApi() {
  try {
    return getPlatformApi()
  } catch {
    return null
  }
}
