# Changelog

## [Unreleased]

### Fixed

- **Roll 3.0 analyzer hardening: AST-wide exact budgets, wide-clamp unit mass, and oracle/differential parity (`crates/roll-core/src/analyze.rs`)** — threads one `ExactBudget` across `try_exact` enforcing cumulative weighted transitions (`MAX_EXACT_STATES = 10_000_000`) and simultaneously live state slots (`MAX_EXACT_LIVE_STATES = 2_000_000`, `SPARSE_STATE_SLOTS = 4`, `SPARSE_TRANSITION_WEIGHT = 10`) checked before every allocation, caps `explosion_chain_sum_pmf` `finished` entries (`MAX_EXPLOSION_FINISHED_STATES = 250_000`), preserves `§5.4` divisor-first divide-by-zero precedence without starving right-hand divisors behind oversized left siblings, bounds per-call Monte Carlo fallback work (`MAX_MC_WORK = 28_000_000`) with honest `MonteCarlo { samples }` provenance, counts clamped faces in integers (with Neumaier compensated summation for post-reroll clamps, queries, stats, and `compare` scans) while normalizing singletons to `1.0` and returning `stats.max`/`stats.min` at `target_for_probability(1.0, ...)`, and adds prefix-tape oracle coverage (`d%`, `>`/`<`, `sa`/`sd`, `1d4max3!`, clamp/`ro`/`r` + pools, `2d2!!kh1cs>=2`, `r` + `dh` + pool), the `5d9!!>2kl2 / -2` `MonteCarlo` regression, and a 23,998-run differential unit test between `evaluate_total_with_source` and `evaluate_with_source`.

### Added

- **Roll 3.0 per-evaluation RNG draw budget (`MAX_TOTAL_DRAWS = 2,100,000`)** — caps raw `u64` RNG draws across all dice groups in one expression evaluation via `BudgetedSource` (`crates/roll-core/src/eval.rs`), checked strictly before each draw and before pushing to any `DieTrace` or `RollRng` log, and aborts over-budget rolls (such as stacked unlimited rerolls `10000d1` + `r=1` × 330) with `RollError::DrawBudgetExceeded { limit }`. Preserves legitimate single-modifier-per-kind worst cases (`10000d6r=1ro=1!` at `2,020,000` draws, `10000d6!>=1` at `1,010,000` draws, `10000d2r=1` at `1,010,000` draws), surfaces `DrawBudgetExceeded` immediately on sample 0 in `monte_carlo_distribution` without retrying across `100,000` trials, and extends `03_rolls_and_receipts.json` and `04_exact_analysis.json` in `fixtures/conformance/v3/` (`MANIFEST.sha256` verified identically on native and `wasm32-wasip1`).
- **Roll 3.0 exact probability analyzer (`crates/roll-core/src/analyze.rs`) and v3 analysis conformance fixtures (`04_exact_analysis.json`)** — implements exact stage-ordered single-die PMFs (`r` with `MAX_REROLLS = 100` residuals and `m == s` uniform cap, `ro`, `min`/`max`, `!`/`!!`/`!p` to `MAX_EXPLOSIONS = 100`, penetrate `(raw - 1).max(1)` on raw-face thresholds, compound into one die, and exploding pools `8d6!cs>=5` / `8d6!pcs>=5`), division-free multinomial order-statistic DP for `keep`/`drop` (`10d20kh3`, `4d6!!kh3`) with inner-transition cost guarding (`MAX_EXACT_STATES = 10_000_000`), `MAX_ANALYZE_DICE = 1_000` budget checks, exact binary algebra including non-constant multiplication (`(1d6)*(1d6)`) and symmetric $O(|A| + |B|)$ two-pointer `compare` fallback (`100d100`), deterministic `ChaCha12Rng` Monte Carlo fallback (`100,000` samples), exact reachability tracking under `f64` underflow with divisor-first divide-by-zero checking, and black-box prefix-tape brute-force oracles over `eval.rs`. Also completes Build 1 grammar/test follow-ups (`4d6kl`, `2D6`, `4d6dh`, expression-position `i64::MIN` literal with bijective `Expr` canonical round-trip) and extends `roll-cli fixtures` with `04_exact_analysis.json` (`MANIFEST.sha256` verified identically on native and `wasm32-wasip1`), while keeping `@mcptoolshop/roll` a pure TypeScript port for zero install friction and synchronous use everywhere.
- **Roll 3.0 reference core (`crates/roll-core`) and conformance fixture generator (`crates/roll-cli`)** — introduces the `no_std` + `alloc`, `#![forbid(unsafe_code)]` Rust 2024 workspace (`MSRV 1.88`) implementing deterministic `ChaCha12Rng` streams keyed via length-prefixed SHA-256 `RollAddress` derivation (`roll.v3.seed_kdf\x00\x01`, `rules_version: "roll.v3"`), 64-bit Lemire unbiased range sampling, RFC 8785 JCS canonical receipts (`schema_version: "roll.receipt.v1"`) with `verify_receipt`, and the v3 modal scannerless dice grammar and checked `i64` evaluator (floor division toward -∞, parse-time `min <= max` and 10,000-dice AST budget, and unambiguous modifier parsing for `1d20cscf`, `4d6khsa`, and `2d6rsa`). `roll-cli fixtures --out fixtures/conformance/v3/` generates the byte-reproducible v3 conformance suite (`MANIFEST.sha256` verified identically on native and `wasm32-wasip1`); the npm package remains a pure TypeScript port for zero install friction and synchronous use everywhere, verified against these fixtures in a follow-up PR.

