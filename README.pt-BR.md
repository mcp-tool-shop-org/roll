<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.md">English</a>
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

## Instalação

```bash
npm install @mcptoolshop/roll
```

Requer Node.js >= 22.

## Uso da Linha de Comando

### Lançar dados

```bash
roll 2d6+3
roll d20+5
roll 4d6kh3
roll 1d6!
roll d%
roll 4dF
roll "(2d6+3)*2"
```

### Analisar probabilidade

```bash
roll 2d6 --analyze          # Full distribution + statistics
roll d20+5 --at-least 15    # P(result >= 15)
```

### Comparar distribuições

```bash
roll --compare "4d6dl1" "3d6"
```

Estatísticas lado a lado (média, mediana, moda, desvio padrão, intervalo, entropia) com coluna de diferença, além de ambos os histogramas.

### Tabelas de recompensas

```bash
roll --loot treasure.json
```

Formato JSON:

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

Características: seleção ponderada, referências de tabelas aninhadas, expressões de dados para quantidade e valor.

### Outras opções

```bash
roll 2d6+3 --times 5       # Roll 5 times
roll 2d6+3 --json           # Machine-readable output
roll --help                 # Full usage
roll --version              # Version
```

## Notação de Dados

| Notação | Significado |
|----------|---------|
| `2d6` | Lançar 2 dados de seis lados |
| `d20` | Lançar 1 dado de vinte lados |
| `4d6kh3` | Lançar 4d6, manter os 3 maiores |
| `4d6dl1` | Lançar 4d6, descartar o menor |
| `1d6!` | Dado explosivo (relançar no máximo, adicionar) |
| `1d6!>4` | Explodir em 4 ou mais |
| `d%` | Dado de percentil (1-100) |
| `4dF` | Dados Fate/Fudge (-1, 0, +1 cada) |
| `(2d6+3)*2` | Aritmética com agrupamento |
| `2d6+1d4+3` | Expressões encadeadas |

## API da Biblioteca

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

## Motor de Probabilidade

- **Distribuições exatas** via convolução polinomial para NdM básicos
- **Enumeração completa** para mecânicas de manter/descartar (4d6 = 1.296 estados)
- **Recursão truncada** para dados explosivos (limitado a 10 explosões)
- **Fallback de Monte Carlo** (100 mil amostras) quando o cálculo exato excede 10 milhões de estados

## Sem Dependências

Construído inteiramente com os recursos nativos do Node.js 22+:
- `util.styleText` para cores no terminal
- `util.parseArgs` para análise de argumentos da linha de comando
- `crypto.randomInt` para geração de números aleatórios criptograficamente seguros

## Segurança e Confiança

O `@mcptoolshop/roll` processa apenas expressões de dados e nada mais. Não faz solicitações de rede, não escreve arquivos e não coleta dados. O único acesso ao sistema de arquivos é a flag `--loot`, que lê um único arquivo JSON especificado pelo usuário.

Não há telemetria, análise ou rastreamento de qualquer tipo. Nenhum segredo, token ou credencial está envolvido em nenhuma operação.

Todos os lançamentos de dados usam `crypto.randomInt` do módulo `crypto` do Node.js, fornecendo aleatoriedade criptograficamente segura, adequada para resultados justos.

Consulte [SECURITY.md](./SECURITY.md) para a política de relatório de vulnerabilidades.

## Licença

MIT

---

Desenvolvido por <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
