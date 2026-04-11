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

<p align="center">RPG dice engine with probability analysis, loot tables, and beautiful terminal output.</p>

```
npx @mcptoolshop/roll 4d6dl1 --analyze
```

```
  Distribution

   3    0.08%
   4 █   0.31%
   5 ███   0.77%
   6 ███████   1.62%
   7 █████████████   2.93%
   8 ██████████████████████   4.78%
   9 ████████████████████████████████   7.02%
  10 ███████████████████████████████████████████   9.41%
  11 ████████████████████████████████████████████████████  11.42%
  12 ██████████████████████████████████████████████████████████  12.89%
  13 ████████████████████████████████████████████████████████████  13.27%
  14 ████████████████████████████████████████████████████████  12.35%
  15 ██████████████████████████████████████████████  10.11%
  16 █████████████████████████████████   7.25%
  17 ███████████████████   4.17%
  18 ███████   1.62%

┌─ Statistics ─────────────────────────────────┐
│ Mean:    12.24                                │
│ Median:  12                                   │
│ Mode:    13                                   │
│ Std Dev: 2.85                                 │
│ Range:   3–18                                 │
│ Entropy: 3.53 bits                            │
│                                               │
│ Percentiles:                                  │
│   p10:8  p25:10  p50:12  p75:14  p90:16  p95:17│
└───────────────────────────────────────────────┘
```

## 安装

```bash
npm install @mcptoolshop/roll
```

需要 Node.js >= 22。

## 命令行用法

### 投骰子

```bash
roll 2d6+3
roll d20+5
roll 4d6kh3
roll 1d6!
roll d%
roll 4dF
roll "(2d6+3)*2"
```

### 分析概率

```bash
roll 2d6 --analyze          # Full distribution + statistics
roll d20+5 --at-least 15    # P(result >= 15)
```

### 比较分布

```bash
roll --compare "4d6dl1" "3d6"
```

并排显示统计数据（均值、中位数、众数、标准差、范围、熵），包含差异列，以及直方图。

### 掉落表

```bash
roll --loot treasure.json
```

JSON 格式：

```json
{
  "tables": [
    {
      "table": "Treasure",
      "items": [
        { "name": "Gold", "weight": 40, "roll": "2d6*10" },
        { "name": "Potion of Healing", "weight": 30 },
        { "name": "Scroll", "weight": 15, "quantity": "1d3" },
        { "name": "Rare Item", "weight": 5, "table": "Rare Weapons" }
      ]
    },
    {
      "table": "Rare Weapons",
      "items": [
        { "name": "Vorpal Blade", "weight": 5 },
        { "name": "Frost Brand", "weight": 25 }
      ]
    }
  ]
}
```

特性：加权选择、嵌套表引用、用于数量和值的骰子表达式。

### 其他选项

```bash
roll 2d6+3 --times 5       # Roll 5 times
roll 2d6+3 --json           # Machine-readable output
roll --help                 # Full usage
roll --version              # Version
```

## 骰子表示法

| 表示法 | 含义 |
|----------|---------|
| `2d6` | 投掷 2 个六面骰子 |
| `d20` | 投掷 1 个二十面骰子 |
| `4d6kh3` | 投掷 4d6，保留最高的 3 个 |
| `4d6dl1` | 投掷 4d6，舍弃最低的 1 个 |
| `1d6!` | 爆炸骰子（最大值时重新投掷，并加总） |
| `1d6!>4` | 当结果为 4 或更高时爆炸 |
| `d%` | 百分位骰子（1-100） |
| `4dF` | 命运/模糊骰子（-1、0、+1 各一个） |
| `(2d6+3)*2` | 带有分组的算术运算 |
| `2d6+1d4+3` | 链式表达式 |

## 库 API

```typescript
import { roll, analyze, parse, evaluate, computeDistribution } from '@mcptoolshop/roll';

// Quick roll
const result = roll('4d6kh3');
console.log(result.total);        // 14
console.log(result.groups[0].dice); // per-die breakdown

// Full analysis
const analysis = analyze('2d6+3');
console.log(analysis.stats.mean);                  // 10
console.log(analysis.stats.percentiles[95]);        // 14
console.log(analysis.probabilityAtLeast(12));       // 0.2778

// Low-level: parse → AST → evaluate
import { seededRng } from '@mcptoolshop/roll';
const ast = parse('4d6dl1');
const r = evaluate(ast, seededRng(42));  // deterministic

// Loot tables
import { rollLootTable } from '@mcptoolshop/roll';
const tables = [{ table: "Loot", items: [{ name: "Gold", weight: 50, roll: "2d6*10" }] }];
const drops = rollLootTable(tables);
```

## 概率引擎

- **精确分布**：通过多项式卷积计算基本 NdM 概率。
- **完整枚举**：用于保留/舍弃机制（4d6 = 1296 种状态）。
- **截断递归**：用于爆炸骰子（最多 10 次爆炸）。
- **蒙特卡洛方法**（10 万个样本）：当精确计算超过 1000 万种状态时使用。

## 无外部依赖

完全基于 Node.js 22+ 的内置模块：
- `util.styleText` 用于终端颜色。
- `util.parseArgs` 用于命令行参数解析。
- `crypto.randomInt` 用于密码学安全的骰子投掷。

## 安全与信任

`@mcptoolshop/roll` 只处理骰子表达式，不做其他任何操作。它不进行任何网络请求，不写入任何文件，也不收集任何数据。唯一的系统文件访问是 `--loot` 选项，它读取单个用户指定的 JSON 文件。

没有遥测数据，没有分析，也没有任何形式的跟踪。没有涉及任何秘密、令牌或凭据。

所有骰子投掷都使用 Node.js `crypto` 模块中的 `crypto.randomInt`，提供密码学安全的随机数，适用于公平的结果。

请参阅 [SECURITY.md](./SECURITY.md) 以获取漏洞报告政策。

## 许可证

MIT

---

由 <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a> 构建。
