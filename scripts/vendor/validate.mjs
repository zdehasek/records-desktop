import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../..")
const lockPath = path.join(root, "vendor", "sources.lock.json")
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"))
const mode = process.argv[2] || "lock"

function fail(message) {
  throw new Error(message)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options })
  if (result.error) fail(`${command}: ${result.error.message}`)
  if (result.status !== 0)
    fail(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`
    )
  return `${result.stdout}${result.stderr}`
}

export function otoolBody(output, file) {
  const [header, ...body] = output.split("\n")
  if (header !== `${file}:`) fail(`${file}: unexpected otool output header`)
  return body.join("\n")
}

function walk(directory, allowSymlinks = false) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      if (allowSymlinks) return []
      fail(`staged vendor symlink is not allowed: ${item}`)
    }
    return entry.isDirectory() ? walk(item, allowSymlinks) : [item]
  })
}

function validateLock() {
  if (lock.schemaVersion !== 1 || lock.deploymentTarget !== "13.0")
    fail("source lock schema or deployment target is invalid")
  if (!Array.isArray(lock.components) || lock.components.length !== 12)
    fail("source lock must contain all 12 components")
  const names = new Set()
  for (const component of lock.components) {
    for (const field of [
      "name",
      "version",
      "url",
      "sha256",
      "directory",
      "license",
      "licenseFiles",
      "buildOptions"
    ]) {
      if (!component[field]?.length)
        fail(`${component.name || "component"}: missing ${field}`)
    }
    if (names.has(component.name))
      fail(`duplicate component: ${component.name}`)
    names.add(component.name)
    if (!component.url.startsWith("https://"))
      fail(`${component.name}: non-HTTPS source`)
    if (!/^[a-f0-9]{64}$/.test(component.sha256))
      fail(`${component.name}: incomplete SHA-256`)
    for (const license of component.licenseFiles) {
      if (
        path.isAbsolute(license) ||
        license.split(/[\\/]/).includes("..") ||
        path.basename(license) !== license
      )
        fail(`${component.name}: license must be a root-level file: ${license}`)
    }
  }
  for (const required of [
    "ffmpeg",
    "x264",
    "imagemagick",
    "libjpeg-turbo",
    "libpng",
    "libtiff",
    "libwebp",
    "libheif",
    "libde265",
    "dav1d",
    "perl",
    "exiftool"
  ]) {
    if (!names.has(required)) fail(`source lock is missing ${required}`)
  }
  const perl = lock.components.find(({ name }) => name === "perl")
  if (!perl.buildOptions.includes("-Duserelocatableinc"))
    fail("Perl lock options must enable userelocatableinc")
  process.stdout.write(
    `Source lock: ${lock.components.length} complete HTTPS/SHA-256 entries\n`
  )
}

function machoDetails(file) {
  const linkage = otoolBody(run("otool", ["-L", file]), file)
  const loadCommands = otoolBody(run("otool", ["-l", file]), file)
  const idResult = spawnSync("otool", ["-D", file], { encoding: "utf8" })
  const id =
    idResult.status === 0
      ? idResult.stdout
          .split("\n")
          .slice(1)
          .map((line) => line.trim())
          .find(Boolean)
      : undefined
  const dependencies = linkage
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((dependency) => dependency !== id)
  const lines = loadCommands.split("\n")
  const rpaths = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "cmd LC_RPATH") continue
    const match = lines[index + 2]?.trim().match(/^path (.+) \(offset \d+\)$/)
    if (!match) fail(`${file}: cannot parse LC_RPATH`)
    rpaths.push(match[1])
  }
  return { dependencies, id, linkage, loadCommands, rpaths }
}

function isSystemLibrary(dependency) {
  return (
    dependency.startsWith("/System/Library/") ||
    dependency.startsWith("/usr/lib/")
  )
}

function expandLocation(value, loader, executable) {
  for (const [token, directory] of [
    ["@loader_path", path.dirname(loader)],
    ["@executable_path", path.dirname(executable)]
  ]) {
    if (value === token || value.startsWith(`${token}/`))
      return path.resolve(directory, value.slice(token.length + 1))
  }
  if (path.isAbsolute(value)) return path.resolve(value)
  fail(`${loader}: unsupported relative Mach-O path ${value}`)
}

function assertInsideStage(candidate, stage, reference) {
  const relative = path.relative(stage, candidate)
  if (relative.startsWith("..") || path.isAbsolute(relative))
    fail(`${reference}: Mach-O reference escapes vendor stage: ${candidate}`)
  if (!fs.existsSync(candidate))
    fail(`${reference}: unresolved Mach-O reference: ${candidate}`)
  return candidate
}

function resolveDependency(dependency, loader, executable, rpaths, stage) {
  if (dependency.startsWith("@rpath/")) {
    const suffix = dependency.slice("@rpath/".length)
    const candidates = rpaths.map((rpath) =>
      path.join(expandLocation(rpath, loader, executable), suffix)
    )
    const resolved = candidates.find((candidate) => fs.existsSync(candidate))
    if (!resolved)
      fail(
        `${loader}: unresolved ${dependency}; searched ${candidates.join(", ") || "no LC_RPATH entries"}`
      )
    return assertInsideStage(path.resolve(resolved), stage, loader)
  }
  if (
    dependency.startsWith("@loader_path/") ||
    dependency.startsWith("@executable_path/")
  ) {
    return assertInsideStage(
      expandLocation(dependency, loader, executable),
      stage,
      loader
    )
  }
  fail(`${loader}: non-relocatable dependency ${dependency}`)
}

function validateMachO(files, architecture, stage) {
  const expected = architecture === "arm64" ? "arm64" : "x86_64"
  const forbidden = [
    /\/opt\/homebrew\//,
    /\/usr\/local\//,
    /\.build\//,
    /\/Users\//,
    /\/private\/var\//
  ]
  const machos = new Map()
  for (const file of files) {
    const description = run("file", [file])
    if (!description.includes("Mach-O")) continue
    const architectures = run("lipo", ["-archs", file]).trim().split(/\s+/)
    if (architectures.length !== 1 || architectures[0] !== expected)
      fail(`${file}: expected only ${expected}, got ${architectures.join(" ")}`)
    const details = machoDetails(file)
    for (const pattern of forbidden) {
      if (pattern.test(details.linkage) || pattern.test(details.loadCommands))
        fail(`${file}: forbidden build-machine Mach-O reference ${pattern}`)
    }
    for (const dependency of details.dependencies) {
      if (
        !isSystemLibrary(dependency) &&
        !dependency.startsWith("@rpath/") &&
        !dependency.startsWith("@loader_path/") &&
        !dependency.startsWith("@executable_path/")
      )
        fail(`${file}: non-relocatable dependency ${dependency}`)
    }
    for (const rpath of details.rpaths) {
      if (!/^@(loader_path|executable_path)(\/|$)/.test(rpath))
        fail(`${file}: non-relocatable LC_RPATH ${rpath}`)
    }
    machos.set(path.resolve(file), details)
  }

  if (!stage) return machos
  const roots = ["bin/ffmpeg", "bin/ffprobe", "bin/magick", "perl/bin/perl"]
  for (const relative of roots) {
    const executable = path.join(stage, relative)
    const pending = [{ file: executable, inheritedRpaths: [] }]
    const visited = new Set()
    while (pending.length) {
      const { file, inheritedRpaths } = pending.pop()
      if (visited.has(file)) continue
      visited.add(file)
      const details = machos.get(file)
      if (!details) fail(`${relative}: dependency is not Mach-O: ${file}`)
      const rpaths = [
        ...details.rpaths.map((rpath) =>
          expandLocation(rpath, file, executable)
        ),
        ...inheritedRpaths
      ]
      for (const dependency of details.dependencies) {
        if (isSystemLibrary(dependency)) continue
        const resolved = resolveDependency(
          dependency,
          file,
          executable,
          rpaths,
          stage
        )
        pending.push({ file: resolved, inheritedRpaths: rpaths })
      }
    }
  }
  return machos
}

function hasDependency(machos, file, expected) {
  return machos
    .get(file)
    .dependencies.some((dependency) => dependency === expected)
}

export function validateLicenses(stage) {
  for (const component of lock.components) {
    const directory = path.join(stage, "licenses", component.name)
    if (!fs.existsSync(directory))
      fail(`staged license directory is missing: ${component.name}`)
    const actual = fs.readdirSync(directory).sort()
    const expected = component.licenseFiles
      .map((file) => path.basename(file))
      .sort()
    if (actual.join("\n") !== expected.join("\n"))
      fail(
        `${component.name}: expected exact license files ${expected.join(", ")}; got ${actual.join(", ")}`
      )
    for (const file of actual) {
      if (!fs.statSync(path.join(directory, file)).isFile())
        fail(`${component.name}: license is not a regular file: ${file}`)
    }
  }
  const stagedLock = path.join(stage, "sources.lock.json")
  if (fs.readFileSync(stagedLock, "utf8") !== fs.readFileSync(lockPath, "utf8"))
    fail("staged sources.lock.json does not exactly match the repository lock")
}

function cleanEnvironment(home, stage) {
  return {
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    MAGICK_CONFIGURE_PATH: path.join(stage, "etc", "ImageMagick-7"),
    MAGICK_HOME: stage
  }
}

function validateRelocation(stage) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "records-vendor-"))
  const relocated = path.join(temporary, `relocated-${path.basename(stage)}`)
  try {
    fs.cpSync(stage, relocated, { recursive: true, dereference: true })
    const home = path.join(temporary, "home")
    fs.mkdirSync(home)
    const environment = cleanEnvironment(home, relocated)
    const perl = path.join(relocated, "perl", "bin", "perl")
    const perlVersion = lock.components.find(
      ({ name }) => name === "perl"
    ).version
    const perlCheck = String.raw`
      my $root = $ENV{RECORDS_PERL_ROOT} // die "RECORDS_PERL_ROOT is missing\n";
      die "unexpected Perl version: $Config{version}\n" unless $Config{version} eq $ENV{RECORDS_PERL_VERSION};
      die "userelocatableinc is disabled\n" unless $Config{userelocatableinc} eq "define";
      for my $include (@INC) {
        die "non-path entry in @INC\n" if ref $include;
        die "@INC escaped relocated Perl tree: $include\n" unless $include =~ m{^\Q$root\E(?:/|$)};
      }
      my $pure = "$root/lib/$Config{version}";
      my $arch = "$pure/$Config{archname}";
      my %expected = (
        "strict.pm" => "$pure/strict.pm",
        "File/Spec.pm" => "$pure/File/Spec.pm",
        "Config.pm" => "$arch/Config.pm",
      );
      for my $module (sort keys %expected) {
        my $loaded = $INC{$module} // die "$module was not loaded\n";
        die "$module loaded from $loaded; expected $expected{$module}\n" unless $loaded eq $expected{$module};
        die "$module path is not a regular file\n" unless -f $loaded;
      }
    `
    environment.RECORDS_PERL_ROOT = path.join(relocated, "perl")
    environment.RECORDS_PERL_VERSION = perlVersion
    run(perl, ["-Mstrict", "-MConfig", "-MFile::Spec", "-e", perlCheck], {
      cwd: home,
      env: environment
    })
    const exifEnvironment = {
      ...environment,
      PERL5LIB: path.join(relocated, "exiftool", "lib")
    }
    const exiftool = path.join(relocated, "exiftool", "exiftool")
    run(perl, [exiftool, "-ver"], { cwd: home, env: exifEnvironment })
    const image = path.join(home, "metadata-roundtrip.jpg")
    run(
      path.join(relocated, "bin", "magick"),
      ["-size", "2x2", "xc:white", image],
      { cwd: home, env: environment }
    )
    const marker = "Records relocated ExifTool validation"
    run(
      perl,
      [exiftool, "-overwrite_original", `-ImageDescription=${marker}`, image],
      { cwd: home, env: exifEnvironment }
    )
    const description = run(
      perl,
      [exiftool, "-s3", "-ImageDescription", image],
      { cwd: home, env: exifEnvironment }
    ).trim()
    if (description !== marker)
      fail(`relocated ExifTool metadata round trip failed: ${description}`)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function validateDecodeFixtures(magick, environment) {
  const libheif = lock.components.find(({ name }) => name === "libheif")
  const fixtureRoot = path.join(
    root,
    ".build",
    "vendor",
    "sources",
    libheif.directory,
    "examples"
  )
  const fixtures = [
    ["RECORDS_HEIC_FIXTURE", "HEIC", "example.heic"],
    ["RECORDS_AVIF_FIXTURE", "AVIF", "example.avif"]
  ]
  for (const [variable, format, filename] of fixtures) {
    const fixture = process.env[variable] || path.join(fixtureRoot, filename)
    if (!fs.statSync(fixture, { throwIfNoEntry: false })?.isFile())
      fail(
        `${format} decode fixture is missing: ${fixture}; set ${variable} to the checksum-controlled fixture`
      )
    run(magick, [`${fixture}[0]`, "-resize", "1x1!", "null:"], {
      env: environment
    })
    process.stdout.write(`${format} decode fixture: verified\n`)
  }
}

function validateStage(stage, specifiedArchitecture) {
  if (process.platform !== "darwin")
    fail("staged vendor validation requires macOS tools")
  if (!fs.existsSync(stage))
    fail(
      `staged vendor tree is missing: ${stage}; run npm run vendor:build:mac`
    )
  for (const relative of lock.expectedStage) {
    if (!fs.existsSync(path.join(stage, relative)))
      fail(`staged vendor file is missing: ${relative}`)
  }
  const architecture =
    specifiedArchitecture || path.basename(stage).replace("mac-", "")
  if (!["arm64", "x64"].includes(architecture))
    fail(`invalid staged architecture: ${architecture}`)
  const files = walk(stage)
  const archives = files.filter((file) => file.endsWith(".a"))
  if (archives.length) fail(`unexpected staged static archive: ${archives[0]}`)
  const stagedLibraries = walk(path.join(stage, "lib"))
    .map((file) => path.relative(stage, file))
    .sort()
  const expectedDylibs = ["lib/libde265.dylib", "lib/libheif.dylib"]
  if (stagedLibraries.join("\n") !== expectedDylibs.join("\n"))
    fail(`unexpected staged/plugin libraries: ${stagedLibraries.join(", ")}`)
  validateLicenses(stage)
  const machos = validateMachO(files, architecture, stage)
  const magick = path.join(stage, "bin", "magick")
  const libheif = path.join(stage, "lib", "libheif.dylib")
  const libde265 = path.join(stage, "lib", "libde265.dylib")
  if (machos.get(libheif)?.id !== "@rpath/libheif.dylib")
    fail("libheif has an unexpected Mach-O install ID")
  if (machos.get(libde265)?.id !== "@rpath/libde265.dylib")
    fail("libde265 has an unexpected Mach-O install ID")
  if (!machos.get(magick)?.rpaths.includes("@executable_path/../lib"))
    fail("magick is missing its staged-library LC_RPATH")
  if (!machos.get(libheif)?.rpaths.includes("@loader_path"))
    fail("libheif is missing its loader-relative LC_RPATH")
  if (!hasDependency(machos, magick, "@executable_path/../lib/libheif.dylib"))
    fail("magick does not link staged libheif through @executable_path")
  if (!hasDependency(machos, libheif, "@loader_path/libde265.dylib"))
    fail("libheif does not link staged libde265 through @loader_path")

  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "records-home-"))
  try {
    const environment = cleanEnvironment(temporaryHome, stage)
    const ffmpegPath = path.join(stage, "bin", "ffmpeg")
    const ffmpeg = run(ffmpegPath, ["-hide_banner", "-buildconf"], {
      env: environment
    })
    for (const flag of ["--enable-gpl", "--enable-libx264"])
      if (!ffmpeg.includes(flag)) fail(`FFmpeg build is missing ${flag}`)
    const encoders = run(ffmpegPath, ["-hide_banner", "-encoders"], {
      env: environment
    })
    for (const encoder of ["libx264", "aac", "gif", "mjpeg"])
      if (!encoders.includes(encoder))
        fail(`FFmpeg encoder is missing: ${encoder}`)
    const formats = run(magick, ["-list", "format"], { env: environment })
    for (const format of ["JPEG", "PNG", "TIFF", "WEBP", "GIF", "HEIC", "AVIF"])
      if (!formats.includes(format))
        fail(`ImageMagick format is missing: ${format}`)
    validateDecodeFixtures(magick, environment)
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true })
  }
  validateRelocation(stage)
  process.stdout.write(
    `Vendor stage: ${files.length} files, ${architecture}, relocated sanitized environment verified\n`
  )
}

function validatePackage(app) {
  if (process.platform !== "darwin")
    fail("package validation requires macOS tools")
  if (!fs.existsSync(app)) fail(`application bundle is missing: ${app}`)
  const resources = path.join(app, "Contents", "Resources")
  const asar = path.join(resources, "app.asar")
  for (const required of [
    "runtime",
    "frontend/dist",
    "vendor",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md"
  ]) {
    if (!fs.existsSync(path.join(resources, required)))
      fail(`package resource is missing: ${required}`)
  }
  const relativeFiles = walk(resources).map((file) =>
    path.relative(resources, file)
  )
  for (const file of relativeFiles) {
    if (
      /(^|\/)(tests?|coverage|\.dev)(\/|$)/.test(file) ||
      file.includes("frontend/src")
    )
      fail(`development file in package: ${file}`)
  }
  if (!fs.existsSync(asar)) fail("package resource is missing: app.asar")
  const asarCli = path.join(root, "node_modules", ".bin", "asar")
  const asarFiles = run(asarCli, ["list", asar]).split("\n").filter(Boolean)
  for (const required of [
    "/package.json",
    "/desktop/electron/main.js",
    "/desktop/electron/backend-supervisor.js"
  ]) {
    if (!asarFiles.includes(required)) fail(`app.asar is missing: ${required}`)
  }
  for (const file of asarFiles) {
    if (
      file.includes("node_modules/") ||
      file.includes("/tests/") ||
      file.includes("preload")
    )
      fail(`unexpected app.asar entry: ${file}`)
  }
  const vendor = path.join(resources, "vendor")
  const info = JSON.parse(
    fs.readFileSync(path.join(vendor, "build-info.json"), "utf8")
  )
  validateStage(vendor, info.architecture)
  validateMachO(walk(app, true), info.architecture)
  process.stdout.write(
    `Package inventory: ${relativeFiles.length} resource files\n`
  )
}

validateLock()
if (mode === "staged") {
  const architecture =
    process.env.RECORDS_MAC_ARCH || (process.arch === "x64" ? "x64" : "arm64")
  validateStage(
    path.resolve(
      process.argv[3] || path.join(root, "vendor", `mac-${architecture}`)
    )
  )
} else if (mode === "package") {
  const architecture =
    process.env.RECORDS_MAC_ARCH || (process.arch === "x64" ? "x64" : "arm64")
  validatePackage(
    path.resolve(
      process.argv[3] ||
        path.join(
          root,
          "dist-electron",
          architecture === "arm64" ? "mac-arm64" : "mac",
          "Records.app"
        )
    )
  )
} else if (mode !== "lock") {
  fail(`unknown validation mode: ${mode}`)
}
