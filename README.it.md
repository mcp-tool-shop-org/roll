<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.md">English</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

## Installazione

```bash
npm install @mcptoolshop/roll
```

Richiede Node.js >= 22.

## Utilizzo da riga di comando

### Lancia i dadi

```bash
roll 2d6+3
roll d20+5
roll 4d6kh3
roll 1d6!
roll d%
roll 4dF
roll "(2d6+3)*2"
```

### Analizza la probabilità

```bash
roll 2d6 --analyze          # Full distribution + statistics
roll d20+5 --at-least 15    # P(result >= 15)
```

### Confronta le distribuzioni

```bash
roll --compare "4d6dl1" "3d6"
```

Statistiche affiancate (media, mediana, moda, deviazione standard, intervallo, entropia) con colonna delle differenze, più entrambi gli istogrammi.

### Tabelle di bottino

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

Funzionalità: selezione ponderata, riferimenti a tabelle nidificate, espressioni per i dadi per quantità e valore.

### Altre opzioni

```bash
roll 2d6+3 --times 5       # Roll 5 times
roll 2d6+3 --json           # Machine-readable output
roll --help                 # Full usage
roll --version              # Version
```

## Notazione dei dadi

| Notazione | Significato |
|----------|---------|
| `2d6` | Lancia 2 dadi a sei facce |
| `d20` | Lancia 1 dado a venti facce |
| `4d6kh3` | Lancia 4d6, conserva i 3 più alti |
| `4d6dl1` | Lancia 4d6, scarta il più basso |
| `1d6!` | Dado esplosivo (rilancia al massimo, aggiungi) |
| `1d6!>4` | Esplode se ottieni 4 o più |
| `d%` | Dado percentile (da 1 a 100) |
| `4dF` | Dadi Fate/Fudge (-1, 0, +1 ciascuno) |
| `(2d6+3)*2` | Operazioni aritmetiche con raggruppamento |
| `2d6+1d4+3` | Espressioni concatenate |

## API della libreria

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

## Motore di probabilità

- **Distribuzioni esatte** tramite convoluzione polinomiale per i dadi NdM di base
- **Enumerazione completa** per le meccaniche di conservazione/scarto (4d6 = 1.296 stati)
- **Ricorsione troncata** per i dadi esplosivi (limitata a 10 esplosioni)
- **Fallback Monte Carlo** (100.000 campioni) quando il calcolo esatto supera i 10 milioni di stati

## Nessuna dipendenza esterna

Costruito interamente con le funzionalità integrate di Node.js 22+:
- `util.styleText` per i colori del terminale
- `util.parseArgs` per l'analisi degli argomenti da riga di comando
- `crypto.randomInt` per la generazione di numeri casuali crittograficamente sicuri per i tiri di dado

## Sicurezza e affidabilità

`@mcptoolshop/roll` elabora solo espressioni per i dadi e nient'altro. Non effettua richieste di rete, non scrive file e non raccoglie dati. L'unico accesso al file system è tramite il flag `--loot`, che legge un singolo file JSON specificato dall'utente.

Non sono presenti telemetrie, analisi o tracciamenti di alcun tipo. Non sono coinvolti segreti, token o credenziali in nessuna operazione.

Tutti i tiri di dado utilizzano `crypto.randomInt` dal modulo `crypto` di Node.js, fornendo una casualità crittograficamente sicura adatta per risultati equi.

Consultare [SECURITY.md](./SECURITY.md) per la politica di segnalazione delle vulnerabilità.

## Licenza

MIT

---

Creato da <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
