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

## ダイス表記法

Roll は、D&D、World of Darkness、Shadowrun、Savage Worlds、Fate などを含む、完全な Roll20/VTT 表記標準をサポートします。

| 表記法 | 意味 |
|----------|---------|
| `2d6` | 6面ダイスを2つ振る |
| `d20+5` | d20 を振り、修正値を加える |
| `4d6kh3` | 4d6 を振り、最も高い3つの目を残す |
| `4d6dl1` | 4d6 を振り、最も低い1つの目を捨てる |
| `1d6!` | 爆発（最大値で再ロールし、加算） |
| `1d6!>4` | 4以上で爆発 |
| `1d6!!` | 複合（爆発の値を同じダイスに集約） |
| `1d6!p` | 貫通（爆発の値から1を減算） |
| `2d6r<2` | 2未満の値を再ロールする（無制限） |
| `2d6ro=1` | 1を一度だけ再ロールする |
| `2d6min3` | 下限：3未満のダイスはなし |
| `2d6max5` | 上限：5を超えるダイスはなし |
| `8d6cs>=5` | 成功数を数える（ダイスの値が5以上） |
| `8d6cs>=5cf<=1` | 成功数から失敗数を引く |
| `1d20cs>19cf<2` | クリティカルな成功/失敗を示す |
| `4d6sa` / `4d6sd` | 昇順/降順でソートする |
| `d%` | パーセンタイル（1〜100） |
| `4dF` | Fate/Fudge ダイス |
| `(2d6+3)*2` | グループ化による算術演算 |

## CLI の使用方法

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

### 確率クエリ

`--at-least` に加えて、デザイナーが実際に尋ねる質問に答える4つのフラグがあります。それぞれ1行のきれいな出力を表示し、`--analyze` と同じ正確/モンテカルロ ラベルを使用します。

| フラグ | 回答 |
|------|---------|
| `--at-least N` | P(結果 ≥ N) |
| `--at-most N` | P(結果 ≤ N) |
| `--exactly N` | P(結果 = N) |
| `--between L..H` | P(L ≤ 結果 ≤ H) — `L,H` も受け入れます |
| `--target-for P` | P(結果 ≥ T) ≥ P ("65% の確率で命中する、目標値 ≤ T") となる最大の目標値 T |

`--compare A B` は、2つのステータスブロックの上に **対比** 結果を追加します。P(A が勝利)、P(引き分け)、P(B が勝利)、および平均差 E[A−B] を表示するため、バランスの問題を直接解決できます。`--json` オプションを使用すると、`comparison` オブジェクト (`pAGreater`, `pEqual`, `pBGreater`, `meanMargin`) が含まれます。

### 決定的なロール（`--seed`）

`--seed <int>` は RNG にシードを設定するため、ロール（または `--times N` シーケンス全体）がバイト単位で再現可能になります。エンジン、ブリッジ、MCP がすでに持っていた決定性を CLI でも実現します。シードは有限の整数である必要があります。不正なシードの場合、エラーが発生して 1 で終了します。**負の**シードを渡すには、`=` 形式 (`--seed=-3`) を使用してください。これは、スペースで区切られた先頭のハイフン値が引数パーサーにとって曖昧になるためです。`--json` は `seed` をエコーするため、出力に正確に何が生成されたかが記録されます。

```bash
roll 4d6kh3 --seed 42             # same result every time
roll 1d20 --seed 7 --times 5      # a fixed, reproducible sequence of 5 rolls
roll 2d6 --seed 99 --json         # output includes "seed": 99
```

### 色

デフォルトでは色が有効になっています。次の2つの方法で無効にできます。

