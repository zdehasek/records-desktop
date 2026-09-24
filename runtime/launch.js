import { spawn } from "node:child_process"
import fs from "node:fs"
import { profileDataDirectory, validateProfileId } from "./src/profiles.js"

const [appUrl, route = "today", requestedProfile] = process.argv.slice(2)
let parsedAppUrl
try {
  parsedAppUrl = new URL(appUrl)
} catch {
  // Handled by the validation below.
}
if (
  !parsedAppUrl ||
  parsedAppUrl.protocol !== "http:" ||
  parsedAppUrl.hostname !== "127.0.0.1" ||
  !/^\d+$/.test(parsedAppUrl.port) ||
  Number(parsedAppUrl.port) < 1 ||
  Number(parsedAppUrl.port) > 65535 ||
  parsedAppUrl.username ||
  parsedAppUrl.password ||
  !/^\/[a-f0-9]{64}\/$/.test(parsedAppUrl.pathname) ||
  parsedAppUrl.search ||
  parsedAppUrl.hash
) {
  process.stderr.write("Records launcher received an invalid app URL\n")
  process.exit(1)
}

let profileId
try {
  profileId = validateProfileId(requestedProfile)
} catch (error) {
  process.stderr.write(
    `Records launcher received an invalid profile: ${error.message}\n`
  )
  process.exit(1)
}
const profileDirectory = `${profileDataDirectory(profileId)}/chromium-profile`
process.umask(0o077)
fs.mkdirSync(profileDirectory, { recursive: true, mode: 0o700 })
fs.chmodSync(profileDirectory, 0o700)

const child = spawn(
  "chromium",
  [
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--class=records",
    `--app=${appUrl}#${encodeURIComponent(route)}`
  ],
  {
    detached: true,
    stdio: "ignore"
  }
)

child.once("error", (error) => {
  process.stderr.write(`Records could not launch Chromium: ${error.message}\n`)
  process.exitCode = 1
})
child.once("spawn", () => child.unref())
