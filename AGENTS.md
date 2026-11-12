# AGENTS.md

Orphan branch that publishes a Safari [Userscripts](https://github.com/quoid/userscripts) edition of Bilibili Evolved. It contains no upstream source; it wraps the upstream release `dist/bilibili-evolved.user.js`.

- `safari/adapter.js`: runtime adapter. The content side preloads `GM.*` storage and injects the upstream script into page context; the page side provides sync `GM_getValue/GM_setValue/GM_deleteValue`, `GM_info`, `unsafeWindow`, a `GM_xmlhttpRequest` bridge over `MessageChannel`, and no-op menu commands. Falls back to content context if page injection is blocked.
- `safari/build.mjs`: downloads upstream (or takes a local path), inlines lodash after verifying the upstream-pinned sha256, rewrites metadata, writes `dist/bilibili-evolved.safari.{user,meta}.js`.
- `.github/workflows/safari-userscripts.yml`: rebuilds every 6 hours and on changes under `safari/`, commits `dist/` only when it changes.
- Version is `<upstream version>.<ADAPTER_REVISION>`; bump `ADAPTER_REVISION` in `build.mjs` whenever `adapter.js` changes so Userscripts picks up the update.
- Userscripts quirks: `GM_xmlhttpRequest` does not default `method` to GET (the adapter fills it in); no menu command API; `GM` APIs exist only with `@inject-into content`.
- Verify in Safari via AppleScript `do JavaScript` in a temporary tab: `window.bilibiliEvolved`, `window.lodash`, and `bilibiliEvolved.monkeyApis` storage/xhr round trips.
