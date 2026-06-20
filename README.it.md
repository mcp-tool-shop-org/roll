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

Roll supporta lo standard completo di notazione Roll20/VTT, che copre D&D, World of Darkness, Shadowrun, Savage Worlds, Fate e altro ancora.

| Notazione | Significato |
|----------|---------|
| `2d6` | Lancia 2 dadi a sei facce |
| `d20+5` | Lancia un d20, aggiungi il modificatore |
| `4d6kh3` | Lancia 4d6, mantieni i 3 valori più alti |
| `4d6dl1` | Lancia 4d6, scarta il valore più basso |
| `1d6!` | Esplosione (rilancio al valore massimo, aggiungi) |
| `1d6!>4` | Esplodi con un risultato di 4 o superiore |
| `1d6!!` | Composizione (somma le esplosioni nello stesso dado) |
| `1d6!p` | Penetrazione (le esplosioni sottraggono 1) |
| `2d6r<2` | Rilancia i valori inferiori a 2 (illimitato) |
| `2d6ro=1` | Rilancia gli 1 una volta |
| `2d6min3` | Valore minimo: nessun dado inferiore a 3 |
| `2d6max5` | Valore massimo: nessun dado superiore a 5 |
| `8d6cs>=5` | Conta i successi (dadi >= 5) |
| `8d6cs>=5cf<=1` | Successi meno fallimenti |
| `1d20cs>19cf<2` | Indicazione di successo/fallimento critico |
| `4d6sa` / `4d6sd` | Ordina in ordine crescente/decrescente |
| `d%` | Percentile (1-100) |
| `4dF` | Dadi Fate/Fudge |
| `(2d6+3)*2` | Calcoli con raggruppamento |

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
roll --compare "4d6dl1" "3d6"     # Side-by-side + P(A>B) verdict
roll --loot treasure.json         # Loot table
roll 2d6+3 --times 5              # Multiple rolls
roll 4d6kh3 --seed 42             # Deterministic, reproducible rolls
roll 2d6+3 --json                 # Machine-readable output
roll 2d6 --analyze --no-color     # Disable ANSI color for this run
```

### Query sulla probabilità

Oltre a `--at-least`, quattro flag rispondono alle domande che un progettista si pone effettivamente. Ognuno stampa una singola riga pulita e rispetta esattamente le stesse etichette (esatte/Monte Carlo) di `--analyze`:

| Flag | Risposte |
|------|---------|
| `--at-least N` | P(risultato ≥ N) |
| `--at-most N` | P(risultato ≤ N) |
| `--exactly N` | P(risultato = N) |
| `--between L..H` | P(L ≤ risultato ≤ H) — accetta anche `L,H` |
| `--target-for P` | Il valore target più grande T tale che P(risultato ≥ T) ≥ P ("per colpire il 65% delle volte, target ≤ T") |

`--compare A B` ora aggiunge un verdetto **Versus** in cima ai due blocchi di statistiche — P(A vince), P(pareggio), P(B vince) e il margine medio E[A−B] — in modo da poter risolvere direttamente la questione dell'equilibrio. Con `--json` include un oggetto `comparison` (`pAGreater`, `pEqual`, `pBGreater`, `meanMargin`).

### Lanci deterministici (`--seed`)

`--seed <int>` inizializza il generatore di numeri casuali in modo che un lancio (o un'intera sequenza `--times N`) sia riproducibile byte per byte — il determinismo che l'engine, il bridge e l'MCP avevano già, ora anche nella riga di comando. Il valore deve essere un intero finito; un valore errato genera un errore ed esce con codice 1. Per passare un valore **negativo**, usa la forma `=` (`--seed=-3`), poiché un valore separato da uno spazio con un trattino iniziale è ambiguo per l'analizzatore degli argomenti. `--json` ripete il `seed` in modo che l'output registri esattamente cosa lo ha prodotto.

```bash
roll 4d6kh3 --seed 42             # same result every time
roll 1d20 --seed 7 --times 5      # a fixed, reproducible sequence of 5 rolls
roll 2d6 --seed 99 --json         # output includes "seed": 99
```

### Colore

Il colore è attivo per impostazione predefinita. Disabilitalo in due modi:

- `--no-color` — sopprime lo stile ANSI per una singola esecuzione
- `NO_COLOR=1` (variabile d'ambiente) — rispettato secondo lo standard [NO_COLOR](https://no-color.org/)

Quando l'analizzatore passa a Monte Carlo per un'espressione ampia o complessa, `--analyze` e `--at-least` etichettano il risultato come stimato (con il numero di campioni) invece di presentare i numeri campionati come esatti. I risultati esatti sono indicati come tali. L'output `--json` include un campo `method` (`"exact"` o `"monte-carlo"`, con `samples` quando viene eseguito il campionamento), in modo che anche i sistemi automatizzati possano distinguerli.

### Codici di uscita

Roll segue un contratto deliberato a due codici — una promessa di stabilità su cui gli script possono fare affidamento:

| Codice | Significato |
|------|---------|
| `0` | Successo |
| `1` | Qualsiasi errore: espressione non valida, errore di validazione, file di loot mancante o limite superato |

Gli errori stampano sempre una singola riga pulita (codice/messaggio/suggerimento) su stderr; la riga di comando non rivela mai una traccia dello stack.

## Tabelle di gioco

La versione 2 introduce un sistema universale di tabelle di gioco per incontri, colpi critici, loot, effetti di stato e altro ancora.

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

Funzionalità: 8 tipi di tabella, selezione ponderata, condizioni (confronto, risultato naturale, tag, contesto), filtro per livello, tabelle nidificate, concatenazione di tabelle, espressioni dei dadi per quantità/lancio/durata, livelli di rarità, validazione con rilevamento di riferimenti circolari.

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

L'**API di alto livello è stabile** e segue semver — le modifiche che causano interruzioni avvengono solo con un aggiornamento della versione principale:

- `roll`, `analyze`
- le API del loot (`rollLootTable`, `validateLootTables`) e le API delle tabelle di gioco (`rollGameTable`)
- la superficie JSON-RPC di `BridgeHandler`

**Gli elementi interni dell'analizzatore sono avanzati e possono cambiare nelle versioni secondarie** — usali solo se hai bisogno di analizzare l'AST direttamente e fissa una versione se ne dipendi:

- `tokenize`, `Token`, `TokenType`
- `runPipeline`, `matchesCompare`

`analyze` segnala anche `.method` (`"exact"` | `"monte-carlo"`) e, per il percorso con campionamento, `.samples` — in modo che i chiamanti possano rispettare il contratto delle probabilità esatte a livello di programma.

## Bridge JSON (Godot / Unreal / Rust)

Roll include un bridge JSON-RPC 2.0 per l'integrazione con il motore di gioco tramite processo figlio:

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

- **Distribuzioni esatte** tramite convoluzione polinomiale per il sistema NdM di base
- **Enumerazione completa** per le meccaniche di mantenimento/eliminazione (4d6 = 1.296 stati)
- **Ricalcolo analitico:** ridistribuisce la probabilità sulle facce non corrispondenti
- **Calcolo analitico del valore minimo/massimo:** tronca la distribuzione e concentra la massa di probabilità al limite inferiore/superiore
- **Conteggio analitico dei successi:** associa le facce a +1/0/-1, esegue la convoluzione N volte
- **Ricorsione troncata** per dadi che esplodono/si sommano/perforano
- **Metodo Monte Carlo di riserva** (100.000 campioni) quando il calcolo esatto supera i 10 milioni di stati

Ogni modificatore è soggetto a un'analisi probabilistica precisa, non solo a una simulazione.

## Sicurezza e affidabilità

Elabora le espressioni dei dadi e nient'altro. Nessuna richiesta di rete, nessuna scrittura su file (eccetto la lettura di un singolo file JSON tramite l'opzione `--loot`), nessun telemetria, nessuna informazione sensibile. Tutti i lanci di dadi utilizzano `crypto.randomInt` per garantire una casualità crittografica. Le espressioni sono limitate in fase di analisi (numero di dadi, numero di facce, lunghezza) per evitare un eccessivo consumo di risorse e qualsiasi testo letto da un file specificato con l'opzione `--loot` viene privato dei caratteri di controllo del terminale prima della visualizzazione, in modo che una tabella ostile non possa inserire sequenze di escape ANSI nel terminale.

Consultare il file [SECURITY.md](./SECURITY.md) per la politica di segnalazione delle vulnerabilità.

## Licenza

MIT

---

Realizzato da <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
