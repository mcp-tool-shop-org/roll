# Changelog

## [Unreleased]

Stage A hardening — input caps, probability correctness, boundary security, and CLI robustness.

### Security

- **ANSI/terminal-control injection blocked** — externally-sourced strings (loot item names, table names, dice/validation echoes from `--loot` files) are now sanitized of C0 control characters, including raw `ESC` bytes, before display. A malicious loot JSON can no longer hijack the terminal of anyone who runs `roll --loot evil.json`.
- **Input caps (DoS prevention)** — crafted expressions can no longer force unbounded work; dice count, die sides, and expression length are capped at parse time and rejected with a clean error.

### Fixed

- **CLI error handling** — unknown flags, bad option values, and invalid expressions now print a single clean `Error: …` line plus a `--help` hint instead of dumping a raw Node stack trace with internal frames.
- **`--times` validation** — `--times abc`, `--times 0`, and `--times=-5` now exit `1` with a clear message instead of silently becoming `1` or a no-op; values are capped at 10,000 so the terminal can't be flooded.
- **Mode flag without expression** — `--at-least`, `--analyze`, or `--json` with no dice expression now errors with an example instead of silently printing help and exiting `0`.
- **Histogram crash on degenerate input** — `--analyze` no longer throws on an all-zero-probability distribution (NaN bar-length guard in the histogram and sparkline renderers).
- **Probability correctness** — multiple analytical-distribution fixes so exact analysis matches the engine across V2 modifiers.

### Changed

- **`--help` documents the full V2 notation** — success/failure counting (`cs>=N`/`cf<=N`), compounding (`!!`), penetrating (`!p`), reroll (`r`/`ro`), `min`/`max` clamping, and sorting (`sa`/`sd`), mirroring the README notation table.
- **`SECURITY.md`** now lists the 2.0.x line as supported (latest-major policy).
- **CLI is now testable in-process** via an exported `run(argv, io)` that returns an exit code, enabling end-to-end CLI tests without spawning child processes.

### Tests

- New `tests/cli.test.ts` and `tests/display.test.ts` cover the previously-untested CLI and terminal display layer (help/version, exit codes, `--times` validation, mode-flag-without-expression, `--loot` ENOENT, sanitization end-to-end, histogram NaN guard, JSON shape, colorless output).
- `vitest.config.ts` now emits coverage reports (v8, text + html) over `src/`.

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
