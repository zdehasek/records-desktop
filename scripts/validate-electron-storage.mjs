import fs from "node:fs"
import path from "node:path"

function walk(directory) {
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory())
    return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) return []
    return entry.isDirectory() ? walk(item) : [item]
  })
}

function isContained(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

function containsMarker(file, marker) {
  const contents = fs.readFileSync(file)
  return (
    contents.includes(Buffer.from(marker, "utf8")) ||
    contents.includes(Buffer.from(marker, "utf16le"))
  )
}

export function validateElectronStorage({
  home,
  userData,
  sessionData,
  marker
}) {
  const localState = path.join(userData, "Local State")
  if (!fs.statSync(localState, { throwIfNoEntry: false })?.isFile())
    throw new Error("configured userData has no Chromium Local State file")
  if (fs.statSync(localState).size === 0)
    throw new Error("configured Chromium Local State file is empty")

  const sessionFiles = walk(sessionData).filter(
    (file) => fs.statSync(file).size > 0
  )
  if (!sessionFiles.length)
    throw new Error("configured sessionData contains no Chromium state")

  const markerFiles = walk(home).filter((file) => containsMarker(file, marker))
  if (!markerFiles.length)
    throw new Error("Chromium did not persist the storage smoke marker")
  for (const file of markerFiles) {
    if (!isContained(sessionData, file))
      throw new Error(
        `Chromium storage escaped configured sessionData: ${file}`
      )
  }

  const appSupport = path.join(home, "Library", "Application Support")
  const directArtifacts = new Set([
    "Local State",
    "DevToolsActivePort",
    "Partitions",
    "Default",
    "Local Storage",
    "IndexedDB",
    "Network",
    "Cookies",
    "Code Cache",
    "GPUCache"
  ])
  for (const root of [
    path.join(appSupport, "records"),
    path.join(appSupport, "Records"),
    path.join(appSupport, "records-desktop")
  ]) {
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue
    for (const name of fs.readdirSync(root)) {
      const item = path.join(root, name)
      if (isContained(userData, item)) continue
      if (directArtifacts.has(name))
        throw new Error(
          `default Chromium artifact exists outside userData: ${item}`
        )
    }
  }

  return { localState, markerFiles, sessionFiles }
}
