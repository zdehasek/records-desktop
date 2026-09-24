# Contributing

## Development

Records targets current Omarchy with Node.js 22 or newer. Install the host
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
