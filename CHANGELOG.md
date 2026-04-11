# Changelog

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
