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

<p align="center">Universal RPG dice engine — full notation, probability analysis, game tables, and engine integration.</p>

```
npx @mcptoolshop/roll 8d6cs>=5 --analyze
```

## Installa

```bash
npm install @mcptoolshop/roll
```

Richiede Node.js >= 22. Nessuna dipendenza in fase di esecuzione.

## Notazione dei dadi

Roll supporta lo standard completo di notazione Roll20/VTT, che copre D&D, World of Darkness, Shadowrun, Savage Worlds, Fate e altro.

| Notazione | Significato |
|----------|---------|
| `2d6` | Lancia 2 dadi a sei facce |
| `d20+5` | Lancia d20, aggiungi un modificatore |
| `4d6kh3` | Lancia 4d6, mantieni i 3 più alti |
| `4d6dl1` | Lancia 4d6, scarta l'1 più basso |
| `1d6!` | Esplosione (rilancia al valore massimo, aggiungi) |
| `1d6!>4` | Esplodi con 4 o più |
| `1d6!!` | Composizione (somma le esplosioni nello stesso dado) |
| `1d6!p` | Penetrazione (le esplosioni sottraggono 1) |
| `2d6r<2` | Rilancia i valori inferiori a 2 (illimitato) |
| `2d6ro=1` | Rilancia gli 1 una volta |
| `2d6min3` | Limite inferiore: nessun dado inferiore a 3 |
| `2d6max5` | Limite superiore: nessun dado superiore a 5 |
| `8d6cs>=5` | Conta i successi (dadi >= 5) |
| `8d6cs>=5cf<=1` | Successi meno fallimenti |
| `1d20cs>19cf<2` | Marcatura di successo/fallimento critico |
| `4d6sa` / `4d6sd` | Ordina in ordine crescente/decrescente |
| `d%` | Percentile (1-100) |
| `4dF` | Dadi Fate/Fudge |
| `(2d6+3)*2` | Aritmetica con raggruppamento |

## Utilizzo da riga di comando

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

### Query di probabilità

Oltre a `--at-least`, questi flag rispondono alle domande che un progettista si pone effettivamente. Ognuno stampa una singola riga pulita e rispetta esattamente le stesse etichette (esatte/Monte-Carlo) di `--analyze`:

| Flag | Risposte |
|------|---------|
| `--at-least N` | P(risultato ≥ N) |
| `--at-most N` | P(risultato ≤ N) |
| `--exactly N` | P(risultato = N) |
| `--between L..H` | P(L ≤ risultato ≤ H) — accetta anche `L,H` |
| `--target-for P` | Il valore di destinazione più grande T tale che P(risultato ≥ T) ≥ P ("per colpire il 65% delle volte, destinazione ≤ T") |
| `--at-most-for P` | Il valore T più piccolo tale che P(risultato ≤ T) ≥ P ("il 65% dei risultati è uguale o inferiore a T") |

`--compare A B` aggiunge ora un verdetto "**Versus**" oltre ai due blocchi di statistiche: P(A vince), P(pareggio), P(B vince) e il margine medio E[A−B], in modo da poter risolvere direttamente la questione dell'equilibrio. Con `--json`, include un oggetto `comparison` (`pAGreater`, `pEqual`, `pBGreater`, `meanMargin`).

### Lanci deterministici (`--seed`)

