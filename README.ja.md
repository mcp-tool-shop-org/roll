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

<p align="center">Universal RPG dice engine — full notation, probability analysis, game tables, and engine integration.</p>

```
npx @mcptoolshop/roll 8d6cs>=5 --analyze
```

## インストール

```bash
npm install @mcptoolshop/roll
```

Node.js >= 22 が必要です。実行時の依存関係はありません。

## ダイス表記

ロールは、D&D、ワールド・オブ・ダークネス、シャドウラン、サベージ・ワールド、フェイトなど、完全なRoll20/VTT表記標準をサポートします。

| 表記 | 意味 |
|----------|---------|
| `2d6` | 6面ダイスを2つ振る |
| `d20+5` | d20を振り、修正値を加える |
| `4d6kh3` | 4d6を振り、最も高い3つを保持する |
| `4d6dl1` | 4d6を振り、最も低い1つを除外する |
| `1d6!` | 爆発（最大値で再ロールし、加算） |
| `1d6!>4` | 4以上で爆発 |
| `1d6!!` | 複合（爆発の値を同じダイスに集約） |
| `1d6!p` | 貫通（爆発の値から1を減算） |
| `2d6r<2` | 2未満の値を再ロールする（無制限） |
| `2d6ro=1` | 1を1回だけ再ロールする |
| `2d6min3` | 下限：3未満のダイスはなし |
| `2d6max5` | 上限：5を超えるダイスはなし |
| `8d6cs>=5` | 成功数を数える（ダイスが5以上） |
| `8d6cs>=5cf<=1` | 成功数から失敗数を引く |
| `1d20cs>19cf<2` | クリティカル成功/失敗のマーク |
| `4d6sa` / `4d6sd` | 昇順/降順でソート |
| `d%` | パーセンタイル（1〜100） |
| `4dF` | フェイト/ファッジダイス |
| `(2d6+3)*2` | グループ化による算術演算 |

## CLIの使用方法

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

### 確率クエリ

`--at-least`を超えて、これらのフラグは、デザイナーが実際に尋ねる質問に答えます。それぞれが1つのクリーンな行を出力し、`--analyze`と同じ正確/モンテカルロのラベル付けを行います。

| フラグ | 回答 |
|------|---------|
| `--at-least N` | P（結果≥N） |
| `--at-most N` | P（結果≤N） |
| `--exactly N` | P（結果=N） |
| `--between L..H` | P（L≤結果≤H）—`L,H`も受け入れます |
| `--target-for P` | P（結果≥T）≥P（「65％の確率で命中させるために、目標≤T」）となる最大の目標値T |
| `--at-most-for P` | P（結果≤T）≥P（「結果の65％がT以下になる」）となる最小のT |

`--compare A B`は、2つのステータスブロックに加えて、**対戦**の結果（Aの勝利確率、引き分け確率、Bの勝利確率、および平均差E[A−B]）を追加するため、バランスの問題を直接解決できます。`--json`を使用すると、`comparison`オブジェクト（`pAGreater`、`pEqual`、`pBGreater`、`meanMargin`）を持ちます。

### 決定論的なロール（`--seed`）

`--seed <int>`はRNGにシードを設定するため、ロール（または一連の`--times N`）はバイト単位で再現可能になります。エンジン、ブリッジ、MCPがすでに持っていた決定論を、CLIでも実現します。シードは有限の整数である必要があります。不正なシードはエラーとなり、1で終了します。**負の**シードを渡すには、`=`形式（`--seed=-3`）を使用してください。これは、スペースで区切られた先頭のハイフン値が引数パーサーにとって曖昧であるためです。`--json`は`seed`を出力するため、出力は正確に何が生成されたかを記録します。

```bash
roll 4d6kh3 --seed 42             # same result every time
roll 1d20 --seed 7 --times 5      # a fixed, reproducible sequence of 5 rolls
roll 2d6 --seed 99 --json         # output includes "seed": 99
```

