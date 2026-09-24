import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  captureTimestamp,
  createImageCaptionMetadata,
  resolveCaptionTags,
  resolveImageMetadata
} from "../../runtime/src/services/image-caption-metadata.js"

test("caption tags use XMP, IPTC, then EXIF precedence", () => {
  assert.deepEqual(
    resolveCaptionTags({
      "IFD0:ImageDescription": "EXIF caption",
      "IPTC:Caption-Abstract": "IPTC caption",
      "XMP-dc:Description": { "x-default": "XMP caption", cs: "Popisek" }
    }),
    {
      caption: "XMP caption",
      source: "xmp",
      conflict: true,
      values: {
        xmp: "XMP caption",
        iptc: "IPTC caption",
        exif: "EXIF caption"
      }
    }
  )
  assert.equal(
    resolveCaptionTags({ "IPTC:Caption-Abstract": "IPTC only" }).caption,
    "IPTC only"
  )
  assert.equal(
    resolveCaptionTags({ "IFD0:ImageDescription": "EXIF only" }).caption,
    "EXIF only"
  )
})

test("photo metadata ignores retired fields and unsupported colors", () => {
  const metadata = resolveImageMetadata({
    "XMP-dc:Identifier": "records:retired",
    "XMP-dc:Subject": ["retired"],
    "XMP-records:Visibility": "retired",
    "XMP-xmp:Rating": 5,
    "XMP-records:Important": true,
    "XMP-records:PresentationColor": "#123456"
  })
  assert.equal(metadata.important, true)
  assert.equal(metadata.presentationColor, null)
  for (const key of [
    "recordsId",
    "identifiers",
    "tags",
    "visibility",
    "rating"
  ]) {
    assert.equal(key in metadata, false)
  }

  assert.equal(
    resolveImageMetadata({
      "XMP-records:PresentationColor": "lavender"
    }).presentationColor,
    "lavender"
  )

  assert.deepEqual(resolveCaptionTags(null), {
    caption: "",
    source: null,
    conflict: false,
    values: { xmp: "", iptc: "", exif: "" }
  })
  assert.equal(
    resolveCaptionTags({
      "XMP-dc:Description": { xDefault: ["", 42] }
    }).caption,
    "42"
  )
  const gps = resolveImageMetadata({
    "XMP-records:Important": "1",
    "Composite:GPSLatitude": "50.1",
    "Composite:GPSLongitude": "not-a-number"
  })
  assert.equal(gps.important, true)
  assert.equal(gps.latitude, 50.1)
  assert.equal(gps.longitude, null)
})

test("capture timestamps preserve EXIF wall time and offsets", () => {
  assert.equal(
    captureTimestamp("2026:09:17 00:30:00", "+14:00"),
    "2026-09-17T00:30:00+14:00"
  )
  assert.equal(
    captureTimestamp("2026:09:17 23:30:00", "-11:00"),
    "2026-09-17T23:30:00-11:00"
  )
  assert.equal(captureTimestamp("2026:09:17 10:11:12"), "2026-09-17T10:11:12")
  assert.equal(
    captureTimestamp("2026:09:17 10:11:12.345", "Z"),
    "2026-09-17T10:11:12.345+00:00"
  )
  assert.equal(captureTimestamp("0000:00:00 00:00:00"), null)
  assert.equal(captureTimestamp("2026:02:31 10:11:12"), null)
})

test("photo metadata prefers exact XMP time only when EXIF agrees", () => {
  const metadata = resolveImageMetadata({
    "XMP-xmp:CreateDate": "2026:09:17 00:30:12.345+14:00",
    "ExifIFD:DateTimeOriginal": "2026:09:17 00:30:12",
    "ExifIFD:OffsetTimeOriginal": "+14:00",
    "IFD0:Make": "Records"
  })
  assert.equal(metadata.xmpCreateDate, "2026:09:17 00:30:12.345+14:00")
  assert.equal(metadata.createdAt, "2026-09-17T00:30:12.345+14:00")
  assert.equal(metadata.make, "Records")
  assert.equal(
    resolveImageMetadata({
      "XMP-xmp:CreateDate": "2023:07:16 11:12:13+02:00"
    }).createdAt,
    "2023-07-16T11:12:13+02:00"
  )
  assert.equal(
    resolveImageMetadata({
      "XMP-xmp:CreateDate": "2026:09:18 17:17:38",
      "ExifIFD:DateTimeOriginal": "2026:09:18 17:17:38",
      "ExifIFD:OffsetTimeOriginal": "+02:00"
    }).createdAt,
    "2026-09-18T17:17:38+02:00"
  )
  assert.throws(
    () =>
      resolveImageMetadata({
        "XMP-xmp:CreateDate": "2026:09:18 17:17:38+03:00",
        "ExifIFD:DateTimeOriginal": "2026:09:18 17:17:38",
        "ExifIFD:OffsetTimeOriginal": "+02:00"
      }),
    /capture times disagree/
  )
  assert.throws(
    () =>
      resolveImageMetadata({
        "XMP-xmp:CreateDate": "2026-09-16T10:30:12.345Z",
        "ExifIFD:DateTimeOriginal": "2026:09:17 00:30:12",
        "ExifIFD:OffsetTimeOriginal": "+14:00"
      }),
    /capture times disagree/
  )
  assert.throws(
    () =>
      resolveImageMetadata({
        "XMP-xmp:CreateDate": "not-a-timestamp",
        "ExifIFD:DateTimeOriginal": "2026:09:17 00:30:12"
      }),
    /CreateDate is invalid/
  )
})

