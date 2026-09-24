# Durable File Formats

Records keeps authoritative user data in ordinary files. SQLite, thumbnails,
map tiles, and streamable-video derivatives are disposable, regenerable caches
and may be deleted at any time. The main `index.sqlite3` contains only an
`attachments` projection table, has no migration history, and stores no
arbitrary authoritative metadata.
The table's generated row IDs, `mtime_ms`, and `source_revision` are transient
bookkeeping. Losing them can repeat indexing work but cannot lose user content.
Thumbnail and streamable-video derivatives are keyed by physical source
identity and filesystem revision, independent of attachment row IDs. A result
is published only if that source revision is still current.

## Data Storage

Every configured media folder is scanned recursively in place. The default
folder also contains a `records/` child for photos, videos, and GIFs added by
Records. Back up all configured media folders.
Pre-existing journal and standalone-audio files are not imported, moved,
rewritten, or deleted; they are outside the Records model. Video-container
candidates require a successful FFprobe result with at least one video stream.

| Data category                                              | Authoritative storage                                                                                              | Cache or projection                          | Backup requirement                          | Safe to lose             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------- | ------------------------ |
| Photos and videos                                          | Original files in each configured media root                                                                       | One row per media file in `attachments`      | Back up every media root                    | No                       |
| Photo captions, dates, GPS, important state, and color     | XMP, EXIF, and IPTC inside each photo                                                                              | Selected columns in `attachments`            | Included with the original photos           | No                       |
| Video captions, date overrides, important state, and color | Optional same-name Markdown companions                                                                             | Selected columns in `attachments`            | Included when backing up media roots        | No                       |
| Video duration, video codec, and embedded-audio stream     | Intrinsic video stream metadata read with FFprobe                                                                  | Selected columns in `attachments`            | Rebuilt from the original video             | Yes, the projection only |
| Visibility and category                                    | Media location under `.nsfw/` or `.hidden/`                                                                        | Root-relative media path in `attachments`    | Included with configured roots              | No                       |
| Duplicate canonical choices                                | `${XDG_DATA_HOME:-$HOME/.local/share}/records/profiles/<profile>/duplicates/*.yaml`                                | Resolved against indexed root-relative paths | Back up the profile `duplicates/` directory | No                       |
| Profile selection, media roots, and settings               | `records/active-profile` and profile `config.yaml` under the config home                                           | Not stored in SQLite                         | Back up the Records config directory        | No                       |
| Browser filters and sidebar width                          | Profile browser local storage; macOS Electron partitions live under `Application Support/records/electron/session` | None                                         | No backup required                          | Yes                      |
| Main index, thumbnails, and map tiles                      | None                                                                                                               | Profile cache SQLite files                   | Do not back up                              | Yes                      |
| Map glyphs and streamable-video derivatives                | Profile cache files                                                                                                | Entirely disposable                          | Do not back up                              | Yes                      |
| Files deleted through Records                              | Desktop system Trash                                                                                               | No Records tombstone or restore database     | Use the desktop Trash or a separate backup  | No                       |

## Configuration

Configuration for profile `<profile>` lives at
`${XDG_CONFIG_HOME:-$HOME/.config}/records/profiles/<profile>/config.yaml`:

```yaml
version: 4
profile:
  name: Production
media:
  roots:
    - name: camera
      path: /mnt/photos
      enabled: true
    - name: pictures
      path: /home/alex/Pictures
      enabled: true
  defaultRoot: pictures
```

`media.roots` is the complete set of folders scanned in place. Root names use
lowercase letters, numbers, hyphens, and underscores and are immutable internal
identities. Configured paths cannot overlap or alias one another. `defaultRoot`
names the enabled folder whose `records/YYYY/MM/DD/` child receives media added
through Records; scans never copy discovered files. The first folder added is
selected automatically. Records preserves comments and supported configuration
keys when it updates an owned setting. Only config version 4 is accepted; older
formats are rejected without migration or rewriting. The global private
`records/active-profile` file contains only the active path-safe profile ID.

Media references use `<root-name>:<relative-path>`, for example
`camera:2026/holiday/photo.jpg` or
`pictures:records/2026/09/18/imported.jpg`. Relative paths never begin with `/` and cannot
contain `..` segments.

## Visibility Paths

Visibility is represented only by location inside each configured root:

