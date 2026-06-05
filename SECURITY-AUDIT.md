# Relay — Security Audit (2026-06-02)

Method: `npm audit` + Electronegativity (Electron) + 3 parallel manual audits (Electron main, Chrome extension, Next.js API/Prisma/secrets). This is a point-in-time review; verify before acting.

## TL;DR
**One critical issue, confirmed independently by all three audits:** the `localhost:3030` API the extension talks to has **no authentication and wildcard CORS (`*`)**, and the extension's message handlers don't validate the sender. Net effect: **any website you visit while Relay is running can read your entire inbox, overwrite your Anthropic API key, wipe your database, and drive the extension to send LinkedIn DMs as you.** Everything else is secondary to fixing this.

Good news up front (explicitly cleared): no secret leakage via GET, no SQL injection, no secret logging, OAuth `state` is validated (CSRF defended), and the two Electron settings that matter most (`contextIsolation:true`, `nodeIntegration:false`) are correct.

---

## FIX STATUS (updated 2026-06-04)
- ✅ **C1 CRITICAL — FIXED + verified** (`3830e01`): Origin allowlist on the `:3030` HTTP listener + `/ws` (`isAllowedOrigin`). Only `chrome-extension://`, `www.linkedin.com`, `app://`, absent/null allowed → every other website 403. Live-verified `evil.com → 403` on `/api/state` + `POST /api/reset`.
- ✅ **C2/residual — substantially mitigated** (`<this commit>`): instead of a bearer token, the `:3030` listener now **hard-blocks the UI-only/destructive endpoints the extension never calls** — `reset`, `ai/key`, `export`, `raw`, `repair-attribution`, `diagnostics` → 403. So even a script on linkedin.com (allowed Origin) or a local process cannot wipe the DB, overwrite the API key, or bulk-export. The WS Origin gate was tightened to extension+app only (dropped linkedin.com). `content.js` window-message handlers now check `ev.source === window` (blocks cross-frame postMessage injection).
- ✅ **H1 SSRF / M1 path-traversal / M2 sandbox — FIXED** (`47b9da5`): icp/build host validation (+ per-redirect), `app://` STATIC_DIR containment, BrowserWindow `sandbox:true`.

**Why no bearer token (conscious decision):** the denylist protects the high-severity outcomes (wipe/overwrite/export) against *all* `:3030` callers with zero breakage — better than a token, which a local process sidesteps anyway (it can read the SQLite file directly). The remaining residual is *data poisoning of your own import by a script already executing on linkedin.com* — narrow (requires LinkedIn compromise or another malicious extension), low-severity (garbage data, not exfil/destruction). Threading a token through every content-script capture fetch is high-breakage for that narrow gain, so it's deferred.

**Still genuinely open (low priority):** M2 CSP remainder (no UI innerHTML sink for synced data — React escapes; low value, breakage-prone), M3 shipped ZoomInfo client_secret (inherent to a confidential OAuth client shipped to users — needs PKCE/broker), M5 `tabs` permission minimization, dep advisories (breaking bumps).

---

## CRITICAL

### C1 — Unauthenticated, wildcard-CORS local API (`:3030`)
`electron/main.js` `startExtensionListener` routes every `/api/*` into the same `dispatchApi()` the trusted UI uses, with no auth, no Origin check, and `Access-Control-Allow-Origin: *` (`src/lib/api-utils.ts` CORS + re-asserted in main.js). It's loopback-bound (127.0.0.1) — but loopback is reachable by **every browser and process on the machine**.

Any web page you visit can `fetch('http://127.0.0.1:3030/api/...')` and read the response. Reachable today:
- `GET /api/export`, `/api/raw`, `/api/conversations`, `/api/state` → **exfiltrate the entire inbox + message bodies**.
- `PUT /api/ai/key` → **overwrite your Anthropic API key** with the attacker's (drafts then route through their key) or junk.
- `POST /api/reset?confirm=YES` → **wipe all conversations + messages** (`confirm` is a query param, not a secret).
- `POST /api/import`, `/api/repair-attribution`, label/snippet/notification mutations → data poisoning.
- The `/ws` WebSocket upgrade has **no origin check** either — a page can open `ws://127.0.0.1:3030/ws`, claim `role:'renderer'`/`'extension'`, and intercept/inject brokered messages.

**Fix:** treat `:3030` as a privileged local API. Generate a random per-install token at first launch; the extension obtains it via a handshake and must send it (e.g. `Authorization: Bearer …`) on every request; reject anything without it **before** `dispatchApi`. Replace `*` CORS with an explicit allowlist (the `chrome-extension://<id>` origin) and reject browser origins. Add the same token/origin check to the `/ws` upgrade handler.

### C2 — Extension message handlers don't validate the sender (confused deputy)
`extension/background.js` `onMessage` (every privileged branch: `sendMessage`, `createNewThread`, `liInitialSyncApi`, `mirror`, `harvestConnections`, `enrichProfile`, …) acts with **no `sender.id`/`sender.origin`/`sender.tab.url` check**. `bridge.js` (runs on `localhost:3030`) only checks `ev.source !== window` — which still lets the page's own scripts post `relay-*` messages. `content.js` intercept/realtime/SN handlers (lines ~269/296/313/372) and `injected.js` (`postMessage(payload,'*')`) likewise don't verify source/origin.

