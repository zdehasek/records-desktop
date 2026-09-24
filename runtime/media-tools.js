import fs from "node:fs"
import path from "node:path"
import { platform } from "./platform.js"

function platformName() {
  if (process.platform === "darwin") return "mac"
  if (process.platform === "win32") return "win"
  return process.platform
}

function binaryName(name) {
  return process.platform === "win32" ? `${name}.exe` : name
}

function existing(candidates) {
  return candidates
    .filter(Boolean)
    .find((candidate) => fs.existsSync(candidate))
}

function packagedVendorFile(environment, ...parts) {
  const configuredRoot = environment.RECORDS_VENDOR_ROOT
  if (!configuredRoot) return null
  let root
  try {
    root = fs.realpathSync(path.resolve(configuredRoot))
  } catch {
    return null
  }
  const candidate = path.resolve(root, ...parts)
  const prefix = `${root}${path.sep}`
  if (!candidate.startsWith(prefix)) return null
  let stat
  try {
    stat = fs.lstatSync(candidate)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    fs.accessSync(candidate, fs.constants.X_OK)
    const real = fs.realpathSync(candidate)
    if (!real.startsWith(prefix)) return null
  } catch {
    return null
  }
  return candidate
}

function resourceRoots(environment = process.env) {
  const root = environment.RECORDS_RESOURCES_PATH || process.resourcesPath
  if (!root) return []
  return [root, path.join(root, "app.asar.unpacked")]
}

function packagedElectron(environment = process.env) {
  return (
    (environment.RECORDS_HOST || platform.name) === "electron" &&
    ["1", "true"].includes(
      String(environment.RECORDS_PACKAGED || environment.RECORDS_IS_PACKAGED)
    )
  )
}

function descriptor(command, args = [], env, operations) {
  return command
    ? Object.freeze({
        command,
        args,
        ...(env && { env }),
        ...(operations && { operations })
      })
    : null
}

function vendorBinary(name, environment) {
  const fileName = binaryName(name)
  if (packagedElectron(environment)) {
    return packagedVendorFile(environment, "bin", fileName)
  }
  const directory = `${platformName()}-${process.arch}`
  const product = name === "magick" ? "imagemagick" : "ffmpeg"
  return existing(
    resourceRoots(environment).flatMap((root) => [
      path.join(root, "vendor", "bin", fileName),
      path.join(root, "vendor", product, directory, fileName),
      path.join(root, "vendor", product, directory, "bin", fileName)
    ])
  )
}

function developmentBinary(name, environment) {
  const explicit = environment[`REC_${name.toUpperCase()}_PATH`]
  const shared =
    name === "ffmpeg" || name === "ffprobe"
      ? environment.REC_FFMPEG_DIR
      : environment.REC_IMAGEMAGICK_DIR
  const configured = existing([
    explicit,
    shared && path.join(shared, binaryName(name))
  ])
  const fromPath = existing(
    (environment.PATH || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, binaryName(name)))
  )
  const projectVendor = existing([
    path.join(
      path.dirname(import.meta.dirname),
      "vendor",
      name === "magick" ? "imagemagick" : "ffmpeg",
      `${platformName()}-${process.arch}`,
      binaryName(name)
    )
  ])
  return (
    configured || projectVendor || fromPath || platform.resolveHostTool(name)
  )
}

function imagemagickDescriptor(command) {
  if (!command) return null
  const binDirectory = path.dirname(command)
  const home = path.dirname(binDirectory)
  const configureDirectory = path.join(home, "etc", "ImageMagick-7")
  const coderDirectory = path.join(
    home,
    "lib",
    "ImageMagick-7",
    "modules-Q16HDRI",
    "coders"
  )
  const filterDirectory = path.join(
    home,
    "lib",
    "ImageMagick-7",
    "modules-Q16HDRI",
    "filters"
  )
  const env = {}
  if (fs.existsSync(configureDirectory)) {
    env.MAGICK_HOME = home
    env.MAGICK_CONFIGURE_PATH = configureDirectory
  }
  if (fs.existsSync(coderDirectory))
    env.MAGICK_CODER_MODULE_PATH = coderDirectory
  if (fs.existsSync(filterDirectory))
    env.MAGICK_FILTER_MODULE_PATH = filterDirectory
  return descriptor(command, [], Object.keys(env).length ? env : undefined)
}

function bundledExiftool(environment) {
  if (packagedElectron(environment)) {
    const script = packagedVendorFile(environment, "exiftool", "exiftool")
    const perl = packagedVendorFile(
      environment,
      "perl",
      "bin",
      binaryName("perl")
    )
    if (!script || !perl) return null
    const libraryDirectory = path.join(
      path.resolve(environment.RECORDS_VENDOR_ROOT),
      "exiftool",
      "lib"
    )
    return descriptor(perl, [script], { PERL5LIB: libraryDirectory })
  }
  for (const root of resourceRoots(environment)) {
    const script = existing([
      path.join(root, "vendor", "exiftool", "exiftool"),
      path.join(root, "vendor", "exiftool", "bin", "exiftool")
    ])
    const perl = existing([
      path.join(root, "vendor", "perl", "bin", binaryName("perl")),
      path.join(
        root,
        "vendor",
        "perl",
        `${platformName()}-${process.arch}`,
        "bin",
        binaryName("perl")
      ),
      path.join(root, "vendor", "exiftool", "bin", binaryName("perl"))
    ])
    if (script && perl) {
      const libraryDirectory = path.join(path.dirname(script), "lib")
      return descriptor(
        perl,
        [script],
        fs.existsSync(libraryDirectory)
          ? { PERL5LIB: libraryDirectory }
          : undefined
      )
    }
  }
  return null
}

export function resolveMediaTool(name, options = {}) {
  const environment = options.env || process.env
  if (!new Set(["ffmpeg", "ffprobe", "magick", "exiftool"]).has(name)) {
    throw new Error(`Unknown media tool: ${name}`)
  }
  if (name === "exiftool") {
    const bundled = bundledExiftool(environment)
    if (bundled || packagedElectron(environment)) return bundled
    const command =
      existing([environment.REC_EXIFTOOL_PATH]) ||
      platform.resolveHostTool("exiftool")
    return descriptor(command)
  }
  const vendor = vendorBinary(name, environment)
  const command =
    vendor ||
    (packagedElectron(environment)
      ? null
      : developmentBinary(name, environment))
  if (name !== "magick") return descriptor(command)
  const magick = imagemagickDescriptor(command)
  if (magick || packagedElectron(environment)) return magick
  const convert = platform.resolveHostTool("convert")
  const identify = platform.resolveHostTool("identify")
  return convert && identify
    ? descriptor(convert, [], undefined, {
        identify: { command: identify, args: [] }
      })
    : null
}

export function toolCommand(tool, operation) {
  return tool?.operations?.[operation]?.command || tool?.command || null
}

export function toolArgs(tool, args, operation) {
  const prefix = tool?.operations?.[operation]?.args ?? tool?.args ?? []
  return [...prefix, ...args]
}

export function toolOptions(tool, options = {}) {
  if (!tool?.env) return options
  return { ...options, env: { ...process.env, ...tool.env, ...options.env } }
}

export function requireMediaTool(name) {
  const tool = resolveMediaTool(name)
  if (tool) return tool
  throw new Error(
    `Missing ${name} binary. Install it, provide a bundled vendor binary, or set REC_${name.toUpperCase()}_PATH.`
  )
}
