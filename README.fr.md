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

<p align="center">Universal RPG dice engine — full notation, probability analysis, game tables, and engine integration.</p>

```
npx @mcptoolshop/roll 8d6cs>=5 --analyze
```

## Installer

```bash
npm install @mcptoolshop/roll
```

Nécessite Node.js >= 22. Aucune dépendance d’exécution.

## Notation de dés

Roll prend en charge la norme complète Roll20/VTT, couvrant D&D, World of Darkness, Shadowrun, Savage Worlds, Fate et plus encore.

| Notation | Signification |
|----------|---------|
| `2d6` | Lancer 2 dés à six faces |
| `d20+5` | Lancer un d20, ajouter un modificateur |
| `4d6kh3` | Lancer 4d6, conserver les 3 plus élevés |
| `4d6dl1` | Lancer 4d6, supprimer le plus petit |
| `1d6!` | Explosion (relancer en cas de résultat maximal, ajouter) |
| `1d6!>4` | Exploser à partir de 4 ou plus |
| `1d6!!` | Composition (additionner les explosions dans le même dé) |
| `1d6!p` | Pénétration (les explosions soustraient 1) |
| `2d6r<2` | Relancer les valeurs inférieures à 2 (illimité) |
| `2d6ro=1` | Relancer les 1 une fois |
| `2d6min3` | Plancher : aucun dé ne peut avoir une valeur inférieure à 3 |
| `2d6max5` | Plafond : aucun dé ne peut avoir une valeur supérieure à 5 |
| `8d6cs>=5` | Compter les succès (dés >= 5) |
| `8d6cs>=5cf<=1` | Succès moins échecs |
| `1d20cs>19cf<2` | Marquage des succès/échecs critiques |
| `4d6sa` / `4d6sd` | Trier par ordre croissant / décroissant |
| `d%` | Pourcentage (1-100) |
| `4dF` | Dés Fate/Fudge |
| `(2d6+3)*2` | Opérations arithmétiques avec regroupement |

## Utilisation en ligne de commande

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

### Requêtes de probabilité

Au-delà de `--at-least`, quatre indicateurs répondent aux questions que se pose réellement un concepteur. Chacun affiche une seule ligne propre et respecte le même étiquetage exact/Monte-Carlo que `--analyze` :

| Indicateur | Réponses |
|------|---------|
| `--at-least N` | P(résultat ≥ N) |
| `--at-most N` | P(résultat ≤ N) |
| `--exactly N` | P(résultat = N) |
| `--between L..H` | P(L ≤ résultat ≤ H) — accepte également `L,H` |
| `--target-for P` | La plus grande cible T telle que P(résultat ≥ T) ≥ P (« pour réussir 65 % du temps, la cible ≤ T ») |

`--compare A B` ajoute désormais un verdict **Versus** en plus des deux blocs de statistiques — P(A gagne), P(égalité), P(B gagne) et la marge moyenne E[A−B] — afin que vous puissiez résoudre directement le problème d’équilibre. Avec `--json`, il inclut un objet `comparison` (`pAGreater`, `pEqual`, `pBGreater`, `meanMargin`).

### Lancers déterministes (`--seed`)

`--seed <int>` initialise le générateur de nombres aléatoires afin qu’un lancer (ou une séquence entière `--times N`) soit reproductible octet par octet — la déterminisme que l’engine, le bridge et le MCP avaient déjà, maintenant disponible en ligne de commande. La valeur initiale doit être un entier fini ; une mauvaise valeur initiale provoque une erreur et l’arrêt du programme (code 1). Pour passer une valeur initiale **négative**, utilisez le format `=` (`--seed=-3`), car une valeur avec un tiret au début séparé par un espace est ambigu pour l’analyseur d’arguments. `--json` renvoie la `seed` afin que la sortie enregistre exactement ce qui a produit le résultat.

```bash
roll 4d6kh3 --seed 42             # same result every time
roll 1d20 --seed 7 --times 5      # a fixed, reproducible sequence of 5 rolls
roll 2d6 --seed 99 --json         # output includes "seed": 99
```

### Couleur

La couleur est activée par défaut. Vous pouvez la désactiver de deux manières :

