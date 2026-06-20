<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center"><img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/roll/readme.png" width="400" alt="Roll"></p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/roll/actions"><img src="https://github.com/mcp-tool-shop-org/roll/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://mcp-tool-shop-org.github.io/roll/"><img src="https://img.shields.io/badge/Landing_Page-online-brightgreen" alt="Landing Page"></a>
  <a href="https://www.npmjs.com/package/@mcptoolshop/roll"><img src="https://img.shields.io/npm/v/@mcptoolshop/roll" alt="npm version"></a>
</p>

<p align="center">Universal RPG dice engine — full notation, probability analysis, game tables, and engine integration.</p>

```
npx @mcptoolshop/roll 8d6cs>=5 --analyze
```

## Install

```bash
npm install @mcptoolshop/roll
```

Requires Node.js >= 22. Zero runtime dependencies.

## Dice Notation

Roll supports the full Roll20/VTT notation standard covering D&D, World of Darkness, Shadowrun, Savage Worlds, Fate, and more.

| Notation | Meaning |
|----------|---------|
| `2d6` | Roll 2 six-sided dice |
| `d20+5` | Roll d20, add modifier |
| `4d6kh3` | Roll 4d6, keep highest 3 |
| `4d6dl1` | Roll 4d6, drop lowest 1 |
| `1d6!` | Exploding (reroll on max, add) |
| `1d6!>4` | Explode on 4 or higher |
| `1d6!!` | Compounding (sum explosions into same die) |
| `1d6!p` | Penetrating (explosions subtract 1) |
| `2d6r<2` | Reroll values less than 2 (unlimited) |
| `2d6ro=1` | Reroll 1s once |
| `2d6min3` | Floor: no die below 3 |
| `2d6max5` | Ceiling: no die above 5 |
| `8d6cs>=5` | Count successes (dice >= 5) |
| `8d6cs>=5cf<=1` | Successes minus failures |
| `1d20cs>19cf<2` | Critical success/failure marking |
| `4d6sa` / `4d6sd` | Sort ascending / descending |
| `d%` | Percentile (1-100) |
| `4dF` | Fate/Fudge dice |
| `(2d6+3)*2` | Arithmetic with grouping |

## CLI Usage

```bash
roll 2d6+3                        # Basic roll
roll 8d6cs>=5                     # WoD-style dice pool
roll 4d6r<2min2kh3                # Complex modifier chain
roll 2d6 --analyze                # Full distribution + statistics
roll d20+5 --at-least 15          # P(result >= 15)
roll 2d6 --at-most 7              # P(result <= 7)
roll 2d6 --exactly 7              # P(result == 7)
roll 2d6 --between 6..8           # P(6 <= result <= 8)
roll 1d20+5 --target-for 0.65     # Largest target T with P(result >= T) >= 0.65
roll --compare "4d6dl1" "3d6"     # Side-by-side + P(A>B) verdict
roll --loot treasure.json         # Loot table
roll 2d6+3 --times 5              # Multiple rolls
roll 4d6kh3 --seed 42             # Deterministic, reproducible rolls
roll 2d6+3 --json                 # Machine-readable output
roll 2d6 --analyze --no-color     # Disable ANSI color for this run
```

### Probability queries

Beyond `--at-least`, four flags answer the questions a designer actually asks. Each prints one clean line and honors the same exact/Monte-Carlo labeling as `--analyze`:

| Flag | Answers |
|------|---------|
| `--at-least N` | P(result ≥ N) |
| `--at-most N` | P(result ≤ N) |
| `--exactly N` | P(result = N) |
| `--between L..H` | P(L ≤ result ≤ H) — also accepts `L,H` |
| `--target-for P` | The largest target T such that P(result ≥ T) ≥ P ("to hit 65% of the time, target ≤ T") |

`--compare A B` now adds a **Versus** verdict on top of the two stat blocks — P(A wins), P(tie), P(B wins), and the mean margin E[A−B] — so you can settle the balance question directly. With `--json` it carries a `comparison` object (`pAGreater`, `pEqual`, `pBGreater`, `meanMargin`).

### Deterministic rolls (`--seed`)

`--seed <int>` seeds the RNG so a roll (or a whole `--times N` sequence) is byte-for-byte reproducible — the determinism the engine, bridge, and MCP already had, now on the CLI. The seed must be a finite integer; a bad seed errors and exits 1. To pass a **negative** seed, use the `=` form (`--seed=-3`), since a space-separated leading-dash value is ambiguous to the argument parser. `--json` echoes the `seed` so the output records exactly what produced it.

```bash
roll 4d6kh3 --seed 42             # same result every time
roll 1d20 --seed 7 --times 5      # a fixed, reproducible sequence of 5 rolls
roll 2d6 --seed 99 --json         # output includes "seed": 99
```

### Color

Color is on by default. Disable it two ways:

