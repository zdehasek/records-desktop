# Security Policy

## Supported Versions

The latest `0.1.x` release receives security fixes. Older tags are unsupported.

## Reporting

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability report form:

https://github.com/zdehasek/records-desktop/security/advisories/new

Include the affected version, impact, reproduction steps, and any suggested
mitigation. Avoid attaching personal media or Records profile data. A response
should arrive within seven days.

Records plugins run unsandboxed as the current user. Marketplace validation is
not a security audit.

The macOS renderer is sandboxed, but the Electron main process and backend have
the current user's access to explicitly selected media folders. Packaged media
tools are checksum-locked and resolved only inside `Records.app`; production
does not fall back to `PATH` or Homebrew. Release checksums and code signatures
establish artifact provenance. Unsigned CI artifacts require a deliberate local
Gatekeeper override and should never be opened unless their workflow origin and
checksum have been verified.