function fixture(context, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-caption-"))
  const photo = path.join(directory, "photo.jpg")
  fs.writeFileSync(photo, "original pixels")
  const captions = new Map([[photo, options.initialCaption || ""]])
  const run = async (command, args) => {
    const target = args.at(-1)
    if (command === "/fake/magick") {
      const staged = target.includes(".records-caption-")
      const signature = staged && options.changePixels ? "changed" : "same"
      return { stdout: `JPEG\u001f10\u001f10\u001f0\u001f${signature}\u001e` }
    }
    if (args.includes("-overwrite_original")) {
      if (options.writeError) throw new Error("ExifTool failed")
      const caption = args
        .find((arg) => arg.startsWith("-XMP-dc:Description="))
        .slice("-XMP-dc:Description=".length)
      captions.set(target, options.verifyMismatch ? "different" : caption)
      fs.appendFileSync(target, " metadata")
      return { stdout: "1 image files updated" }
    }
    const caption = captions.get(target) ?? captions.get(photo) ?? ""
    return {
      stdout: JSON.stringify([
        caption ? { "XMP-dc:Description": { "x-default": caption } } : {}
      ])
    }
  }
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return {
    directory,
    photo,
    service: createImageCaptionMetadata({
      exiftool: "/fake/exiftool",
      magick: "/fake/magick",
      runCommand: run
    })
  }
}

test("safe caption write verifies staging before replacing original", async (context) => {
  const { directory, photo, service } = fixture(context)
  const before = fs.readFileSync(photo, "utf8")
  const result = await service.write(photo, "Ahoj")

  assert.equal(result.caption, "Ahoj")
  assert.equal(result.embedded.caption, "Ahoj")
  assert.equal(fs.readFileSync(photo, "utf8"), `${before} metadata`)
  assert.deepEqual(
    fs
      .readdirSync(directory)
      .filter((name) => name.includes("records-caption")),
    []
  )
})