- `--no-color` — suppresses ANSI styling for a single invocation
- `NO_COLOR=1` (environment variable) — honored per the [NO_COLOR](https://no-color.org/) standard

When the analyzer falls back to Monte Carlo for a large or complex expression, `--analyze` and `--at-least` label the result as estimated (with the sample count) instead of presenting sampled numbers as exact. Exact results are noted as such. The `--json` output carries a `method` field (`"exact"` or `"monte-carlo"`, with `samples` when sampled) so machine consumers can tell them apart too.

### Exit codes

Roll follows a deliberate two-code contract — a stability promise scripts can rely on:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Any error — bad expression, validation failure, missing loot file, or a cap exceeded |

Errors always print a single clean line (code/message/hint) to stderr; the CLI never leaks a stack trace.

## Game Tables

V2 introduces a universal game table system for encounters, criticals, loot, status effects, and more.

```typescript
import { rollGameTable } from '@mcptoolshop/roll';
import type { GameTableCollection } from '@mcptoolshop/roll';

const collection: GameTableCollection = {
  version: "2.0",
  tables: [{
    table: "critical_hits",
    kind: "critical",
    entries: [
      { name: "Devastating Blow", weight: 1, roll: "2d6", conditions: [{ type: "nat", operator: "=", value: 20 }] },
      { name: "Solid Hit", weight: 3, conditions: [{ type: "compare", operator: ">=", value: 15 }] },
      { name: "Glancing Blow", weight: 5 },
    ],
  }],
};

const results = rollGameTable(collection, "critical_hits", { triggerNat: 20, triggerRoll: 25 });
```

Features: 8 table kinds, weighted selection, conditions (compare, nat, tag, context), level filtering, nested tables, table chaining, dice expressions for quantity/roll/duration, rarity tiers, validation with circular reference detection.

## Library API

```typescript
import { roll, analyze } from '@mcptoolshop/roll';

// Roll with any V2 notation
const result = roll('8d6cs>=5');
console.log(result.total);                    // 3 (successes)
console.log(result.groups[0].resultMode);     // "success_count"
console.log(result.groups[0].dice);           // per-die breakdown with .critical markers

// Probability analysis — exact, not Monte Carlo
const analysis = analyze('8d6cs>=5');
console.log(analysis.stats.mean);             // 2.67
console.log(analysis.probabilityAtLeast(4));  // P(4+ successes)

// Seeded deterministic rolls
import { seededRng, parse, evaluate } from '@mcptoolshop/roll';
const ast = parse('4d6kh3');
const r = evaluate(ast, seededRng(42));       // reproducible
```

### Stability

The **high-level API is stable** and follows semver — breaking changes only on a major bump:

- `roll`, `analyze`
- the loot APIs (`rollLootTable`, `validateLootTables`) and game-table APIs (`rollGameTable`)
- the `BridgeHandler` JSON-RPC surface

**Low-level parser internals are advanced and may change in minor versions** — use them only if you need to walk the AST yourself, and pin a version if you depend on them:

- `tokenize`, `Token`, `TokenType`
- `runPipeline`, `matchesCompare`

`analyze` also reports `.method` (`"exact"` | `"monte-carlo"`) and, for the sampled path, `.samples` — so callers can honor the exact-probabilities contract programmatically.

## JSON Bridge (Godot / Unreal / Rust)

Roll includes a JSON-RPC 2.0 bridge for game engine integration via child process:

```bash
# Stdio mode (pipe JSON in, get JSON out)
echo '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"4d6kh3","seed":42}}' | roll-bridge

# HTTP mode
roll-bridge --http --port 3947
curl -X POST http://localhost:3947/rpc -d '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"2d6+3"}}'
```

Methods: `roll`, `roll_batch`, `analyze`, `at_least`, `compare`, `table_roll`, `table_load`, `table_list`, `seed`, `ping`, `shutdown`.

## MCP Server

Roll ships as an MCP server for Claude integration during game design:

```json
{
  "mcpServers": {
    "roll": {
      "command": "node",
      "args": ["node_modules/@mcptoolshop/roll/dist/mcp/server.js"]
    }
  }
}
```

5 tools: `roll_dice`, `analyze_dice`, `compare_dice`, `roll_table`, `query_table`.

## Probability Engine

- **Exact distributions** via polynomial convolution for basic NdM
- **Full enumeration** for keep/drop mechanics (4d6 = 1,296 states)
- **Analytical reroll** — redistributes probability mass over non-matching faces
- **Analytical min/max** — truncates distribution and piles mass at clamp
- **Analytical success counting** — maps faces to +1/0/-1, convolves N times
- **Truncated recursion** for exploding/compounding/penetrating dice
- **Monte Carlo fallback** (100k samples) when exact computation exceeds 10M states

Every modifier has exact probability analysis — not just simulation.

## Security & Trust

Processes dice expressions and nothing else. No network requests, no file writes (except `--loot` reads one JSON), no telemetry, no secrets. All dice rolls use `crypto.randomInt` for cryptographic randomness. Expressions are capped at parse time (dice count, die sides, length) to prevent resource exhaustion, and any text read from a `--loot` file is stripped of terminal control characters before display so a hostile table can't inject ANSI escape sequences into your terminal.

See [SECURITY.md](./SECURITY.md) for the vulnerability reporting policy.

## License

MIT

---

Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
