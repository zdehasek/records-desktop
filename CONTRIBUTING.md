# Contributing

## Development

Records targets current Omarchy and macOS 13 or newer with Node.js 22.13 or
newer. Install the host
dependencies from the README, then run:

```bash
npm ci
npm run dev
```

## Validation

Before opening a pull request, run:

```bash
npm run build
npm run test:all
npm audit --omit=dev
```

`npm run test:all` expects Chromium, FFmpeg, ImageMagick, ExifTool, the Omarchy
plugin validator, and QML tooling. Changes to frontend or vendored runtime
dependencies must include the rebuilt `frontend/dist/` or `runtime/vendor/`
output. Do not include personal media, profiles, databases, browser data, or
credentials.

Keep changes focused and add regression coverage for behavior changes. Report
security issues privately as described in `SECURITY.md` rather than opening a
public issue.

## macOS Packaging

Native packages must be built on the matching architecture; cross-built or
universal vendor trees are rejected. Install Xcode command-line tools plus
Autoconf/Automake, CMake, libtool, Meson, NASM, Ninja, and pkg-config, then run:

```bash
npm run validate:vendor-lock
npm run vendor:build:mac
npm run build:mac
npm run dist:mac:arm64 # or dist:mac:x64
npm run validate:package -- /path/to/Records.app
```

Downloads, builds, staged binaries, packages, signing material, and notarization
logs are ignored. Update `vendor/sources.lock.json` only from an official HTTPS
release and record its independently computed SHA-256; an incomplete checksum is
an error. Run `npm run vendor:source` for the GPL/LGPL corresponding-source and
relinking archive. It must contain FFmpeg, x264, libheif, libde265, and dav1d
sources plus the exact build, relocation, validation, and replacement materials.

The macOS workflow uses native `macos-15` and `macos-15-intel` runners. Pull
requests and ordinary pushes produce unsigned artifacts with signing discovery
disabled. Protected tag builds sign/notarize only when all of `CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and
`APPLE_API_ISSUER` are configured. Never expose these secrets to fork jobs.
