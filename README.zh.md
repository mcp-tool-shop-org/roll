<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.md">English</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

## 安装

```bash
npm install @mcptoolshop/roll
```

需要 Node.js >= 22。没有运行时依赖。

## 骰子表示法

Roll 支持完整的 Roll20/VTT 表示法标准，涵盖 D&D、World of Darkness、Shadowrun、Savage Worlds、Fate 等。

| 表示法 | 含义 |
|----------|---------|
| `2d6` | 掷 2 个六面骰 |
| `d20+5` | 掷 d20，加上修正值 |
| `4d6kh3` | 掷 4d6，保留最高的 3 个 |
| `4d6dl1` | 掷 4d6，舍弃最低的 1 个 |
| `1d6!` | 爆炸（在最大值时重新掷骰，并累加） |
| `1d6!>4` | 在 4 或更高的值时爆炸 |
| `1d6!!` | 复合（将爆炸结果累加到同一个骰子上） |
| `1d6!p` | 穿透（爆炸结果减去 1） |
| `2d6r<2` | 重新掷骰，直到结果大于或等于 2（无限次） |
| `2d6ro=1` | 重新掷骰 1，一次 |
| `2d6min3` | 下限：没有骰子结果低于 3 |
| `2d6max5` | 上限：没有骰子结果高于 5 |
| `8d6cs>=5` | 计算成功次数（骰子结果 >= 5） |
| `8d6cs>=5cf<=1` | 成功次数减去失败次数 |
| `1d20cs>19cf<2` | 关键成功/失败标记 |
| `4d6sa` / `4d6sd` | 升序/降序排序 |
| `d%` | 百分比（1-100） |
| `4dF` | 命运/Fudge 骰 |
| `(2d6+3)*2` | 带分组的算术运算 |

## 命令行用法

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
roll 1d20+5 --at-most-for 0.65    # Smallest target T with P(result <= T) >= 0.65
roll --compare "4d6dl1" "3d6"     # Side-by-side + P(A>B) verdict
roll --loot treasure.json         # Loot table
roll 2d6+3 --times 5              # Multiple rolls
roll 4d6kh3 --seed 42             # Deterministic, reproducible rolls
roll 2d6+3 --json                 # Machine-readable output
roll 2d6 --analyze --no-color     # Disable ANSI color for this run
```

### 概率查询

除了 `--at-least` 之外，这些标志回答了设计师真正会问的问题。每个标志都会打印一行清晰的输出，并遵循与 `--analyze` 相同的精确/蒙特卡洛标记：

| 标志 | 答案 |
|------|---------|
| `--at-least N` | P(结果 ≥ N) |
| `--at-most N` | P(结果 ≤ N) |
| `--exactly N` | P(结果 = N) |
| `--between L..H` | P(L ≤ 结果 ≤ H)——也接受 `L,H` |
| `--target-for P` | 最大的目标值 T，使得 P(结果 ≥ T) ≥ P（“以 65% 的概率命中，目标 ≤ T”） |
| `--at-most-for P` | 最小的 T，使得 P(结果 ≤ T) ≥ P（“65% 的结果落在 T 或以下”） |

`--compare A B` 现在在两个状态块之上添加了一个“对抗”结果——P(A 胜出)、P(平局)、P(B 胜出)以及平均差异 E[A−B]，因此您可以直接确定平衡问题。使用 `--json`，它会携带一个 `comparison` 对象（`pAGreater`、`pEqual`、`pBGreater`、`meanMargin`）。

### 确定性掷骰（`--seed`）

`--seed <int>` 会对随机数生成器进行初始化，因此一次掷骰（或整个 `--times N` 序列）都是可以完全重现的——这是引擎、桥接器和 MCP 已经具备的确定性，现在也适用于命令行。种子必须是有限的整数；如果种子无效，则会报错并退出，返回代码 1。要传递一个**负数**种子，请使用 `=` 形式（`--seed=-3`），因为以空格分隔的前缀负号值对于参数解析器来说是模棱两可的。`--json` 会回显 `seed`，以便输出记录准确地显示了生成它的内容。

```bash
roll 4d6kh3 --seed 42             # same result every time
roll 1d20 --seed 7 --times 5      # a fixed, reproducible sequence of 5 rolls
roll 2d6 --seed 99 --json         # output includes "seed": 99
```

### 颜色

默认情况下启用颜色。可以通过以下两种方式禁用它：

- `--no-color`——禁用单个调用的 ANSI 样式
- `NO_COLOR=1`（环境变量）——按照 [NO_COLOR](https://no-color.org/) 标准执行

当分析器对大型或复杂的表达式回退到蒙特卡洛方法时，`--analyze` 和 `--at-least` 会将结果标记为估计值（并显示样本数量），而不是将采样数字作为精确值呈现。精确的结果会明确标记为精确值——并且，每当精确的分布依赖于引擎的有限循环限制（`MAX_EXPLOSIONS = 100`、`MAX_REROLLS = 100`）时，注释中会说明所建模的限制（`exact probabilities (engine caps: ...)`）。`--json` 输出会携带 `method`（`"exact"` 或 `"monte-carlo"`）、`samples`（当进行采样时），以及 `caps`（`{ maxExplosions?: 100, maxRerolls?: 100 }`）（当应用引擎限制时）。

### 退出代码

Roll 遵循一种明确的双代码约定——这是一种稳定性承诺，脚本可以依赖它：

| 代码 | 含义 |
|------|---------|
| `0` | 成功 |
| `1` | 任何错误——无效的表达式、验证失败、缺少 loot 文件或超出限制 |

错误始终会向 stderr 打印一行清晰的输出（代码/消息/提示）；命令行绝不会泄漏堆栈跟踪。

## 游戏表格

V2 引入了一个通用的游戏表格系统，用于处理遭遇、关键事件、战利品、状态效果等。

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

特性：8 种表格类型、加权选择、条件（比较、自然值、标签、上下文）、等级过滤、嵌套表格、表格链、用于数量/掷骰/持续时间的骰子表达式、稀有度等级、具有循环引用检测的验证。

## 库 API

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

### 稳定性

**高级 API 是稳定的，并遵循语义版本控制——只有在主要版本更新时才会进行破坏性更改：**

- `roll`、`analyze`
- loot API（`rollLootTable`、`validateLootTables`）和游戏表格 API（`rollGameTable`）
- `BridgeHandler` JSON-RPC 表面

**低级解析器内部是高级的，并且可能会在次要版本中发生变化——只有在您需要自行遍历 AST 时才使用它们，并且如果依赖它们，请固定版本：**

- `tokenize`, `Token`, `TokenType`
- `runPipeline`, `matchesCompare`

`analyze` 还会报告 `.method`（`"exact"` | `"monte-carlo"`）、`.samples`（用于采样路径），以及 `.caps`（`{ maxExplosions?: number; maxRerolls?: number }`）（在精确路径上），每当对引擎循环限制进行建模时，调用者都可以以编程方式遵守精确概率约定。

### 精确性、引擎限制和除以零

- **大写形式的 `"exact"` 的含义：** 在纯粹的数学中，爆炸骰子（`!`、`!!`、`!p`）和无限次重掷（`r`）都没有有限的支持。在 Roll 中，`method: "exact"` 表示对于构建的引擎（`runPipeline`）而言，结果必须完全准确，包括其循环限制（每个初始骰子有 `MAX_EXPLOSIONS = 100` 次额外掷骰；每个无限 `r` 修改器有 `MAX_REROLLS = 100` 次重掷，之后第 100 次掷骰结果生效）。每当使用任何一个限制时，`analyze()` 都会将其显示在 `.caps`（`{ maxExplosions: 100 }`、`{ maxRerolls: 100 }`）中，并且 CLI 会打印 `exact probabilities (engine caps: ...)`。如果受限制的支持或卷积运算超过 `10,000,000` 个状态，或者如果每个面都与无限次重掷（`1d6r>=1`）匹配，则分析会退回到 `method: "monte-carlo"`。
- **除以零（`/`）：** `roll()` 只要计算出的除数是 `0`，就会抛出 `ParseError("Division by zero")`。`analyze()` 会拒绝任何精确的除数，其 $P(\text{divisor} = 0) > 0$，并使用相同的 `ParseError("Division by zero")` 进行评估和检查，在被除数之前评估和检查除数，这样即使被除数很大（`500d1000/(5d20-5)`），也不能通过 `ExactTooLargeError` 跳过检查。当除数*本身*无法精确计算时（例如 `1d6/(5d20!kh4-4)`，其中 `5d20!kh4` 结合了爆炸和保留/丢弃），`analyze()` 会退回到蒙特卡罗方法（通过 `evaluate()` 进行 `100,000` 次试验）：如果任何抽取的试验结果为 `0`，则抛出 `ParseError("Division by zero")`；如果抽样过程中遗漏了罕见的零结果，则返回结果为 `method: "monte-carlo"`（`samples: 100_000`）——绝不会是 `"exact"`。

## JSON 桥接（Godot / Unreal / Rust）

Roll 包含一个 JSON-RPC 2.0 桥接，用于通过子进程进行游戏引擎集成：

```bash
# Stdio mode (pipe JSON in, get JSON out)
echo '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"4d6kh3","seed":42}}' | roll-bridge