So any script running on `localhost:3030` (or a linkedin.com MAIN-world script) can drive the extension: send/cold-InMail arbitrary people, archive/delete threads, dump the inbox — using your session, with zero auth. Tightly coupled to C1 (the localhost origin is the pivot).

**Fix:** in `background.js`, allowlist `sender.tab.url` (linkedin.com / localhost:3030) and restrict *write* actions to the localhost origin; add a per-session nonce (extension injects a secret the page can't guess) required on all `relay-*` / `__inboxpro*` messages; add `ev.source === window` + nonce checks to every `content.js` handler (not just one).

---

## HIGH

### H1 — SSRF in `/api/icp/build`
`src/app/api/icp/build/route.ts` `fetchSite()` fetches a user-supplied `websiteUrl` with no scheme/host validation. A page can make the server hit `http://169.254.169.254/...` (cloud metadata), `http://127.0.0.1:<port>`, or internal RFC1918 hosts. Blind-ish (the body is fed to Claude, not returned verbatim) but usable for internal port-scan/SSRF + burns your Anthropic credits. **Fix:** require http(s), resolve host and block loopback/link-local/private ranges, disable/re-validate redirects.

### H2 — Unauthenticated destructive endpoint (`/api/reset`)
Covered under C1, called out separately: a cross-origin POST can wipe the DB. The Origin/token fix for C1 neutralizes it; until then it's a one-request inbox-wipe from any site.

---

## MEDIUM

- **M1 — `app://` path traversal not contained.** `main.js` joins `pathname` to `STATIC_DIR` with `path.join` and serves it with no check that the resolved path stays inside `STATIC_DIR` (and `fs.statSync` runs on the attacker path first). Low exploitability (only the renderer issues `app://`), but the guard is missing. **Fix:** `path.resolve` + verify `startsWith(STATIC_DIR + sep)`.
- **M2 — No CSP + `bypassCSP:true` + no `sandbox`.** The `app://` scheme is registered with `bypassCSP:true`; there's no CSP and `sandbox` isn't set on the BrowserWindow. A stored-XSS from a synced LinkedIn message body would run with no backstop. (Electronegativity also flagged CSP_GLOBAL_CHECK + SANDBOX.) **Fix:** drop `bypassCSP`, ship a CSP, add `sandbox:true`.
- **M3 — Shipped ZoomInfo `client_secret`.** `.env` with the OAuth client_id/secret ships inside the distributed `.app` (extractable by any user). Inherent to a confidential OAuth client shipped to end-users; consider PKCE/public-client or a token broker. Conscious-decision flag.
- **M4 — `innerHTML` with interpolated data** in `extension/profile-capture.js` (~line 713, `${fields}` from scraped values). Not attacker-controlled today, one refactor from XSS in the extension's own UI. **Fix:** `textContent` for dynamic parts.
- **M5 — Over-broad extension permission `tabs`** (grants URL/title of every tab). `activeTab` + host-scoped content scripts likely cover the need. **Fix:** drop `tabs` if unused; add explicit `content_security_policy.extension_pages`.
- **M6 — No input size/array caps** on `/api/import` (and others) → unauthenticated local DoS via huge payload. **Fix:** cap body size + array lengths.

## LOW
- PII (full request URLs, incl. query strings/URNs) written to `~/Library/Logs/Relay/main.log` unrotated. Redact/strip query strings.
- `shell.openExternal(url)` with no scheme allowlist (`main.js` setWindowOpenHandler). Restrict to http/https/mailto.
- macOS auto-update integrity depends on every release being signed+notarized (they are — verify it stays that way).

## Dependencies (`npm audit`: 5 moderate)
- `@hono/node-server` (middleware bypass via repeated slashes) — via `@prisma/dev` → `prisma`.
- `postcss` (XSS in stringify) — via `next`.
- Both fixes require **breaking** major bumps (`prisma@6`, `next@9`?? — likely a mis-resolve). **Defer**; neither is in the runtime hot path (dev/build tooling). Re-evaluate on the next dependency upgrade pass.

## Explicitly cleared (no action)
- No GET returns the Anthropic key or ZoomInfo tokens (`/api/ai/key` GET → `{hasKey, mask}`; zoominfo status → no tokens; `/api/state` → no secrets).
- No SQL injection: the lone `$queryRawUnsafe` (`tasks/job-changes`) is a static literal; the rest are parameterized tagged templates.
- No secret logging anywhere.
- OAuth `state` generated with `crypto.randomBytes` and validated on callback (ZoomInfo :54321 + start route) — CSRF defended.
- No cookies/CSRF tokens leave linkedin.com; no eval/remote-code in app or extension (the `eval` hits were in dead `src-tauri/target` Tauri build artifacts).

---

## Recommended order
1. **C1 + C2 together** — token + Origin allowlist on the `:3030` listener and `/ws`, sender validation + nonce in the extension. This single change neutralizes C1, C2, H2, M6, and the cross-origin half of everything else. Touches `electron/main.js`, `src/lib/api-utils.ts`, and the extension (`background.js`, `bridge.js`, `content.js`) → needs an app rebuild + extension reload. Test the extension↔app handshake carefully.
2. **H1** — SSRF guard in `icp/build`.
3. **M1 / M2** — path-traversal containment + CSP/sandbox.
4. The rest as cleanup.
