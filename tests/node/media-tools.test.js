import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  resolveMediaTool,
  toolArgs,
  toolOptions
} from "../../runtime/media-tools.js"

function fixture(context) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-media-tools-")
  )
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test("packaged Electron resolution is vendor-only and does not search PATH", (context) => {
  const directory = fixture(context)
  const pathDirectory = path.join(directory, "path")
  fs.mkdirSync(pathDirectory)
  fs.writeFileSync(path.join(pathDirectory, "ffmpeg"), "")

  const environment = {
    RECORDS_HOST: "electron",
    RECORDS_PACKAGED: "true",
    RECORDS_RESOURCES_PATH: directory,
    RECORDS_VENDOR_ROOT: path.join(directory, "vendor"),
    PATH: pathDirectory
  }
  assert.equal(resolveMediaTool("ffmpeg", { env: environment }), null)

  const bundled = path.join(directory, "vendor", "bin", "ffmpeg")
  fs.mkdirSync(path.dirname(bundled), { recursive: true })
  fs.writeFileSync(bundled, "")
  fs.chmodSync(bundled, 0o755)
  assert.equal(
    resolveMediaTool("ffmpeg", { env: environment }).command,
    bundled
  )
})

test("bundled ExifTool descriptor invokes its script through bundled Perl", (context) => {
  const directory = fixture(context)
  const exiftool = path.join(directory, "vendor", "exiftool", "exiftool")
  const perl = path.join(
    directory,
    "vendor",
    "perl",
    "bin",
    process.platform === "win32" ? "perl.exe" : "perl"
  )
  const libraryDirectory = path.join(directory, "vendor", "exiftool", "lib")
  fs.mkdirSync(path.dirname(exiftool), { recursive: true })
  fs.mkdirSync(path.dirname(perl), { recursive: true })
  fs.mkdirSync(libraryDirectory)
  fs.writeFileSync(exiftool, "")
  fs.writeFileSync(perl, "")

  const tool = resolveMediaTool("exiftool", {
    env: { RECORDS_RESOURCES_PATH: directory }
  })
  assert.equal(tool.command, perl)
  assert.deepEqual(toolArgs(tool, ["-j", "photo.jpg"]), [
    exiftool,
    "-j",
    "photo.jpg"
  ])
  assert.equal(toolOptions(tool).env.PERL5LIB, libraryDirectory)
})

test("bundled ImageMagick descriptor supplies its runtime environment", (context) => {
  const directory = fixture(context)
  const home = path.join(directory, "vendor")
  const magick = path.join(
    home,
    "bin",
    process.platform === "win32" ? "magick.exe" : "magick"
  )
  fs.mkdirSync(path.dirname(magick), { recursive: true })
  fs.mkdirSync(path.join(home, "lib"))
  fs.mkdirSync(path.join(home, "etc", "ImageMagick-7"), { recursive: true })
  fs.writeFileSync(magick, "")

  const tool = resolveMediaTool("magick", {
    env: { RECORDS_RESOURCES_PATH: directory }
  })
  const options = toolOptions(tool)
  assert.equal(options.env.MAGICK_HOME, home)
  assert.equal(
    options.env.MAGICK_CONFIGURE_PATH,
    path.join(home, "etc", "ImageMagick-7")
  )
  assert.equal(options.env.DYLD_LIBRARY_PATH, undefined)
  assert.equal(options.env.LD_LIBRARY_PATH, undefined)
})

test("packaged resolution rejects non-executable and symlinked tools", (context) => {
  const directory = fixture(context)
  const vendor = path.join(directory, "vendor")
  const binary = path.join(vendor, "bin", "ffmpeg")
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  fs.writeFileSync(binary, "")
  const environment = {
    RECORDS_HOST: "electron",
    RECORDS_PACKAGED: "1",
    RECORDS_VENDOR_ROOT: vendor
  }
  assert.equal(resolveMediaTool("ffmpeg", { env: environment }), null)
  fs.rmSync(binary)
  fs.symlinkSync("/bin/true", binary)
  assert.equal(resolveMediaTool("ffmpeg", { env: environment }), null)
})