### 色

デフォルトでは色が有効になっています。次の2つの方法で無効にできます。

- `--no-color` — 1回の呼び出しでANSIスタイルを抑制します
- `NO_COLOR=1`（環境変数）—[NO_COLOR](https://no-color.org/)標準に従って有効になります

アナライザーが、大規模または複雑な式に対してモンテカルロにフォールバックした場合、`--analyze`と`--at-least`は、サンプリングされた数値を正確なものとして提示する代わりに、結果を推定値（サンプル数付き）としてラベル付けします。正確な結果は、そのように注記されます。また、正確な分布がエンジンの有限ループ制限（`MAX_EXPLOSIONS = 100`、`MAX_REROLLS = 100`）に依存する場合、注記にはモデル化された制限（`exact probabilities (engine caps: ...)`）が記載されます。`--json`出力には、`method`（`"exact"`または`"monte-carlo"`）、`samples`（サンプリングされた場合）、および`caps`（`{ maxExplosions?: 100, maxRerolls?: 100 }`）（エンジン制限が適用される場合）が含まれます。

### 終了コード

ロールは、意図的に2つのコードの契約に従います。これは、スクリプトが依存できる安定性の約束です。

| コード | 意味 |
|------|---------|
| `0` | 成功 |
| `1` | エラー（不正な式、検証の失敗、欠落した戦利品ファイル、または制限を超える） |

エラーは常に、1つのクリーンな行（コード/メッセージ/ヒント）をstderrに出力します。CLIはスタックトレースを漏洩させません。

## ゲームテーブル

V2は、遭遇、クリティカル、戦利品、ステータス効果など、汎用的なゲームテーブルシステムを導入します。

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

機能：8種類のテーブル、重み付けされた選択、条件（比較、自然、タグ、コンテキスト）、レベルフィルタリング、ネストされたテーブル、テーブルの連鎖、量/ロール/期間のダイス式、レアリティ階層、循環参照検出による検証。

## ライブラリAPI

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

### 安定性

**高レベルAPIは安定しており、セマンティックバージョニングに従います。**破壊的な変更は、メジャーバージョンが上がる場合にのみ行われます。

- `roll`、`analyze`
- 戦利品API（`rollLootTable`、`validateLootTables`）およびゲームテーブルAPI（`rollGameTable`）
- `BridgeHandler` JSON-RPCサーフェス

**低レベルのパーサー内部は高度であり、マイナーバージョンで変更される可能性があります。**ASTを自分で操作する必要がある場合にのみ使用し、依存する場合はバージョンを固定してください。

- `tokenize`, `Token`, `TokenType`
- `runPipeline`, `matchesCompare`

`analyze`は、エンジンループ制限がモデル化されるたびに、サンプリングされたパスに対して`.method`（`"exact"` | `"monte-carlo"`）、`.samples`、および正確なパスに対して`.caps`（`{ maxExplosions?: number; maxRerolls?: number }`）を報告するため、呼び出し元は正確な確率の契約をプログラムで尊重できます。

### 正確性、エンジン制限、およびゼロによる除算

- **大文字で表現した場合の`"exact"`の意味:** 純粋な数学では、爆発するサイコロ（`!`、`!!`、`!p`）と無制限のリロール（`r`）は、有限のサポートを持ちません。Rollでは、`method: "exact"`は、構築されたエンジン（`runPipeline`）に対して正確であることを意味し、そのループ制限（初期のサイコロあたり`MAX_EXPLOSIONS = 100`回のボーナスロール、無制限の`r`モディファイアあたり`MAX_REROLLS = 100`回のリロール）も含まれます。その後、100回目のロールが確定します。いずれかの制限が適用されると、`analyze()`が`.caps`（`{ maxExplosions: 100 }`、`{ maxRerolls: 100 }`）で表面化し、CLIが`exact probabilities (engine caps: ...)`を出力します。制限されたサポートまたは畳み込み演算が`10,000,000`の状態を超えた場合、またはすべての面が無制限のリロール（`1d6r>=1`）と一致する場合、分析は`method: "monte-carlo"`にフォールバックします。
- **ゼロによる除算（`/`）:** `roll()`は、評価された除数が`0`である場合に`ParseError("Division by zero")`をスローします。`analyze()`は、$P(\text{divisor} = 0) > 0$であるすべての正確な除数を同じ`ParseError("Division by zero")`で拒否し、被除数よりも前に除数を評価およびチェックするため、大きな被除数（`500d1000/(5d20-5)`）が`ExactTooLargeError`を介してチェックをスキップすることはできません。除数自体が正確に計算できない場合（たとえば、`1d6/(5d20!kh4-4)`で、`5d20!kh4`が爆発と保持/破棄を組み合わせる場合）、`analyze()`はモンテカルロ（`evaluate()`を介した`100,000`回の試行）にフォールバックします。いずれかのサンプリングされた試行が`0`にヒットした場合、`ParseError("Division by zero")`がスローされます。まれなゼロの結果がサンプリングで見逃された場合、結果は`method: "monte-carlo"`（`samples: 100_000`）として返されます。決して`"exact"`ではありません。

## JSONブリッジ（Godot / Unreal / Rust）

Rollには、子プロセスを介したゲームエンジン統合のためのJSON-RPC 2.0ブリッジが含まれています。

```bash
# Stdio mode (pipe JSON in, get JSON out)
echo '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"4d6kh3","seed":42}}' | roll-bridge

# HTTP mode
roll-bridge --http --port 3947
curl -X POST http://localhost:3947/rpc -d '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"2d6+3"}}'
```

メソッド：`roll`、`roll_batch`、`analyze`、`at_least`、`compare`、`table_roll`、`table_load`、`table_list`、`seed`、`ping`、`shutdown`。

## MCPサーバー

Rollは、ゲームデザイン中にClaudeとの統合のために、MCPサーバーとして提供されます。

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

5つのツール：`roll_dice`、`analyze_dice`、`compare_dice`、`roll_table`、`query_table`。

## 確率エンジン

- 基本的なNdMのための多項式畳み込みによる**正確な分布**
- 保持/破棄メカニズムのための**完全な列挙**（4d6 = 1,296の状態）
- **解析的なリロール** — 一致しない面全体での閉形式の質量再分配と、`MAX_REROLLS = 100`制限の残差
- **解析的な最小/最大** — 分布を切り捨て、制限値に質量を積み重ねる
- **解析的な成功回数のカウント** — 面を+1/0/-1にマッピングし、N回畳み込む
- 爆発/複合/貫通サイコロを最大`MAX_EXPLOSIONS = 100`まで拡張するための**正確なエンジン制限の拡張**
- 正確な計算が1000万の状態を超えた場合、または可変数の爆発を保持/破棄または成功回数のカウントと組み合わせた場合に、**モンテカルロへのフォールバック**（10万回のサンプル）

すべてのモディファイアは、シミュレーションだけでなく、正確な確率分析を備えています。

## セキュリティと信頼性

サイコロの式のみを処理します。ネットワークリクエスト、ファイルへの書き込み（`--loot`が1つのJSONを読み取る場合を除く）、テレメトリ、秘密情報はありません。すべてのサイコロのロールには、暗号化された乱数生成器である`crypto.randomInt`が使用されます。リソースの枯渇を防ぐために、式は解析時に制限されます（サイコロの数、サイコロの面数、長さ）。また、`--loot`ファイルから読み取ったテキストは、表示する前にターミナル制御文字が削除されるため、敵対的なテーブルがANSIエスケープシーケンスをターミナルに挿入することはできません。

脆弱性報告ポリシーについては、[SECURITY.md](./SECURITY.md)を参照してください。

## ライセンス

MIT

---

<a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>によって作成されました。
