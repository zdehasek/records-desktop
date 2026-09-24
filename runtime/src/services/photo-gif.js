import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runCommand } from "../../host-tools.js"
import {
  requireMediaTool,
  toolArgs,
  toolCommand,
  toolOptions
} from "../../media-tools.js"
import { canonicalFileReference, resolveRootPath } from "../file-roots.js"
import {
  cleanupImportDirectories,
  prepareDatedImportDirectory
} from "./media-destination.js"

const GIF_SIZE = 720
const FRAME_SECONDS = 0.3
const GIF_FPS = 12

function gifFilter(count) {
  const frames = Array.from(
    { length: count },
    (_, index) =>
      `[${index}:v]scale=${GIF_SIZE}:${GIF_SIZE}:force_original_aspect_ratio=decrease,pad=${GIF_SIZE}:${GIF_SIZE}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${GIF_FPS},format=rgba[v${index}]`
  )
  const inputs = frames.map((_, index) => `[v${index}]`).join("")
  return `${frames.join(";")};${inputs}concat=n=${count}:v=1:a=0,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`
}

async function renderGif(items, outputPath, options) {
  const args = ["-y"]
  for (const item of items) {
    args.push("-loop", "1", "-t", String(FRAME_SECONDS), "-i", item.file_path)
  }
  args.push(
    "-filter_complex",
    gifFilter(items.length),
    "-loop",
    "0",
    outputPath
  )
  const tool = options.ffmpeg
    ? typeof options.ffmpeg === "string"
      ? { command: options.ffmpeg, args: [] }
      : options.ffmpeg
    : requireMediaTool("ffmpeg")
  await (options.execFile || runCommand)(
    toolCommand(tool),
    toolArgs(tool, args),
    toolOptions(tool)
  )
}

function selectedImage(db, config, selection) {
  let row
  if (typeof selection === "number" || typeof selection === "string") {
    row = db
      .prepare(
        `SELECT * FROM attachments
          WHERE id = ? AND mime_type LIKE 'image/%'`
      )
      .get(selection)
  } else {
    const reference = canonicalFileReference(selection)
    row = db
      .prepare(
        `SELECT * FROM attachments
          WHERE root_name = ? AND relative_path = ?
            AND mime_type LIKE 'image/%'`
      )
      .get(reference.root, reference.path)
  }
  if (!row) throw new Error("Selected photo is not in the current media cache")
  const root = config.mediaRoots().find((entry) => entry.name === row.root_name)
  if (!root) {
    throw new Error("Selected photo has an invalid media-root reference")
  }
  row.file_path = resolveRootPath(root, row.relative_path)
  row.file_name = path.basename(row.relative_path)
  const stat = fs.lstatSync(row.file_path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Selected photo is not a regular file")
  }
  return row
}

function safeStem(fileName) {
  return (
    path
      .basename(fileName, path.extname(fileName))
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "photo"
  )
}

function installWithoutOverwrite(temporaryPath, directory, stem) {
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const fileName = `${stem}-animation${suffix === 1 ? "" : `-${suffix}`}.gif`
    const filePath = path.join(directory, fileName)
    try {
      fs.copyFileSync(temporaryPath, filePath, fs.constants.COPYFILE_EXCL)
      fs.unlinkSync(temporaryPath)
      return { fileName, filePath }
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
  }
  throw new Error("Could not allocate a GIF filename")
}

export async function createPhotoGif(db, selections, options) {
  if (!Array.isArray(selections) || selections.length < 2) {
    throw new Error("A GIF requires at least 2 selected photos")
  }
  if (!options.captionMetadata?.capabilities().write) {
    throw new Error("Image metadata tools are required to create a GIF")
  }
  const items = selections.map((selection) =>
    selectedImage(db, options.config, selection)
  )
  const captureDate = items[0].created_at || items[0].message_created_at
  if (!captureDate || Number.isNaN(new Date(captureDate).getTime())) {
    throw new Error("The first photo has no valid capture date")
  }

  const defaultRoot = options.config.defaultMediaRoot()
  if (!defaultRoot) {
    throw new Error(
      "Choose a default media folder in Settings before creating a GIF"
    )
  }
  const date = captureDate.slice(0, 10)
  const destination = prepareDatedImportDirectory(defaultRoot.path, date)
  const { directory } = destination
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-gif-")
  )
  const temporaryPath = path.join(temporaryDirectory, "animation.gif")
  try {
    await renderGif(items, temporaryPath, options)
    await options.captionMetadata.write(temporaryPath, {
      createdAt: captureDate
    })
    fs.chmodSync(temporaryPath, 0o600)
    const output = installWithoutOverwrite(
      temporaryPath,
      directory,
      safeStem(items[0].file_name)
    )
    return {
      ...output,
      root: defaultRoot.name,
      path: path
        .relative(defaultRoot.path, output.filePath)
        .split(path.sep)
        .join("/")
    }
  } catch (error) {
    cleanupImportDirectories(destination.created)
    throw error
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}
