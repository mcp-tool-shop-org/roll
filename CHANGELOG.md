# Changelog

## [Unreleased]

## 2.1.0

A full health-pass + feature-pass release. Hardening across the engine and the
two wire surfaces, an honesty pass on the probability claims, and a new family
of analysis capabilities for game-balance work. Test suite grew 226 → 509.

### Added

- **Table analysis** — `analyzeTable` / `analyzeCollection` compute a loot/encounter
  table's *exact* outcome distribution: each entry's real selection probability
  (after weights, level filtering, and conditions, matching what `weightedSelect`
  actually rolls), the value mean/distribution of `roll`/`quantity` fields, and the
  excluded entries with the reason. Surfaced as the MCP `analyze_table` tool and the
  bridge `table_analyze` method.
- **Comparison as probability** — `compareDistributions` and `--compare` now answer
  "which build wins?": `P(A>B)`, `P(tie)`, `P(B>A)`, and the full `A − B` margin
  distribution. Also on the bridge (`compare`) and MCP (`compare_dice`).
- **Probability query family** — `probabilityAtMost` / `probabilityExactly` /
  `probabilityInRange` alongside the existing `probabilityAtLeast`, plus
  `cumulativeDistribution` (CDF), `survivalDistribution`, and `targetForProbability`
  (the break-even DC solver: "what target succeeds 65% of the time?"). CLI flags
  `--at-most` / `--exactly` / `--between lo..hi` / `--target-for p`; bridge methods
  `at_most` / `exactly` / `between`; MCP `analyze_dice` query block.
- **`analyze()` reports its method** — the return value now carries
  `method: "exact" | "monte-carlo"` (+ `samples`), so callers can tell exact
  probabilities from sampled estimates. The CLI labels Monte-Carlo results
  (`~ estimated via Monte Carlo (N samples) — not exact`).
- **CLI `--seed <int>`** — reproducible rolls (the engine, bridge, and MCP already
  supported seeds; the CLI now does too). One PRNG is threaded through `--times`.
- **CLI `--no-color`** flag (in addition to honoring `NO_COLOR`).
- **Bridge/MCP observability** — an injectable logger seam, an opt-in `--verbose` /
  `ROLL_BRIDGE_DEBUG` per-request log, and per-item resilient `roll_batch`.

### Security

- **ANSI/terminal-control injection blocked** — externally-sourced strings (loot item
  names, table names, dice/validation echoes from `--loot` files) are sanitized of C0
  control characters, including raw `ESC` bytes, before display.
- **Input caps (DoS prevention)** — dice count, die sides, and expression length are
  capped at parse time; the *analysis* path is independently bounded (an AST dice
  budget plus a convolution compute-cost guard) so a ~15-byte expression like
  `analyze("10000d1000000")` returns a clean error in ~1 ms instead of exhausting memory.
- **Trust boundary** — the bridge/MCP catch-all no longer leaks internal exception text
  (generic "Internal error" to the client, detail to stderr); the HTTP transport caps
  the body, adds request/socket timeouts, and binds `127.0.0.1` by default; `roll_batch`
  expression count, `table_roll` count, and the CLI `--times × dice` product are bounded.
- **All npm advisories cleared** (4 → 0) and `npm audit --audit-level=high` now runs in CI.

### Fixed

- **Probability correctness** — the exact-distribution analyzer now honors explosion
  compare *operators* (`d10!>5` explodes on 6–10, not 5–10); keep/drop combined with
  explosion/reroll falls back to Monte Carlo instead of silently dropping those
  modifiers; degenerate always-reroll and truncated-mass cases are handled; Monte Carlo
  uses one continuous generator stream.
- **Published binaries run under `npm i -g`** — the entry-point detection is now
  symlink-robust (`realpath` both sides), so the global `roll` / `roll-bridge` /
  `roll-mcp` bins no longer silently no-op on macOS/Linux.
- **CLI error handling** — unknown flags, bad option values, and invalid expressions
  print a clean `Error: …` line + a `--help` hint instead of a raw Node stack trace;
  `--times` is validated and capped; a mode flag with no expression errors instead of
  silently printing help; the histogram no longer crashes on an all-zero distribution.
- **Table consistency** — `weightedSelect` guards zero/fractional total weight; V1 loot
  quantity is clamped to ≥1 like the V2 engine; circular-reference reports are deduped.
- **MCP `serverInfo.version`** is read from `package.json` instead of a hardcoded literal.

### Changed

