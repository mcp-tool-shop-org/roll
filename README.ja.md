<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

## インストール

```bash
npm install @mcptoolshop/roll
```

Node.js 22 以降が必要です。

## CLI の使用方法

### サイコロを振る

```bash
roll 2d6+3
roll d20+5
roll 4d6kh3
roll 1d6!
roll d%
roll 4dF
roll "(2d6+3)*2"
```

### 確率を分析する

```bash
roll 2d6 --analyze          # Full distribution + statistics
roll d20+5 --at-least 15    # P(result >= 15)
```

### 分布を比較する

```bash
roll --compare "4d6dl1" "3d6"
```

統計情報（平均、中央値、最頻値、標準偏差、範囲、エントロピー）を並べて表示し、差分を表示。ヒストグラムも表示します。

### アイテムテーブル

```bash
roll --loot treasure.json
```

JSON 形式：

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

機能：重み付けされた選択、ネストされたテーブル参照、サイコロの個数と値を指定するための数式。

### その他のオプション

```bash
roll 2d6+3 --times 5       # Roll 5 times
roll 2d6+3 --json           # Machine-readable output
roll --help                 # Full usage
roll --version              # Version
```

## サイコロの表記法

| 表記 | 意味 |
|----------|---------|
| `2d6` | 6面サイコロを2個振る |
| `d20` | 20面サイコロを1個振る |
| `4d6kh3` | 6面サイコロを4個振り、最も高い3個を残す |
| `4d6dl1` | 6面サイコロを4個振り、最も低い1個を捨てる |
| `1d6!` | 爆発サイコロ（最大値が出たら再ロールし、加算する） |
| `1d6!>4` | 4以上が出たら爆発 |
| `d%` | パーセントサイコロ（1～100） |
| `4dF` | Fate/Fudge サイコロ（-1、0、+1） |
| `(2d6+3)*2` | グループ化された算術演算 |
| `2d6+1d4+3` | 連鎖した数式 |

## ライブラリ API

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

## 確率エンジン

- 基本的な NdM の場合、多項式畳み込みによる**正確な分布**
- keep/drop メカニズムの場合の**完全な列挙**（4d6 = 1,296 通りの状態）
- 爆発サイコロの場合の**切り捨てられた再帰**（爆発回数は最大10回）
- 正確な計算が 100 万以上の状態を超える場合、**モンテカルロ法**（10万サンプル）を使用

## 依存関係なし

Node.js 22 以降の組み込み機能のみを使用：
- ターミナルカラー表示用の `util.styleText`
- CLI 引数解析用の `util.parseArgs`
- 暗号学的に安全なサイコロの出目生成用の `crypto.randomInt`

## セキュリティと信頼性

`@mcptoolshop/roll` は、サイコロの数式を処理するのみです。ネットワークリクエストは行わず、ファイルへの書き込みも行わず、データも収集しません。ファイルシステムへのアクセスは、`--loot` オプションを使用した場合のみで、これはユーザーが指定した単一の JSON ファイルを読み込みます。

テレメトリー、分析、およびあらゆる種類のトラッキングは一切ありません。秘密、トークン、または認証情報は、いかなる操作にも使用されません。

すべてのサイコロの出目は、Node.js の `crypto` モジュールにある `crypto.randomInt` を使用しており、暗号学的に安全な乱数を生成し、公平な結果を得ることができます。

脆弱性報告ポリシーについては、[SECURITY.md](./SECURITY.md) を参照してください。

## ライセンス

MIT

---

<a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a> が作成しました。