test("photo metadata write persists and verifies every supported field", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-caption-all-")
  )
  const photo = path.join(directory, "photo.jpg")
  fs.writeFileSync(photo, "pixels")
  let embedded = {}
  let mismatchTag = null
  let lastWriteArgs = []
  const runCommand = async (command, args) => {
    if (command === "/fake/magick") {
      return { stdout: "JPEG\u001f10\u001f10\u001f0\u001fsame\u001e" }
    }
    if (!args.includes("-overwrite_original")) {
      return { stdout: JSON.stringify([embedded]) }
    }
    lastWriteArgs = args
    const value = (prefix) =>
      args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
    embedded = {
      "XMP-dc:Description": value("-XMP-dc:Description="),
      "IPTC:Caption-Abstract": value("-IPTC:Caption-Abstract="),
      "EXIF:ImageDescription": value("-EXIF:ImageDescription="),
      "XMP-records:Important": value("-XMP-records:Important=") === "true",
      "XMP-records:PresentationColor": value("-XMP-records:PresentationColor="),
      "EXIF:DateTimeOriginal": value("-EXIF:DateTimeOriginal="),
      "EXIF:OffsetTimeOriginal":
        value("-EXIF:OffsetTimeOriginal=") || undefined,
      "XMP-xmp:CreateDate": value("-XMP-xmp:CreateDate="),
      "EXIF:Make": value("-EXIF:Make="),
      "EXIF:Model": value("-EXIF:Model="),
      "Composite:GPSLatitude": -50.1,
      "Composite:GPSLongitude": 14.2
    }
    if (mismatchTag) embedded[mismatchTag[0]] = mismatchTag[1]
    fs.appendFileSync(args.at(-1), " metadata")
    return { stdout: "1 image files updated" }
  }
  const service = createImageCaptionMetadata({
    exiftool: "/fake/exiftool",
    magick: "/fake/magick",
    runCommand
  })
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await service.write(photo, {
    caption: "All fields",
    important: true,
    presentationColor: "sky",
    createdAt: "2026-09-17T00:30:12.000+14:00",
    make: "Records",
    model: "One",
    latitude: -50.1,
    longitude: 14.2
  })
  assert.equal(result.embedded.caption, "All fields")
  assert.equal(result.embedded.dateTimeOriginal, "2026:09:17 00:30:12")
  assert.equal(result.embedded.offsetTimeOriginal, "+14:00")
  assert.equal(result.embedded.createdAt, "2026-09-17T00:30:12.000+14:00")
  assert.equal(result.embedded.xmpCreateDate, "2026-09-17T00:30:12.000+14:00")
  assert.equal(result.embedded.presentationColor, "sky")
  assert.ok(lastWriteArgs.includes("iptc=utf8"))
  assert.ok(lastWriteArgs.includes("-IPTC:CodedCharacterSet=UTF8"))

  for (const createdAt of [
    "2026-09-17T23:30:12.25-11:00",
    "2026-09-17T10:11:12.5Z",
    "2026-09-17T10:11:12.125"
  ]) {
    const timestampResult = await service.write(photo, { createdAt })
    assert.equal(timestampResult.embedded.createdAt, createdAt)
  }

  for (const mismatch of [
    ["XMP-xmp:CreateDate", "2026-09-17T10:11:13.125"],
    ["EXIF:DateTimeOriginal", "2026:09:17 10:11:13"],
    ["EXIF:OffsetTimeOriginal", "+01:00"]
  ]) {
    mismatchTag = mismatch
    const before = fs.readFileSync(photo)
    await assert.rejects(
      service.write(photo, { createdAt: "2026-09-17T10:11:12.125" }),
      /capture times disagree|verification failed/
    )
    assert.deepEqual(fs.readFileSync(photo), before)
  }
})

for (const [name, options, message] of [
  ["ExifTool failure", { writeError: true }, /ExifTool failed/],
  ["read-back mismatch", { verifyMismatch: true }, /XMP verification/],
  ["pixel mismatch", { changePixels: true }, /Photo pixels changed/]
]) {
  test(`${name} leaves the original byte-for-byte unchanged`, async (context) => {
    const { directory, photo, service } = fixture(context, options)
    const before = fs.readFileSync(photo)
    await assert.rejects(service.write(photo, "Ahoj"), message)
    assert.deepEqual(fs.readFileSync(photo), before)
    assert.deepEqual(
      fs
        .readdirSync(directory)
        .filter((entry) => entry.includes("records-caption")),
      []
    )
  })
}

test("caption write rejects unsafe targets and unavailable tools", async (context) => {
  const { directory, photo, service } = fixture(context)
  const link = path.join(directory, "photo-link.jpg")
  fs.symlinkSync(photo, link)
  await assert.rejects(service.write(link, "Ahoj"), /regular file/)
  await assert.rejects(service.write(photo, "bad\0caption"), /NUL/)

  const missingExiftool = createImageCaptionMetadata({
    exiftool: null,
    magick: "/usr/bin/magick"
  })
  await assert.rejects(
    missingExiftool.write(photo, "Ahoj"),
    /ExifTool is required/
  )

  const missingMagick = createImageCaptionMetadata({
    exiftool: "/usr/bin/exiftool",
    magick: null
  })
  await assert.rejects(
    missingMagick.write(photo, "Ahoj"),
    /ImageMagick 7 \(`magick`\) is required/
  )
  assert.deepEqual(missingMagick.capabilities(), {
    read: true,
    write: false,
    tool: "exiftool"
  })
  await assert.rejects(missingExiftool.read(photo), /required to read/)

  const hardLink = path.join(directory, "hard-link.jpg")
  fs.linkSync(photo, hardLink)
  await assert.rejects(service.write(photo, "Ahoj"), /hard-linked/)
})

test("photo metadata rejects invalid date and incomplete GPS patches", async (context) => {
  const { photo, service } = fixture(context)
  await assert.rejects(
    service.write(photo, { createdAt: "not-a-date" }),
    /Invalid capture time/
  )
  await assert.rejects(
    service.write(photo, { latitude: 1, longitude: null }),
    /must be provided together/
  )
  assert.equal((await service.contentFingerprint(photo)).length, 64)
})
