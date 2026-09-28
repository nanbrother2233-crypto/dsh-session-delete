# Security Policy

[中文说明](SECURITY.zh.md)

## Trust model

This plugin runs inside the DSH host with the user's permissions, and its entire
purpose is to destroy user data permanently. Treat that as its authority.

Nothing it operates on is trusted. Session headers are read from logs on disk,
session ids arrive in HTTP request bodies, and project directory names are a
*lossy* encoding of a working directory that may no longer match anything. Every
one of those is validated structurally, or refused.

A plugin listing, an installation, or this document is not a security review. It
records what the code is built to do, not a guarantee that it is safe.

## Authority boundary

- The plugin deletes a directory only when it is exactly
  `<data-dir>/sessions/<one project directory>/<encoding of the session id>`.
  Ids are never concatenated into a path: the log is found by scanning for a
  directory whose name equals the *injective* encoding of the id, and that
  encoding cannot emit a path separator.
- A session is deleted only when it is not live, not unmaterialised, not the
  session the caller is viewing, and not a duplicate id on disk. **Any** blocker
  cancels the entire plan, so a run never deletes part of a selection.
- The plan is re-derived at execution time from a fresh read of the session
  corpus, not reused from the preview: a session can go live between the two.
- All mutating routes require `content-type: application/json` and an
  `x-dsh-session-delete: 1` marker header — both non-simple, so a browser must
  preflight them — and a delete additionally requires `confirm: true`.
- Live sessions are strictly read-only to this plugin. It cannot stop, detach or
  close one, and it does not try.
- `workspace.json` is never rewritten by this plugin. Workspace membership is
  dropped only through the registry's own `detachSession`, and a failure there is
  cosmetic, because stale membership is filtered on read anyway.
- The shared history-cache document is never deleted; only the named keys of the
  sessions that were deleted are removed from it.
- The host half opens no network connection and holds no credential. The browser
  half calls only same-origin `/api/session-delete/*` paths.

These rules constrain authority and identity. They do not make a third-party
plugin safe.

## Residual risk

- **The local port is the perimeter.** The harness webserver applies no
  authentication and no origin check before it dispatches: an *exact* route is
  invoked directly, ahead of the Connection fence that guards DSH's own RPC
  channel and the SPA fallback — and these routes are exact routes. A bare
  request to that port may still answer `401 unauthorized`, but that fence is not
  in front of these. The guard header and the JSON content type stop a *browser*
  from being tricked into a cross-site delete; they do nothing against a local
  process that can reach the port and choose its own headers.
- **Deletion is not secure erasure.** The files are unlinked, not overwritten. A
  filesystem or disk recovery tool may still find the bytes. Use full-disk
  encryption if that matters.
- **A delete is irreversible.** There is no trash, no undo and no receipt. The
  built-in *Archive session* keeps the data; this plugin does not.

## Reporting a vulnerability

Report suspected vulnerabilities privately to
[2968942779@qq.com](mailto:2968942779@qq.com). Include the affected version or
commit, operating system, reproduction steps, expected impact, and a minimal
proof of concept that can be shared safely.

Do not include secrets or personal data, and do not open a public issue for an
unpatched vulnerability. Ordinary bugs and feature requests may use the public
issue tracker.