# HTTP mode
roll-bridge --http --port 3947
curl -X POST http://localhost:3947/rpc -d '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"2d6+3"}}'
```

方法：`roll`、`roll_batch`、`analyze`、`at_least`、`compare`、`table_roll`、`table_load`、`table_list`、`seed`、`ping`、`shutdown`。

## MCP 服务器

Roll 以 MCP 服务器的形式提供，用于在游戏设计期间进行 Claude 集成：

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

5 个工具：`roll_dice`、`analyze_dice`、`compare_dice`、`roll_table`、`query_table`。

## 概率引擎

- 通过多项式卷积实现基本的 NdM 的**精确分布**
- 对于保留/丢弃机制，进行**完全枚举**（4d6 = 1,296 个状态）
- **分析重掷**——在不匹配的面之间进行封闭形式的质量重新分配，再加上 `MAX_REROLLS = 100` 限制的残差
- **分析最小值/最大值**——截断分布并在限制处堆积质量
- **分析成功计数**——将面映射到 +1/0/-1，卷积 N 次
- 对于爆炸/复合/穿透骰子，进行**精确的引擎-限制扩展**，最多可达 `MAX_EXPLOSIONS = 100`
- 当精确计算超过 10M 个状态，或者将可变数量的爆炸与保留/丢弃或成功计数结合时，使用**蒙特卡罗回退**（100k 个样本）。

每个修改器都具有精确的概率分析——而不仅仅是模拟。

## 安全与信任

处理骰子表达式，仅此而已。没有网络请求，没有文件写入（除了 `--loot` 读取一个 JSON 文件），没有遥测数据，没有秘密。所有骰子掷骰都使用 `crypto.randomInt` 进行密码学随机数生成。为了防止资源耗尽，骰子表达式在解析时会受到限制（骰子数量、骰子面数、长度），并且从 `--loot` 文件中读取的任何文本在显示之前都会删除终端控制字符，这样恶意表格就无法将 ANSI 转义序列注入到您的终端中。

有关漏洞报告策略，请参阅 [SECURITY.md](./SECURITY.md)。

## 许可证

MIT

---

由 <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a> 构建
