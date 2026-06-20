# Ship Gate

> No repo is "done" until every applicable line is checked.
> Copy this into your repo root. Check items off per-release.

**Tags:** `[all]` every repo · `[npm]` `[pypi]` `[vsix]` `[desktop]` `[container]` published artifacts · `[mcp]` MCP servers · `[cli]` CLI tools

---

## A. Security Baseline

- [x] `[all]` SECURITY.md exists (report email, supported versions, response timeline)
- [x] `[all]` README includes threat model paragraph (data touched, data NOT touched, permissions required) — "Security & Trust" section
- [x] `[all]` No secrets, tokens, or credentials in source or diagnostics output
- [x] `[all]` No telemetry by default — stated explicitly in README "Security & Trust"

### Default safety posture

- [ ] `[cli|mcp|desktop]` SKIP: no dangerous actions exist — roll is a pure computation tool (no kill/delete/restart). The only side effect is reading one `--loot` JSON file.
- [x] `[cli|mcp|desktop]` File operations constrained — read-only, a single user-named `--loot` JSON; no writes anywhere
- [x] `[mcp]` Network egress off by default — no network code in the package at all
- [x] `[mcp]` Stack traces never exposed — catch-all returns a generic "Internal error"; detail logged to stderr only (Stage A hardening)

## B. Error Handling

- [x] `[all]` Errors follow a structured shape — `ParseError`/`LexerError` carry message + position; CLI prints `Error: <message>` + a `--help` hint; bridge/MCP return JSON-RPC `code`/`message`
- [x] `[cli]` Exit codes: `0` ok · `1` error. (SKIP 2/3: a stateless roller has no runtime/partial-success states — every failure is a user/input error → exit 1.)
- [x] `[cli]` No raw stack traces — top-level try/catch maps every failure to one clean line (no raw Node frames ever reach the user)
- [x] `[mcp]` Tool errors return structured results — server never crashes on bad input (per-request try/catch + uncaughtException/unhandledRejection handlers)
- [x] `[mcp]` Graceful degradation — roll is stateless, so there is no config/state to corrupt; one bad request never affects others (per-item batch resilience)

## C. Operator Docs

- [x] `[all]` README is current — what it does, install, usage, supported platforms + Node version
- [x] `[all]` CHANGELOG.md (Keep a Changelog format)
- [x] `[all]` LICENSE file present and repo states support status (SECURITY.md supported-versions table)
- [x] `[cli]` `--help` output accurate for all commands and flags (V2 notation + all flags incl. --seed/--no-color/--verbose/queries)
- [x] `[cli|mcp|desktop]` Logging levels defined — normal + `--verbose`/`ROLL_BRIDGE_DEBUG` on the bridge/MCP, `--no-color`/`NO_COLOR` for the CLI; no secrets exist to redact at any level
- [x] `[mcp]` All tools documented with description + parameters (`tools.ts` inputSchema per tool)
- [ ] `[complex]` SKIP: not a complex stateful service — the Starlight handbook at `/handbook/` covers operator docs; no warn/critical runbook needed for a pure computation tool

## D. Shipping Hygiene

- [x] `[all]` `verify` script exists — `build && typecheck && test`
- [x] `[all]` Version in manifest matches git tag — package.json 2.1.0, tagged v2.1.0 at release
- [x] `[all]` Dependency scanning runs in CI — `npm audit --audit-level=high` step in ci.yml
- [ ] `[all]` SKIP: zero runtime dependencies; the dev-tooling tree is audited in CI and updated manually (org CI-cost policy: no Dependabot)
- [x] `[npm]` `npm pack --dry-run` includes dist/, README.md, CHANGELOG.md, LICENSE (verified)
- [x] `[npm]` `engines.node` set (`>=22`)
- [x] `[npm]` Lockfile committed
- [ ] `[vsix]` SKIP: not a VS Code extension
- [ ] `[desktop]` SKIP: not a desktop app

## E. Identity (soft gate — does not block ship)

- [x] `[all]` Logo in README header (brand repo, 400px, centered)
- [x] `[all]` Translations (polyglot-mcp, 7 languages + English)
- [x] `[org]` Landing page (@mcptoolshop/site-theme) — https://mcp-tool-shop-org.github.io/roll/
- [x] `[all]` GitHub repo metadata: description, homepage, topics

---

## Gate Rules

**Hard gate (A–D):** Must pass before any version is tagged or published.
If a section doesn't apply, mark `SKIP:` with justification — don't leave it unchecked.

**Soft gate (E):** Should be done. Product ships without it, but isn't "whole."
