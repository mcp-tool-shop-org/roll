<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.md">English</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

## Installation

```bash
npm install @mcptoolshop/roll
```

Nécessite Node.js >= 22.

## Utilisation de l'interface en ligne de commande (CLI)

### Lancer des dés

```bash
roll 2d6+3
roll d20+5
roll 4d6kh3
roll 1d6!
roll d%
roll 4dF
roll "(2d6+3)*2"
```

### Analyser les probabilités

```bash
roll 2d6 --analyze          # Full distribution + statistics
roll d20+5 --at-least 15    # P(result >= 15)
```

### Comparer les distributions

```bash
roll --compare "4d6dl1" "3d6"
```

Statistiques côte à côte (moyenne, médiane, mode, écart type, plage, entropie) avec une colonne de différence, ainsi que les deux histogrammes.

### Tables de butin

```bash
roll --loot treasure.json
```

Format JSON :

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

Fonctionnalités : sélection pondérée, références de tables imbriquées, expressions de dés pour la quantité et la valeur.

### Autres options

```bash
roll 2d6+3 --times 5       # Roll 5 times
roll 2d6+3 --json           # Machine-readable output
roll --help                 # Full usage
roll --version              # Version
```

## Notation des dés

| Notation | Signification |
|----------|---------|
| `2d6` | Lancer 2 dés à 6 faces |
| `d20` | Lancer 1 dé à 20 faces |
| `4d6kh3` | Lancer 4d6, conserver les 3 plus élevés |
| `4d6dl1` | Lancer 4d6, éliminer le plus bas |
| `1d6!` | Dé explosif (relancer sur le maximum, ajouter) |
| `1d6!>4` | Exploser sur 4 ou plus |
| `d%` | Dé en pourcentage (1-100) |
| `4dF` | Dés Fate/Fudge (-1, 0, +1 chacun) |
| `(2d6+3)*2` | Opérations arithmétiques avec regroupement |
| `2d6+1d4+3` | Expressions chaînées |

## API de la bibliothèque

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

## Moteur de probabilités

- **Distributions exactes** via convolution polynomiale pour les dés de base (NdM)
- **Énumération complète** pour les mécanismes de conservation/élimination (4d6 = 1296 états)
- **Récursion tronquée** pour les dés explosifs (limité à 10 explosions)
- **Rétrogradation Monte Carlo** (100 000 échantillons) lorsque le calcul exact dépasse 10 millions d'états

## Aucune dépendance

Construit entièrement sur les fonctionnalités intégrées de Node.js 22+ :
- `util.styleText` pour les couleurs du terminal
- `util.parseArgs` pour l'analyse des arguments de l'interface en ligne de commande
- `crypto.randomInt` pour des lancers de dés cryptographiquement sécurisés

## Sécurité et confiance

`@mcptoolshop/roll` traite les expressions de dés et rien d'autre. Il ne fait aucune requête réseau, n'écrit aucun fichier et ne collecte aucune donnée. L'accès au système de fichiers est limité à l'option `--loot`, qui lit un seul fichier JSON spécifié par l'utilisateur.

Il n'y a pas de télémétrie, d'analyse ni de suivi de quelque nature que ce soit. Aucun secret, jeton ou identifiant n'est impliqué dans aucune opération.

Tous les lancers de dés utilisent `crypto.randomInt` du module `crypto` de Node.js, ce qui fournit une aléatoire cryptographiquement sécurisée, adaptée pour des résultats équitables.

Consultez [SECURITY.md](./SECURITY.md) pour connaître la politique de signalement des vulnérabilités.

## Licence

MIT

---

Créé par <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
