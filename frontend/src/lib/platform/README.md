# Platform API

Renderer code accesses the local Omarchy backend through `useApi()` and
`records-api.js`. The adapter exposes allowlisted loopback JSON RPC methods,
same-origin media URLs, and server-sent events.

Keep namespace and event contracts stable. Media must use the attachment URL
helpers instead of hardcoded paths. Every push subscription returns an
unsubscribe function.

`api.capabilities` controls host-specific UI. Omarchy owns plugin updates, so
application updates and developer tools remain disabled. Media import,
thumbnails, scanned media folders, video remux/transcoding and streaming, and offline
map caching use documented host commands without runtime npm dependencies.
