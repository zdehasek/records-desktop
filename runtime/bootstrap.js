import {
  assertManagedProfileEnvironment,
  rollbackPendingProfile,
  selectRuntimeProfile,
  startupProfileId
} from "./src/profiles.js"

let profileId
try {
  assertManagedProfileEnvironment()
  profileId = startupProfileId()
  selectRuntimeProfile(profileId)
  await import("./server.js")
} catch (error) {
  if (profileId) rollbackPendingProfile(profileId)
  process.stderr.write(`Records could not start profile: ${error.message}\n`)
  process.exitCode = 1
}
