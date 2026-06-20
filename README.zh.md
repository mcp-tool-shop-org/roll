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

需要 Node.js >= 22。没有运行时依赖项。

## 骰子表示法

Roll 支持完整的 Roll20/VTT 表示标准，涵盖《龙与地下城》、《黑暗世界》、《阴影运行》、《狂野世界》、《命运》等游戏系统。

| 表示法 | 含义 |
|----------|---------|
| `2d6` | 掷 2 个六面骰子 |
| `d20+5` | 掷 d20，加上修正值 |
| `4d6kh3` | 掷 4d6，保留最高的 3 个 |
| `4d6dl1` | 掷 4d6，舍弃最低的 1 个 |
| `1d6!` | 爆炸骰（在最大值时重新掷骰，并累加） |
| `1d6!>4` | 当结果为 4 或更高时发生爆炸 |
| `1d6!!` | 复合骰（将爆炸骰的结果累加到同一个骰子上） |
| `1d6!p` | 穿透骰（每次爆炸骰减少 1） |
| `2d6r<2` | 重新掷出小于 2 的值（无限次） |
| `2d6ro=1` | 只重新掷一次 1 |
| `2d6min3` | 下限：没有低于 3 的骰子 |
| `2d6max5` | 上限：没有高于 5 的骰子 |
| `8d6cs>=5` | 计算成功次数（骰子结果 >= 5） |
| `8d6cs>=5cf<=1` | 成功次数减去失败次数 |
| `1d20cs>19cf<2` | 关键成功/失败标记 |
| `4d6sa` / `4d6sd` | 按升序/降序排序 |
| `d%` | 百分比（1-100） |
| `4dF` | 命运/Fudge 骰子 |
| `(2d6+3)*2` | 带分组的算术运算 |

## 命令行界面用法

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

### 概率查询

除了 `--at-least` 之外，还有四个标志可以回答设计师真正想知道的问题。每个标志都会打印出一行清晰的结果，并遵循与 `--analyze` 相同的精确/蒙特卡洛标记：

| 标志 | 答案 |
|------|---------|
| `--at-least N` | P(结果 ≥ N) |
| `--at-most N` | P(结果 ≤ N) |
| `--exactly N` | P(结果 = N) |
| `--between L..H` | P(L ≤ 结果 ≤ H)——也接受 `L,H` |
| `--target-for P` | 最大的目标值 T，使得 P(结果 ≥ T) ≥ P（“在 65% 的情况下命中目标，目标 ≤ T”） |

`--compare A B` 现在会在两个属性块之上添加一个 **对比** 结果——P(A 胜出)、P(平局)、P(B 胜出) 以及平均差异 E[A−B]，因此您可以直接解决平衡问题。使用 `--json` 时，它会包含一个 `comparison` 对象（`pAGreater`、`pEqual`、`pBGreater`、`meanMargin`）。

### 确定性掷骰 (`--seed`)

`--seed <int>` 为随机数生成器设置种子，以便一次掷骰（或整个 `--times N` 序列）的结果可以完全重现——这是引擎、桥接和 MCP 已经具备的确定性，现在也适用于命令行界面。种子必须是有限整数；如果种子无效，则会报错并退出，返回代码 1。要传递一个 **负数** 种子，请使用 `=` 形式 (`--seed=-3`)，因为以空格分隔的前缀“-”值对于参数解析器来说是不明确的。`--json` 会回显 `seed`，以便输出记录准确地显示了生成结果的内容。

```bash
roll 4d6kh3 --seed 42             # same result every time
roll 1d20 --seed 7 --times 5      # a fixed, reproducible sequence of 5 rolls
roll 2d6 --seed 99 --json         # output includes "seed": 99
```

### 颜色

默认情况下启用颜色。可以通过以下两种方式禁用它：