## 2.1.3

### Fixed

- **Stacked-explosion cost guards across `analyze()`, Monte Carlo, and `roll()`** — `estimateAstAnalyzeRolls` accounts for stacked explosion modifiers (`101^k` per-sample roll amplification across `explode` / `compound` / `penetrate`) and rerolls in the `analyze()` input-dice guard, `monteCarloDistribution` enforces both the static per-sample roll cap and a live RNG-draw budget (`samples × 1,000`), `stageExplode` caps per-group bonus rolls at `MAX_EXPLOSION_ROLLS = 10_000` (throwing `ParseError` when exceeded), and CLI `--times` / MCP `roll_dice` use the explosion-aware roll estimate so crafted expressions like `2d3!<=4!!>=1` or `1d6!>=1!>=1!>=1` fail fast instead of stalling.
- **Subnormal IEEE-754 underflow guard in `reroll_once`** — `singleDieWithReroll` preserves positive subnormal mass when `pMatch * pFace` would flush to `0` (`1d2000r=1ro=1` retains bucket `1` with `stats.min === 1`, and `1d6/(1d2000r=1ro=1-1)` throws `ParseError("Division by zero")` matching `roll()`).
- **Zero-dice `caps` metadata** — `tryExact` short-circuits `count === 0` (`0d6!`, `0d6r=1`) to `{0: 1}` before per-die cap modelling so `caps` is omitted when zero dice are rolled.

### Changed

- Monte Carlo analysis counts draws per sample instead of per draw, and the dice pipeline skips work for groups with no modifiers; seeded results are unchanged.

### Behaviour change

- `roll()` throws `ParseError("Explosion roll limit of 10000 exceeded")` when one dice group's explosions pass `MAX_EXPLOSION_ROLLS = 10,000`. The CLI and the MCP `roll_dice` tool refuse a request, including a single roll, whose estimated dice work times `--times`/`times` exceeds 1,000,000. `analyze()` throws `ParseError("Expression too complex to analyze…")` when the estimated work exceeds its budget. Before 2.1.3 these inputs could take seconds, use gigabytes of memory, or crash the process.

## 2.1.2

### Fixed

- **Exact analysis for combined dice modifiers and engine loop caps** — `tryExact` now composes Stage 1 (roll), Stage 2 (`reroll` / `reroll_once`), and Stage 3 (`min` / `max`) per die before Stage 4 (`explode` / `compound` / `penetrate`), Stage 5 (`keep` / `drop`), or Stage 8 (`sum` / `success_count`), matching `runPipeline` instead of routing to single-family strategies that silently dropped earlier modifiers (`2d6r=1!`, `2d6min2!`, `2d6r=1min3`, `2d4ro=1min2!`, `3d4ro=1kh2`). Unlimited rerolls and explosions model the engine's exact `MAX_REROLLS = 100` and `MAX_EXPLOSIONS = 100` caps (within the 10M-state budget) and surface any exercised cap via `caps` (`{ maxExplosions?: 100, maxRerolls?: 100 }`) on `analyze()`, CLI, bridge, and MCP outputs. Combinations that add variable dice counts before keep/drop or success counting, or exceed the exact state budget, fall back to Monte Carlo (`method: "monte-carlo"`).
- **Division-by-zero parity between `roll()` and `analyze()`** — `divideDistribution`, `divideDistributions`, and `tryExact` throw `ParseError("Division by zero")` whenever an exact divisor is `0` or has positive probability of rolling `0` (e.g. `1d6/0`, `1d6/(1d2-1)`, `1d6/(1d100r<=99-50)`), evaluating the divisor before the dividend so `500d1000/(5d20-5)` throws deterministically instead of escaping via `ExactTooLargeError`. Non-exact divisors (e.g. `1d6/(5d20!kh4-4)`) fall back to Monte Carlo (`method: "monte-carlo"`), never `"exact"`.

## 2.1.1

### Added

- **At-most-for target solver** — CLI `--at-most-for P`, bridge `at_most_for`, and MCP `analyze_dice` `at_most_for`. Returns the smallest T with P(result ≤ T) ≥ p. `--target-for` is unchanged.

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
