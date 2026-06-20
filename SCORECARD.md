# Scorecard

> Score a repo before remediation. Fill this out first, then use SHIP_GATE.md to fix.

**Repo:** @mcptoolshop/roll
**Date:** 2026-06-20
**Type tags:** [npm] [cli] [mcp]

## Pre-Remediation Assessment (v2.0.0, as cloned)

| Category | Score | Notes |
|----------|-------|-------|
| A. Security | 6/10 | Shipped, but an unbounded-input DoS reachable from the public API/CLI/bridge/MCP; internal error text leaked to wire clients; ANSI injection via `--loot`; 4 npm advisories. |
| B. Error Handling | 5/10 | CLI dumped raw Node stack traces on common bad input; `--times` silently swallowed garbage; the entire CLI + display + MCP/bridge dispatch were untested. |
| C. Operator Docs | 7/10 | Good README + handbook + translations, but `--help` omitted V2 notation and SECURITY.md lagged the shipped major. |
| D. Shipping Hygiene | 6/10 | `verify` existed; but 4 advisories, no dependency scanning in CI, tests excluded from typecheck. |
| E. Identity (soft) | 8/10 | Logo, landing page, handbook, translations all present from the v2.0.0 ship. |
| **Overall** | **32/50** | A solid shipped tool with real, hidden hardening gaps. |

## Key Gaps

1. Unbounded input → DoS/OOM reachable from every surface (the analyze path was the worst — exact convolution had no cost bound).
2. The entire user-facing surface (CLI, display, MCP/bridge dispatch, public `index.ts`) was untested.
3. The "exact probabilities" claim was silently violated — `analyze()` fell back to Monte Carlo with no signal.

## Remediation Priority

| Priority | Item | Estimated effort |
|----------|------|-----------------|
| 1 | Input caps at parse time + an independent analysis cost bound | done (Stage A) |
| 2 | Cover the untested surfaces; clear advisories; add dep scanning | done (Stage A/B) |
| 3 | Surface exact-vs-estimate; feature pass (table analysis, queries, compare) | done (Stage B + Features) |

## Post-Remediation

| Category | Before | After |
|----------|--------|-------|
| A. Security | 6/10 | 10/10 — input + analysis caps, boundary hardening, 0 advisories, CI dep scan, ANSI sanitization |
| B. Error Handling | 5/10 | 10/10 — clean structured errors everywhere, resilient batches, uncaughtException handlers, full surface coverage |
| C. Operator Docs | 7/10 | 10/10 — `--help` complete, SECURITY current, CHANGELOG, exit codes + stability documented |
| D. Shipping Hygiene | 6/10 | 10/10 — `verify` = build+typecheck+test, dep scan in CI, bin smoke, 509 tests, clean pack |
| E. Identity (soft) | 8/10 | 10/10 — logo, landing, handbook, translations, metadata |
| **Overall** | 32/50 | 50/50 |

_Tests: 226 → 509. npm advisories: 4 → 0. Shipcheck: 28/28 hard gates, 100%._