`--seed <int>` inizializza il generatore di numeri casuali (RNG) in modo che un lancio (o un'intera sequenza `--times N`) sia riproducibile byte per byte: il determinismo che il motore, il bridge e l'MCP avevano già, ora anche nella riga di comando. Il seme deve essere un numero intero finito; un seme errato genera un errore e termina con codice 1. Per passare un seme **negativo**, utilizzare il formato `=` (`--seed=-3`), poiché un valore con un trattino iniziale separato da spazi è ambiguo per l'analizzatore degli argomenti. `--json` fa eco a `seed` in modo che l'output registri esattamente cosa lo ha prodotto.

```bash
roll 4d6kh3 --seed 42             # same result every time
roll 1d20 --seed 7 --times 5      # a fixed, reproducible sequence of 5 rolls
roll 2d6 --seed 99 --json         # output includes "seed": 99
```

### Colore

Il colore è attivo per impostazione predefinita. Disabilitalo in due modi:

- `--no-color`: sopprime lo stile ANSI per una singola invocazione
- `NO_COLOR=1` (variabile d'ambiente): viene rispettato secondo lo standard [NO_COLOR](https://no-color.org/)

Quando l'analizzatore passa a Monte Carlo per un'espressione ampia o complessa, `--analyze` e `--at-least` etichettano il risultato come stimato (con il conteggio dei campioni) anziché presentare i numeri campionati come esatti. I risultati esatti sono contrassegnati come tali e, ogni volta che una distribuzione esatta si basa sui limiti finiti del ciclo del motore (`MAX_EXPLOSIONS = 100`, `MAX_REROLLS = 100`), la nota indica il/i limite/i modellato/i (`exact probabilities (engine caps: ...)`). L'output `--json` include `method` (`"exact"` o `"monte-carlo"`), `samples` quando viene campionato e `caps` (`{ maxExplosions?: 100, maxRerolls?: 100 }`) quando si applicano i limiti del motore.

### Codici di uscita

Roll segue un contratto deliberato a due codici: una promessa di stabilità su cui gli script possono fare affidamento:

| Codice | Significato |
|------|---------|
| `0` | Successo |
| `1` | Qualsiasi errore: espressione errata, errore di convalida, file di bottino mancante o limite superato |

Gli errori stampano sempre una singola riga pulita (codice/messaggio/suggerimento) su stderr; la riga di comando non rivela mai una traccia dello stack.

## Tabelle di gioco

V2 introduce un sistema di tabelle di gioco universale per incontri, colpi critici, bottino, effetti di stato e altro.

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

Funzionalità: 8 tipi di tabelle, selezione ponderata, condizioni (confronta, valore naturale, tag, contesto), filtro di livello, tabelle nidificate, concatenazione di tabelle, espressioni di dadi per quantità/lancio/durata, livelli di rarità, convalida con rilevamento di riferimenti circolari.

## API della libreria

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

### Stabilità

L'**API di alto livello è stabile** e segue semver: le modifiche che causano interruzioni avvengono solo con un aggiornamento della versione principale:

- `roll`, `analyze`
- le API del bottino (`rollLootTable`, `validateLootTables`) e le API delle tabelle di gioco (`rollGameTable`)
- la superficie `BridgeHandler` JSON-RPC

**Gli elementi interni del parser di basso livello sono avanzati e possono cambiare nelle versioni secondarie**: utilizzali solo se devi analizzare l'AST da solo e blocca una versione se ne dipendi:

- `tokenize`, `Token`, `TokenType`
- `runPipeline`, `matchesCompare`

`analyze` segnala anche `.method` (`"exact"` | `"monte-carlo"`), `.samples` per il percorso campionato e `.caps` (`{ maxExplosions?: number; maxRerolls?: number }`) sul percorso esatto ogni volta che viene modellato un limite del ciclo del motore, in modo che i chiamanti possano rispettare il contratto delle probabilità esatte a livello di programma.

### Esattezza, limiti del motore e divisione per zero

- **Cosa significa `"exact"` con l'uso di limiti:** Nella matematica pura, i dadi esplosivi (`!`, `!!`, `!p`) e i tiri ripetuti illimitati (`r`) non hanno un supporto finito. In Roll, `method: "exact"` significa "esatto" per il motore così come è stato costruito (`runPipeline`), inclusi i suoi limiti di ciclo (`MAX_EXPLOSIONS = 100` tiri bonus per dado iniziale; `MAX_REROLLS = 100` tiri ripetuti per modificatore illimitato `r`, dopodiché il 100° tiro è definitivo). Ogni volta che uno dei limiti viene applicato, `analyze()` lo manifesta in `.caps` (`{ maxExplosions: 100 }`, `{ maxRerolls: 100 }`) e la CLI stampa `exact probabilities (engine caps: ...)`. Se il supporto limitato o la convoluzione superano `10,000,000` stati, o se ogni faccia corrisponde a un tiro ripetuto illimitato (`1d6r>=1`), l'analisi torna a `method: "monte-carlo"`.
- **Divisione per zero (`/`):** `roll()` genera un errore `ParseError("Division by zero")` ogni volta che un divisore valutato è `0`. `analyze()` rifiuta qualsiasi divisore esatto con $P(\text{divisor} = 0) > 0$ utilizzando lo stesso `ParseError("Division by zero")`, valutando e controllando il divisore *prima* del dividendo, in modo che un dividendo elevato (`500d1000/(5d20-5)`) non possa saltare il controllo tramite `ExactTooLargeError`. Quando il divisore *stesso* non può essere calcolato esattamente (ad esempio `1d6/(5d20!kh4-4)`, dove `5d20!kh4` combina l'esplosione con la conservazione/eliminazione), `analyze()` torna a Monte Carlo (`100,000` prove tramite `evaluate()`): se una qualsiasi delle prove campionate raggiunge `0`, viene generato un errore `ParseError("Division by zero")`; se un raro risultato zero viene perso durante il campionamento, il risultato viene restituito come `method: "monte-carlo"` (`samples: 100_000`) — mai `"exact"`.

## Bridge JSON (Godot / Unreal / Rust)

Roll include un bridge JSON-RPC 2.0 per l'integrazione con il motore di gioco tramite un processo figlio:

```bash
# Stdio mode (pipe JSON in, get JSON out)
echo '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"4d6kh3","seed":42}}' | roll-bridge

# HTTP mode
roll-bridge --http --port 3947
curl -X POST http://localhost:3947/rpc -d '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"2d6+3"}}'
```

Metodi: `roll`, `roll_batch`, `analyze`, `at_least`, `compare`, `table_roll`, `table_load`, `table_list`, `seed`, `ping`, `shutdown`.

## Server MCP

Roll viene fornito come server MCP per l'integrazione con Claude durante la progettazione del gioco:

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

5 strumenti: `roll_dice`, `analyze_dice`, `compare_dice`, `roll_table`, `query_table`.

## Motore di probabilità

- **Distribuzioni esatte** tramite convoluzione polinomiale per NdM di base
- **Enumerazione completa** per meccaniche di conservazione/eliminazione (4d6 = 1.296 stati)
- **Ritiro analitico** — ridistribuzione della massa in forma chiusa sulle facce non corrispondenti più il residuo del limite `MAX_REROLLS = 100`
- **Minimo/massimo analitico** — tronca la distribuzione e accumula la massa al limite
- **Conteggio analitico dei successi** — mappa le facce a +1/0/-1, convoluziona N volte
- **Espansione esatta del limite del motore** per dadi esplosivi/composti/penetranti fino a `MAX_EXPLOSIONS = 100`
- **Fallback Monte Carlo** (100.000 campioni) quando il calcolo esatto supera i 10 milioni di stati o combina esplosioni a numero variabile con la conservazione/eliminazione o il conteggio dei successi

Ogni modificatore ha un'analisi di probabilità esatta, non solo una simulazione.

## Sicurezza e affidabilità

Elabora espressioni di dadi e nient'altro. Nessuna richiesta di rete, nessuna scrittura di file (eccetto `--loot` che legge un file JSON), nessun telemetria, nessun segreto. Tutti i tiri di dadi utilizzano `crypto.randomInt` per la casualità crittografica. Le espressioni sono limitate al momento dell'analisi (numero di dadi, facce del dado, lunghezza) per prevenire l'esaurimento delle risorse e qualsiasi testo letto da un file `--loot` viene privato dei caratteri di controllo del terminale prima della visualizzazione, in modo che una tabella ostile non possa iniettare sequenze di escape ANSI nel terminale.

Consultare [SECURITY.md](./SECURITY.md) per la politica di segnalazione delle vulnerabilità.

## Licenza

MIT

---

Creato da <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