```text
Trips/photo.jpg
.nsfw/general/Trips/photo.jpg
.hidden/general/Trips/photo.jpg
```

The segment after `.nsfw` or `.hidden` is a category. `general` is the default.
The remaining path is the original relative path used when making the file
visible again. Categories are single directory names and cannot be `.`, `..`,
`.records`, `.nsfw`, or `.hidden`.

Existing video companions move with their video. Records rejects a move if its
destination already exists and never removes empty user directories.

## Video Companions

A video companion is created only after its first editable caption or metadata
change. Its name is the complete video filename plus `.md`, such as
`holiday.webm.md`:

```markdown
---
date_override: "2026-09-03T14:20:00+02:00"
important: true
note_style:
  color: butter
---

Video caption text.
```

All frontmatter fields are optional. `note_style.color` accepts `white`,
`butter`, `blush`, `mint`, `sky`, or `lavender`. The body is the caption.
Unknown frontmatter keys and comments are preserved. Identity and visibility
are derived from the video path, not companion metadata. Duration and stream
types, including embedded audio, are read from the video itself and are not
duplicated in frontmatter. Video companions do not recognize
`presentation_color` as an alias; color is represented only by
`note_style.color`.

## Photo Metadata

Photos store editable values in the image itself:

- Caption: XMP `dc:Description`, mirrored to IPTC `Caption-Abstract` and EXIF
  `ImageDescription`.
- Important: custom boolean `XMP-records:Important`.
- Note color: encoded as custom string `XMP-records:PresentationColor`. The XMP
  name is an image-file encoding detail for `note_style.color`.
- Capture timestamp: EXIF `DateTimeOriginal` plus `OffsetTimeOriginal`, with XMP
  `CreateDate` retaining the exact offset-bearing timestamp and fractional
  seconds. Records verifies all three values after writing and prefers the
  validated XMP value when reconstructing the projection.
- GPS coordinates, camera make, and camera model: standard image metadata
  fields.

Records ignores but preserves retired Records UUID, visibility, keyword/tag,
and numeric-rating metadata. Unsupported, read-only, symlinked, hard-linked, or
unverifiable photos are view-only.

## Attachment Updates

The attachment update RPC accepts a non-empty object containing only `content`,
`important`, `noteColor`, `createdAt`, `Make`, `Model`, `latitude`, and
`longitude`. Unknown and extractor-owned fields are rejected before source or
projection writes. `content` is a string, `important` is boolean, `noteColor`
is null or one of the six companion colors, and `createdAt` is a valid non-empty
ISO 8601 timestamp. `Make` and `Model` are strings or null. Latitude and
longitude are finite in-range numbers or both null and must be supplied
together.

Video updates support only `content`, `important`, `noteColor`, and
`createdAt`; camera and GPS fields are image-only. The update API has no
`presentation_color` alias. Successful writes update the authoritative image
metadata or companion before the SQLite projection.

## Disposable Database Recovery

At startup Records accepts the main index only when its application ID, schema
version, complete table/index definitions, object set, and SQLite `quick_check`
all match. A missing index is created from scratch. Incompatible legacy schemas,
corrupt databases, and non-SQLite files cause only the main `index.sqlite3`,
`-wal`, and `-shm` family to be replaced before scanning the authoritative
roots. Busy, locked, read-only, full, permission, and I/O errors are surfaced
without deleting the existing index. Recovery never writes media, companions,
configuration, duplicate choices, or independent generated caches.

Thumbnail and map-tile SQLite files are also disposable, but their recovery is
not allowed to hide operational failures. Records rebuilds them only for an
incompatible schema, failed `quick_check`, corruption, or a non-SQLite file;
busy, locked, read-only, full, permission, and I/O failures preserve their
database/WAL/SHM family and are surfaced.

## Duplicate Choices

Each explicit canonical duplicate choice lives at
`${XDG_DATA_HOME:-$HOME/.local/share}/records/profiles/<profile>/duplicates/<fingerprint>.yaml`:

```yaml
version: 1
fingerprint: 0123456789abcdef
canonical:
  root: camera
  path: 2026/holiday/photo.jpg
duplicates:
  - root: records
    path: imports/photo.jpg
```

Image fingerprints describe decoded pixels; video fingerprints are content
hashes. Missing canonical paths remain unresolved rather than being
silently replaced. Records rewrites references for deliberate visibility or
category moves performed by Records, but not for external filesystem moves.