- `--no-color`——禁止单次调用的 ANSI 样式
- `NO_COLOR=1`（环境变量）——遵循 [NO_COLOR](https://no-color.org/) 标准

当分析器对大型或复杂的表达式回退到蒙特卡洛方法时，`--analyze` 和 `--at-least` 会将结果标记为估计值（并显示样本数量），而不是将采样数字作为精确值呈现。精确的结果会明确标明。`--json` 输出包含一个 `method` 字段（`"exact"` 或 `"monte-carlo"`，如果进行了采样则带有 `samples`），以便机器可以区分它们。

### 退出代码

Roll 遵循明确的双重代码约定——一种脚本可以依赖的稳定性承诺：

| 代码 | 含义 |
|------|---------|
| `0` | 成功 |
| `1` | 任何错误——无效表达式、验证失败、缺少战利品文件或超出限制 |

错误始终会向标准错误输出打印一行清晰的信息（代码/消息/提示）；命令行界面绝不会泄露堆栈跟踪。

## 游戏表格

V2 引入了一个通用的游戏表格系统，用于处理遭遇、关键打击、战利品、状态效果等。

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

功能：8 种表格类型、加权选择、条件（比较、自然值、标签、上下文）、等级过滤、嵌套表格、表格链、用于数量/掷骰/持续时间的骰子表达式、稀有度分层、具有循环引用检测的验证。

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

**高级 API 是稳定的，并遵循语义化版本控制——破坏性更改仅在主版本号发生变化时才会出现：**

- `roll`、`analyze`
- 战利品 API（`rollLootTable`、`validateLootTables`）和游戏表格 API（`rollGameTable`）
- `BridgeHandler` JSON-RPC 接口

**低级解析器内部是高级的，并且可能会在次要版本中发生变化——仅当您需要自行遍历抽象语法树时才使用它们，如果依赖于它们，请固定一个版本：**

- `tokenize`、`Token`、`TokenType`
- `runPipeline`、`matchesCompare`

`analyze` 还会报告 `.method`（`"exact"` | `"monte-carlo"`）以及，对于采样路径，`.samples`——因此调用者可以以编程方式遵守精确概率约定。

## JSON 桥接（Godot / Unreal / Rust）

Roll 包括一个 JSON-RPC 2.0 桥接，用于通过子进程进行游戏引擎集成：

```bash
# Stdio mode (pipe JSON in, get JSON out)
echo '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"4d6kh3","seed":42}}' | roll-bridge

# HTTP mode
roll-bridge --http --port 3947
curl -X POST http://localhost:3947/rpc -d '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"2d6+3"}}'
```

方法：`roll`、`roll_batch`、`analyze`、`at_least`、`compare`、`table_roll`、`table_load`、`table_list`、`seed`、`ping`、`shutdown`。

## MCP 服务器

Roll 作为 Claude 集成期间游戏设计中的 MCP 服务器提供：

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

- **精确分布**：通过多项式卷积实现基本的 NdM（N 面骰子）计算。
- **完全枚举**：用于处理保留/丢弃机制（4d6 = 1296 种状态）。
- **分析重掷**：重新分配概率质量，使其分布在不匹配的面值上。
- **分析最小值/最大值**：截断分布，并将质量集中在限定值处。
- **分析成功计数**：将面值映射为 +1/0/-1，并进行 N 次卷积。
- **截断递归**：用于爆炸骰子、复合骰子或穿透骰子的计算。
- **蒙特卡洛回退**（10 万次采样）：当精确计算超过 1000 万种状态时使用。

每个修正都有精确的概率分析，而不仅仅是模拟。

## 安全与信任

该程序仅处理骰子表达式，不做其他操作。不进行网络请求，不写入文件（除了读取一个 JSON 文件），没有遥测数据，也没有任何秘密信息。所有骰子的投掷都使用 `crypto.randomInt` 函数来生成密码学级别的随机数。为了防止资源耗尽，在解析时会对表达式进行限制（骰子数量、骰子面数、长度）。此外，从 `--loot` 文件中读取的任何文本都会在显示之前去除终端控制字符，以防止恶意表格将 ANSI 转义序列注入到您的终端中。

有关漏洞报告政策，请参阅 [SECURITY.md](./SECURITY.md)。

## 许可证

MIT

---

由 <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a> 构建。