- **`--help` documents the full V2 notation** and all new flags.
- **`noUncheckedIndexedAccess`** enabled; test files are now type-checked
  (`tsconfig.test.json`), folded into `verify`.
- **Exhaustiveness guards** — adding a new dice modifier kind now forces a compile error
  in the analyzer's classifier and the expression serializer, instead of silently
  mis-modeling it.
- **Histogram legend** — the mode/median row markers (`M`/`*`/`~`) now carry a key.
- **CLI is testable in-process** via an exported `run(argv, io)` returning an exit code.

## 2.0.0 (2026-04-11)

Universal game infrastructure release.

### Extended Notation

- **Reroll** — `r` (unlimited), `ro` (once) with compare points: `2d6r<2`, `2d6ro=1`
- **Compounding dice** — `!!` sums explosions into same die: `1d6!!`, `1d6!!>4`
- **Penetrating dice** — `!p` subtracts 1 per explosion: `1d6!p`
- **Min/max clamping** — `min`/`max` per die: `2d6min3`, `2d6max5`
- **Success counting** — `cs` with compare point for dice pools: `8d6cs>=5`
- **Failure counting** — `cf` subtracts from success count: `8d6cs>=5cf<=1`
- **Critical marking** — `cs`/`cf` without compare point for visual highlights
- **Sorting** — `sa`/`sd` for display order: `4d6sa`
- **Full comparison operators** — `>`, `>=`, `<`, `<=`, `=` in all compare points

### Probability Engine

- **Analytical reroll** — exact redistribution of probability mass for rerolled faces
- **Analytical min/max** — exact truncated distributions with piled mass
- **Analytical success counting** — exact binomial-like convolution for dice pools
- **Compounding/penetrating distributions** — exact iterative depth expansion variants
- All V2 modifiers have exact probability analysis, not just Monte Carlo

### Game Table System

- **8 table kinds** — loot, encounter, critical, fumble, reward, status, event, custom
- **4 condition types** — compare (trigger roll), nat (natural die), tag, context variable
- **Level filtering** — minLevel/maxLevel per entry
- **Table chaining** — result of one table triggers rolls on others
- **Dice fields** — roll, quantity, duration expressions per entry
- **Rarity tiers** — common, uncommon, rare, epic, legendary
- **Validation** — missing refs, circular detection, invalid dice, level range sanity
- **V1 bridge** — `convertLootToGameTable()` for migration

### JSON Bridge

- **JSON-RPC 2.0** — 11 methods: roll, roll_batch, analyze, at_least, compare, table_roll, table_load, table_list, seed, ping, shutdown
- **Stdio transport** — newline-delimited JSON for Godot/Unreal child process
- **HTTP transport** — POST /rpc endpoint for network access
- **Deterministic seeding** — session-level seed for reproducible gameplay

### MCP Server

- **5 tools** — roll_dice, analyze_dice, compare_dice, roll_table, query_table
- **Stdio MCP transport** — standard MCP protocol for Claude integration

### Engine Architecture

- **8-stage modifier pipeline** — roll → reroll → min/max → explode → keep/drop → sort → mark → total
- **PipelineDie type** — tracks rerolledFrom, critical markers per die
- **DiceGroupResult.resultMode** — "sum" or "success_count" (backward compatible)
- **ComparePoint type** — operator + value for all comparison-based modifiers

### Numbers

- 226 tests across 9 suites (up from 80)
- Zero runtime dependencies maintained
- Full backward compatibility with V1 API

## 1.0.1 (2026-04-10)

Patch release.

## 1.0.0 (2026-04-10)

Initial release.

### Features

- **Dice expression parser** — full recursive descent parser supporting `NdM`, arithmetic (`+`, `-`, `*`, `/`), parentheses, keep highest/lowest (`kh`, `kl`), drop highest/lowest (`dh`, `dl`), exploding dice (`!`, `!>N`), percentile (`d%`), and Fate dice (`dF`)
- **Probability analyzer** — exact distributions via convolution and enumeration, Monte Carlo fallback for complex expressions
- **Statistics** — mean, median, mode, standard deviation, percentiles (10/25/50/75/90/95), Shannon entropy
- **Terminal histograms** — colored bar charts with mode/median markers
- **Loot table roller** — weighted selection, nested table references, integrated dice expressions for quantity and value
- **Comparison mode** — side-by-side distribution analysis of two expressions
- **At-least mode** — P(result >= target) with visual probability bar
- **Zero runtime dependencies** — Node 22+ builtins only
- **Dual-use** — CLI via `npx @mcptoolshop/roll` and importable as a library
