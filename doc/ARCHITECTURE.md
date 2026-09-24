# Architecture

Records is an Omarchy shell plugin with three process boundaries.

1. Quickshell loads one `Service.qml` instance.
2. That service starts a dependency-free Node.js 22 profile bootstrap and backend.
3. Node serves SolidJS to an isolated Chromium app profile.

QtWebEngine never runs inside Quickshell. A Chromium renderer failure therefore
cannot terminate the shell, notification service, or bar.

## Backend

`runtime/server.js` binds an ephemeral port on `127.0.0.1`. Each process uses a
random 256-bit URL prefix. Requests outside that prefix return `404`.

The server provides:

- Static frontend assets
- Allowlisted JSON RPC calls
- Local attachment streaming with byte ranges
- Server-sent change events
- On-demand thumbnail generation through ImageMagick and FFmpeg
- A loopback PMTiles proxy with an SQLite XYZ tile cache

SQLite uses Node's built-in `node:sqlite` as a disposable, regenerable index.
Its main database has one `attachments` projection table, no migration history,
and no arbitrary authoritative metadata. Duplicate canonical choices and root
names/paths live in YAML. Mutations write, install, reread, and verify the
authoritative file before updating the projection. Deletion is move-only through
the desktop system Trash and creates no restoration records.

Existing indexes are accepted only after exact schema/object verification and
SQLite `quick_check`. Incompatible, corrupt, and non-SQLite index files are
discarded; operational errors such as busy, read-only, full, permission, and I/O
failures are surfaced without destructive recovery.
The independent thumbnail and tile SQLite caches follow the same destructive
recovery classification even though their contents are entirely disposable.

The media scanner reconstructs projections from source files and optional video
companions. On transient photo metadata-extraction failure it installs a
filesystem fallback that is retried without requiring a source change; an
existing row keeps previously extracted intrinsic values until retry succeeds.
Temporarily offline enabled roots retain their rows. Disabled or removed
roots prune only their projections and associated disposable
derivatives, never the source files.
Video candidates are admitted only after FFprobe succeeds and reports at least
one video stream. Silent videos and videos with embedded audio are valid;
standalone and containerized audio-only files are ignored and remain untouched.
Legacy journal files are likewise outside the scanner and remain untouched.
Incremental revisions include the absolute root path, media stat identity, and
video companion identity/content. This detects same-timestamp companion edits and
prevents a changed root path from inheriting a colliding old projection.

Thumbnails and streamable-video derivatives use a source identity and filesystem
revision derived from physical paths and file stats, not attachment row IDs.
Generation rechecks that identity and revision before publishing a result, so a
replaced source or a cache clear cannot install stale work.

## Frontend

The SolidJS frontend accesses only `records-api.js`. That adapter mirrors the
existing repository namespaces over loopback RPC. Media URLs remain ordinary
same-origin HTTP URLs.

## Storage

The global `${XDG_CONFIG_HOME:-$HOME/.config}/records/active-profile` marker
selects a profile before backend imports initialize storage. Configuration lives
under `records/profiles/<profile>/config.yaml` in the config home. The disposable
index and generated caches use the same profile namespace in the cache home.
Each profile config stores a set of non-overlapping media roots and the immutable
name of one enabled default root. Every enabled root is scanned recursively in
place. Media added by the application is written under
`<default-root>/records/YYYY/MM/DD/` and uses that parent root's identity.
Durable duplicate choices and Chromium state use the profile namespace in the
data home. A pending profile switch becomes active only after the candidate
backend reaches readiness. Only config version 4 and its current fields are
accepted. Obsolete versions or fields fail without migration, rewriting, or
compatibility accessors.

Photo editable fields live in XMP/EXIF/IPTC metadata; XMP
`PresentationColor` is only the image encoding of `note_style.color`. Video
fields and captions live in optional same-name Markdown companions, with color
nested under `note_style.color`. Video duration and stream information,
including embedded audio, come from FFprobe. Every media identity is an
immutable root name plus relative path; absolute paths and SQLite row IDs are
disposable projections. Within `attachments`, `id`, `mtime_ms`, and
`source_revision` are transient. The root/path, MIME, byte size, content,
duration, importance, note color, fingerprint, EXIF projection, and creation
timestamp are reconstructed from configured roots and authoritative files.

Day and range queries select a fresh random featured attachment from important
images and videos. GIF RPC inputs are ordered message IDs or named-root file
references; output is metadata-verified before it is installed in the Records
folder's media child and discovered by the scanner.

The process umask is `0077`. Records repairs the data/profile directories to
`0700` and its private files to `0600` at startup. Watched folders remain
external user-owned media and are never chmodded.

Host-dependent capabilities are queried before SolidJS mounts. Controls for
thumbnail generation and photo-to-GIF creation reflect the available system
tools.

Backend readiness is emitted as soon as the authenticated loopback server is
available. Media projection reconstruction and embedded photo metadata
reconciliation then continue in the background, exposing completed projections
incrementally.

Integration tests use isolated XDG homes. Managed startup rejects direct config
and database path overrides so they cannot bypass profile isolation.

The full quality gate requires runtime source-only coverage of 80% for
statements, lines, branches, and functions, with zero CRAP threshold
failures. Frontend source is instead guarded by complexity linting, Chromium
browser tests, and committed-bundle freshness.
