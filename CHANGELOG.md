# Changelog

All notable changes to Records are documented here.

## Unreleased

## 0.1.6 - 2026-09-24

- Remove Perl's development-only static archive from the packaged runtime.

## 0.1.5 - 2026-09-24

- Expose libsharpyuv in the static libwebp package metadata used by
  ImageMagick, disable unneeded WebP utilities, and retry transient source
  download failures.

## 0.1.4 - 2026-09-24

- Fix the static ImageMagick WebP link by including libwebp's private
  libsharpyuv dependency.

## 0.1.3 - 2026-09-24

- Fix native macOS libheif configuration by excluding its unused TIFF helper
  integration from the bundled decoder build.

## 0.1.2 - 2026-09-24

- Add macOS 13 arm64/x64 Electron packaging configuration and native CI while
  preserving the Omarchy build and Linux quality workflow.
- Add checksum-locked official-source builds for FFmpeg/x264, ImageMagick image
  delegates, Perl, and ExifTool, plus package/Mach-O/sanitized-PATH validation.
- Add unsigned CI artifact behavior, conditional tag signing/notarization, and
  GPL/LGPL corresponding-source and relinking-material assembly.
- Add relocatable bundled Perl, replaceable libheif/libde265 libraries, targeted
  hardened-runtime entitlements, relocated GUI smoke tests, and strict Mach-O
  dependency closure validation.
- Contain Electron browser/session state under the documented Records data root
  and use stable-run-aware exponential backend crash recovery.

## 0.1.1 - 2026-09-24

- Include all generated font and MapLibre styles in the install-ready bundle.
- Make clean-install bundle and release validation reproducible on Arch Linux.

## 0.1.0 - 2026-09-24

- Initial public Omarchy plugin release.
- Local-first photo and video indexing, timeline, memories, maps, metadata
  editing, duplicate management, and profile isolation.
- Omarchy service, bar widget, panel actions, and native reminders.
- File-authoritative metadata with regenerable indexes and derivative caches.