- `--no-color` — supprime le style ANSI pour une seule exécution
- `NO_COLOR=1` (variable d’environnement) — respecte la norme [NO_COLOR](https://no-color.org/)

Lorsque l’analyseur revient à Monte Carlo pour une expression importante ou complexe, `--analyze` et `--at-least` étiquettent le résultat comme étant estimé (avec le nombre d’échantillons) au lieu de présenter les nombres échantillonnés comme exacts. Les résultats exacts sont indiqués comme tels. La sortie `--json` contient un champ `method` (`"exact"` ou `"monte-carlo"`, avec `samples` lorsque l’échantillonnage est utilisé), afin que les programmes puissent également les distinguer.

### Codes de sortie

Roll suit un contrat à deux codes délibéré — une promesse de stabilité sur laquelle les scripts peuvent compter :

| Code | Signification |
|------|---------|
| `0` | Succès |
| `1` | Toute erreur — mauvaise expression, échec de la validation, fichier de butin manquant ou limite dépassée |

Les erreurs affichent toujours une seule ligne propre (code/message/indice) sur stderr ; l’interface en ligne de commande ne divulgue jamais de trace de pile.

## Tables de jeu

La version 2 introduit un système universel de tables de jeu pour les rencontres, les coups critiques, le butin, les effets d’état et plus encore.

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

Fonctionnalités : 8 types de tables, sélection pondérée, conditions (comparaison, résultat naturel, balise, contexte), filtrage par niveau, tables imbriquées, chaînage de tables, expressions de dés pour la quantité/le lancer/la durée, niveaux de rareté, validation avec détection de références circulaires.

## API de bibliothèque

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

### Stabilité

L’**API de haut niveau est stable** et suit semver — les modifications incompatibles ne sont apportées qu’avec une mise à jour majeure :

- `roll`, `analyze`
- les API de butin (`rollLootTable`, `validateLootTables`) et les API de tables de jeu (`rollGameTable`)
- la surface JSON-RPC de `BridgeHandler`

**Les internes du parseur de bas niveau sont avancés et peuvent changer dans les versions mineures** — ne les utilisez que si vous devez parcourir l’AST vous-même, et fixez une version si vous en dépendez :

- `tokenize`, `Token`, `TokenType`
- `runPipeline`, `matchesCompare`

`analyze` signale également `.method` (`"exact"` | `"monte-carlo"`) et, pour le chemin échantillonné, `.samples` — afin que les appelants puissent respecter le contrat de probabilités exactes par programmation.

## Bridge JSON (Godot / Unreal / Rust)

Roll inclut un bridge JSON-RPC 2.0 pour l’intégration avec un moteur de jeu via un processus enfant :

```bash
# Stdio mode (pipe JSON in, get JSON out)
echo '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"4d6kh3","seed":42}}' | roll-bridge

# HTTP mode
roll-bridge --http --port 3947
curl -X POST http://localhost:3947/rpc -d '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"2d6+3"}}'
```

Méthodes : `roll`, `roll_batch`, `analyze`, `at_least`, `compare`, `table_roll`, `table_load`, `table_list`, `seed`, `ping`, `shutdown`.

## Serveur MCP

Roll est fourni en tant que serveur MCP pour l’intégration avec Claude pendant la conception du jeu :

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

5 outils : `roll_dice`, `analyze_dice`, `compare_dice`, `roll_table`, `query_table`.

## Moteur de probabilité

- **Distributions exactes** par convolution polynomiale pour les mécanismes de base NdM
- **Énumération complète** pour les mécaniques d’ajout/suppression (4d6 = 1 296 états)
- **Nouvel essai analytique** — redistribue la masse de probabilité sur les faces non correspondantes
- **Minimum/maximum analytique** — tronque la distribution et concentre la masse à une valeur limite
- **Comptage analytique des succès** — associe les faces à +1/0/-1, effectue une convolution N fois
- **Récursion tronquée** pour les dés explosifs/cumulatifs/perforants
- **Recours à Monte Carlo** (100 000 échantillons) lorsque le calcul exact dépasse 10 millions d’états

Chaque modificateur fait l’objet d’une analyse de probabilité exacte, et pas seulement d’une simulation.

## Sécurité et fiabilité

Traite les expressions de dés et rien d’autre. Aucune requête réseau, aucun enregistrement dans un fichier (sauf la lecture d’un seul fichier JSON avec l’option `--loot`), aucune télémétrie, aucun secret. Tous les jets de dés utilisent `crypto.randomInt` pour une aléatoire cryptographique. Les expressions sont limitées au moment de l’analyse (nombre de dés, nombre de faces, longueur) afin d’éviter l’épuisement des ressources, et tout texte lu à partir d’un fichier `--loot` est débarrassé des caractères de contrôle du terminal avant l’affichage, afin qu’une table malveillante ne puisse pas injecter de séquences d’échappement ANSI dans votre terminal.

Consultez le fichier [SECURITY.md](./SECURITY.md) pour connaître la politique de signalement des vulnérabilités.

## Licence

MIT

---

Créé par <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
