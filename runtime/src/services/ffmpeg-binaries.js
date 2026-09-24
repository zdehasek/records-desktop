import fs from "fs"
import path from "path"

const platformName = () => {
  if (process.platform === "darwin") return "mac"
  if (process.platform === "win32") return "win"
  return process.platform
}

const binaryName = (name) => {
  return process.platform === "win32" ? `${name}.exe` : name
}

const vendorDirName = () => `${platformName()}-${process.arch}`

const existingPath = (paths) =>
  paths.find((candidate) => fs.existsSync(candidate))

function vendorCandidates(name) {
  const fileName = binaryName(name)
  const platformDir = vendorDirName()
  const resourceRoot = process.resourcesPath
  const projectRoot = path.resolve(import.meta.dirname, "../..")

  return [
    process.env[`REC_${name.toUpperCase()}_PATH`],
    process.env.REC_FFMPEG_DIR
      ? path.join(process.env.REC_FFMPEG_DIR, fileName)
      : null,
    resourceRoot
      ? path.join(resourceRoot, "vendor", "ffmpeg", platformDir, fileName)
      : null,
    resourceRoot
      ? path.join(
          resourceRoot,
          "app.asar.unpacked",
          "vendor",
          "ffmpeg",
          platformDir,
          fileName
        )
      : null,
    path.join(projectRoot, "vendor", "ffmpeg", platformDir, fileName)
  ].filter(Boolean)
}

export function ffmpegPath() {
  return resolveBinary("ffmpeg")
}

export function ffprobePath() {
  return resolveBinary("ffprobe")
}

function resolveBinary(name) {
  const fileName = binaryName(name)
  const pathCandidates = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, fileName))
  const candidates = [...vendorCandidates(name), ...pathCandidates]
  const resolved = existingPath(candidates)
  if (resolved) return resolved

  throw new Error(
    `Missing ${name} binary. Install it, add ${fileName} under vendor/ffmpeg/${vendorDirName()}/, or set REC_${name.toUpperCase()}_PATH.`
  )
}