- `--no-color` — 1回の呼び出しに対して ANSI スタイルを抑制します
- `NO_COLOR=1`（環境変数）— [NO_COLOR](https://no-color.org/) 標準に従います

アナライザーが、大規模または複雑な式の場合にモンテカルロ法を使用する場合、`--analyze` と `--at-least` は結果を推定値としてラベル付けします（サンプル数とともに）。サンプリングされた数値は正確であるものとして表示されません。正確な結果にはその旨が明記されます。`--json` 出力には `method` フィールド (`"exact"` または `"monte-carlo"`、サンプリングされた場合は `samples`) が含まれるため、機械的な処理を行うプログラムでもそれらを区別できます。

### 終了コード

Roll は、スクリプトが依存できる安定性を保証するために、意図的に2つのコードの契約に従います。

| コード | 意味 |
|------|---------|
| `0` | 成功 |
| `1` | エラー（不正な式、検証失敗、欠落したルーターファイル、または上限超過） |

エラーは常に1行のきれいな出力（コード/メッセージ/ヒント）を stderr に出力します。CLI はスタックトレースを漏洩させません。

## ゲームテーブル

V2 では、遭遇、クリティカルヒット、ルーター、ステータス効果など、汎用的なゲームテーブルシステムが導入されました。

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

機能：8種類のテーブル、重み付けされた選択、条件（比較、自然値、タグ、コンテキスト）、レベルフィルタリング、ネストされたテーブル、テーブルのチェーン化、数量/ロール/期間のダイス式、レアリティ階層、循環参照検出による検証。

## ライブラリ API

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

**高レベル API は安定しており、セマンティックバージョニングに従います** — 破壊的な変更はメジャーバージョンでのみ行われます。

- `roll`, `analyze`
- ルーター API (`rollLootTable`, `validateLootTables`) およびゲームテーブル API (`rollGameTable`)
- `BridgeHandler` JSON-RPC インターフェース

**低レベルのパーサー内部は高度であり、マイナーバージョンで変更される可能性があります** — 自分で AST を操作する必要がある場合にのみ使用し、依存する場合はバージョンを固定してください。

- `tokenize`, `Token`, `TokenType`
- `runPipeline`, `matchesCompare`

`analyze` は `.method` (`"exact"` | `"monte-carlo"`) と、サンプリングされたパスの場合は `.samples` もレポートするため、呼び出し元は正確な確率の契約をプログラムで尊重できます。

## JSON ブリッジ（Godot / Unreal / Rust）

Roll には、子プロセスを介したゲームエンジン統合のための JSON-RPC 2.0 ブリッジが含まれています。

```bash
# Stdio mode (pipe JSON in, get JSON out)
echo '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"4d6kh3","seed":42}}' | roll-bridge

# HTTP mode
roll-bridge --http --port 3947
curl -X POST http://localhost:3947/rpc -d '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"2d6+3"}}'
```

メソッド：`roll`, `roll_batch`, `analyze`, `at_least`, `compare`, `table_roll`, `table_load`, `table_list`, `seed`, `ping`, `shutdown`.

## MCP サーバー

Roll は、ゲームデザイン中に Claude と統合するための MCP サーバーとして提供されます。

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

5つのツール：`roll_dice`, `analyze_dice`, `compare_dice`, `roll_table`, `query_table`.

## 確率エンジン

- 基本的なNdMにおいて、多項式畳み込みを用いて**正確な確率分布**を算出
- キープ/ドロップの仕組みについて、**すべての状態を列挙**（4d6 = 1,296の状態）
- **解析的な再ロール** — 一致しない面に対して確率質量を再配分
- **解析的な最小値/最大値** — 分布を切り捨て、制限値に確率質量を集約
- **解析的な成功回数のカウント** — 各面を+1/0/-1に対応付け、N回畳み込む
- 爆発/複合/貫通ダイスに対して、**切り捨てられた再帰処理**を使用
- 正確な計算が1,000万状態を超える場合、**モンテカルロ法による代替手段**（10万サンプル）を使用

すべての修正には正確な確率分析が含まれており、単なるシミュレーションではありません。

## セキュリティと信頼性

ダイスの式のみを処理し、それ以外のことは行いません。ネットワークへのリクエストやファイルへの書き込み（`--loot`オプションで1つのJSONファイルを読み込む場合を除く）、テレメトリー、秘密情報は一切使用しません。すべてのダイスロールには、暗号化された乱数生成のために`crypto.randomInt`を使用します。式の解析時に、リソースの枯渇を防ぐために、ダイスの個数、面の数、長さが制限されます。また、`--loot`ファイルから読み込まれたテキストは、表示前に端末制御文字を削除するため、悪意のあるテーブルがANSIエスケープシーケンスを端末に挿入することはできません。

脆弱性報告ポリシーについては、[SECURITY.md](./SECURITY.md)を参照してください。

## ライセンス

MIT

---

<a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>によって作成されました
