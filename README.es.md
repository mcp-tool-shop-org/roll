<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.md">English</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

## Instalar

```bash
npm install @mcptoolshop/roll
```

Requiere Node.js >= 22. No hay dependencias en tiempo de ejecución.

## Notación de dados

Roll admite el estándar completo de notación Roll20/VTT que cubre D&D, World of Darkness, Shadowrun, Savage Worlds, Fate y más.

| Notación | Significado |
|----------|---------|
| `2d6` | Lanzar 2 dados de seis caras |
| `d20+5` | Lanzar d20, añadir modificador |
| `4d6kh3` | Lanzar 4d6, mantener los 3 más altos |
| `4d6dl1` | Lanzar 4d6, descartar el 1 más bajo |
| `1d6!` | Explosivo (relanzar en el máximo, sumar) |
| `1d6!>4` | Explosivo en 4 o más |
| `1d6!!` | Compuesto (sumar las explosiones en el mismo dado) |
| `1d6!p` | Penetrante (las explosiones restan 1) |
| `2d6r<2` | Relanzar valores menores que 2 (ilimitado) |
| `2d6ro=1` | Relanzar 1s una vez |
| `2d6min3` | Límite inferior: ningún dado por debajo de 3 |
| `2d6max5` | Límite superior: ningún dado por encima de 5 |
| `8d6cs>=5` | Contar éxitos (dados >= 5) |
| `8d6cs>=5cf<=1` | Éxitos menos fallos |
| `1d20cs>19cf<2` | Marcado de éxito/fracaso crítico |
| `4d6sa` / `4d6sd` | Ordenar de forma ascendente/descendente |
| `d%` | Porcentaje (1-100) |
| `4dF` | Dados Fate/Fudge |
| `(2d6+3)*2` | Aritmética con agrupación |

## Uso de la CLI

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

### Consultas de probabilidad

Más allá de `--at-least`, estas opciones responden a las preguntas que realmente hace un diseñador. Cada una imprime una línea limpia y respeta el etiquetado exacto/Monte-Carlo como `--analyze`:

| Opción | Responde |
|------|---------|
| `--at-least N` | P(resultado ≥ N) |
| `--at-most N` | P(resultado ≤ N) |
| `--exactly N` | P(resultado = N) |
| `--between L..H` | P(L ≤ resultado ≤ H) — también acepta `L,H` |
| `--target-for P` | El objetivo más grande T tal que P(resultado ≥ T) ≥ P ("para acertar el 65% de las veces, objetivo ≤ T") |
| `--at-most-for P` | El T más pequeño tal que P(resultado ≤ T) ≥ P ("el 65% de los resultados caen en o por debajo de T") |

`--compare A B` ahora añade un veredicto "**Versus**" además de los dos bloques de estadísticas: P(A gana), P(empate), P(B gana) y el margen medio E[A−B], para que pueda resolver la cuestión del equilibrio directamente. Con `--json`, lleva un objeto `comparison` (`pAGreater`, `pEqual`, `pBGreater`, `meanMargin`).

### Lanzamientos deterministas (`--seed`)

`--seed <int>` inicializa el RNG para que un lanzamiento (o una secuencia `--times N` completa) sea reproducible byte por byte; el determinismo que el motor, el puente y el MCP ya tenían, ahora en la CLI. La semilla debe ser un entero finito; una semilla incorrecta genera un error y sale con el código 1. Para pasar una semilla **negativa**, utilice el formato `=` (`--seed=-3`), ya que un valor con un guion inicial separado por espacios es ambiguo para el analizador de argumentos. `--json` hace eco de `seed` para que la salida registre exactamente lo que lo produjo.

```bash
roll 4d6kh3 --seed 42             # same result every time
roll 1d20 --seed 7 --times 5      # a fixed, reproducible sequence of 5 rolls
roll 2d6 --seed 99 --json         # output includes "seed": 99
```

### Color

El color está activado por defecto. Desactívelo de dos maneras:

- `--no-color`: suprime el estilo ANSI para una sola invocación
- `NO_COLOR=1` (variable de entorno): se respeta según el estándar [NO_COLOR](https://no-color.org/)

Cuando el analizador recurre a Monte Carlo para una expresión grande o compleja, `--analyze` y `--at-least` etiquetan el resultado como estimado (con el recuento de muestras) en lugar de presentar los números muestreados como exactos. Los resultados exactos se indican como tales, y siempre que una distribución exacta dependa de los límites finitos del bucle del motor (`MAX_EXPLOSIONS = 100`, `MAX_REROLLS = 100`), la nota indica el/los límite(s) modelado(s) (`exact probabilities (engine caps: ...)`). La salida `--json` lleva `method` (`"exact"` o `"monte-carlo"`), `samples` cuando se muestrea y `caps` (`{ maxExplosions?: 100, maxRerolls?: 100 }`) cuando se aplican los límites del motor.

### Códigos de salida

Roll sigue un contrato deliberado de dos códigos, una promesa de estabilidad en la que los scripts pueden confiar:

| Código | Significado |
|------|---------|
| `0` | Éxito |
| `1` | Cualquier error: expresión incorrecta, fallo de validación, archivo de botín faltante o un límite excedido |

Los errores siempre imprimen una sola línea limpia (código/mensaje/sugerencia) en stderr; la CLI nunca filtra un rastreo de pila.

## Tablas de juego

V2 introduce un sistema universal de tablas de juego para encuentros, golpes críticos, botín, efectos de estado y más.

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

Características: 8 tipos de tablas, selección ponderada, condiciones (comparar, natural, etiqueta, contexto), filtrado por nivel, tablas anidadas, encadenamiento de tablas, expresiones de dados para cantidad/lanzamiento/duración, niveles de rareza, validación con detección de referencias circulares.

## API de la biblioteca

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

### Estabilidad

La **API de alto nivel es estable** y sigue semver: los cambios importantes solo se producen con una actualización de versión principal:

- `roll`, `analyze`
- las API de botín (`rollLootTable`, `validateLootTables`) y las API de tablas de juego (`rollGameTable`)
- la superficie `BridgeHandler` JSON-RPC

**Los componentes internos de bajo nivel del analizador son avanzados y pueden cambiar en versiones secundarias**: utilícelos solo si necesita recorrer el AST usted mismo y fije una versión si depende de ellos:

- `tokenize`, `Token`, `TokenType`
- `runPipeline`, `matchesCompare`

`analyze` también informa `.method` (`"exact"` | `"monte-carlo"`), `.samples` para la ruta muestreada y `.caps` (`{ maxExplosions?: number; maxRerolls?: number }`) en la ruta exacta siempre que se modele un límite de bucle del motor, para que los programas puedan respetar el contrato de probabilidades exactas de forma programática.

### Exactitud, límites del motor y división por cero

- **Qué significa `"exact"` con mayúsculas:** En matemáticas puras, los dados explosivos (`!`, `!!`, `!p`) y las repeticiones ilimitadas (`r`) no tienen un soporte finito. En Roll, `method: "exact"` significa exacto para el motor tal como está construido (`runPipeline`), incluyendo sus límites de bucle (`MAX_EXPLOSIONS = 100` bonificaciones por tirada inicial; `MAX_REROLLS = 100` repeticiones por modificador ilimitado `r`, después de lo cual la tirada número 100 es la definitiva). Siempre que se aplique cualquiera de los límites, `analyze()` lo muestra en `.caps` (`{ maxExplosions: 100 }`, `{ maxRerolls: 100 }`) y la CLI imprime `exact probabilities (engine caps: ...)`. Si el soporte limitado o la convolución superan los `10,000,000` estados, o si cada cara coincide con una repetición ilimitada (`1d6r>=1`), el análisis vuelve a `method: "monte-carlo"`.
- **División por cero (`/`):** `roll()` lanza `ParseError("Division by zero")` siempre que un divisor evaluado sea `0`. `analyze()` rechaza cualquier divisor exacto con $P(\text{divisor} = 0) > 0$ con el mismo `ParseError("Division by zero")`, evaluando y comprobando el divisor *antes* del dividendo para que un dividendo grande (`500d1000/(5d20-5)`) no pueda omitir la comprobación mediante `ExactTooLargeError`. Cuando el divisor *en sí* no se puede calcular exactamente (por ejemplo, `1d6/(5d20!kh4-4)`, donde `5d20!kh4` combina la explosión con mantener/eliminar), `analyze()` vuelve a Monte Carlo (`100,000` pruebas mediante `evaluate()`): si alguna prueba muestreada alcanza `0`, se lanza `ParseError("Division by zero")`; si se omite un resultado cero poco común mediante el muestreo, el resultado se devuelve como `method: "monte-carlo"` (`samples: 100_000`), nunca `"exact"`.

## Puente JSON (Godot / Unreal / Rust)

Roll incluye un puente JSON-RPC 2.0 para la integración con el motor de juego a través de un proceso hijo:

```bash
# Stdio mode (pipe JSON in, get JSON out)
echo '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"4d6kh3","seed":42}}' | roll-bridge

# HTTP mode
roll-bridge --http --port 3947
curl -X POST http://localhost:3947/rpc -d '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"2d6+3"}}'
```

Métodos: `roll`, `roll_batch`, `analyze`, `at_least`, `compare`, `table_roll`, `table_load`, `table_list`, `seed`, `ping`, `shutdown`.

## Servidor MCP

Roll se distribuye como un servidor MCP para la integración con Claude durante el diseño del juego:

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

5 herramientas: `roll_dice`, `analyze_dice`, `compare_dice`, `roll_table`, `query_table`.

## Motor de probabilidad

- **Distribuciones exactas** mediante convolución polinómica para NdM básico
- **Enumeración completa** para mecánicas de mantener/eliminar (4d6 = 1.296 estados)
- **Repetición analítica:** redistribución de masa en forma cerrada sobre las caras que no coinciden, más el residuo del límite `MAX_REROLLS = 100`
- **Mínimo/máximo analítico:** trunca la distribución y acumula masa en el límite
- **Conteo analítico de éxitos:** asigna las caras a +1/0/-1, convoluciona N veces
- **Expansión exacta del límite del motor** para dados explosivos/compuestos/penetrantes hasta `MAX_EXPLOSIONS = 100`
- **Alternativa de Monte Carlo** (100.000 muestras) cuando el cálculo exacto supera los 10 millones de estados o combina explosiones de recuento variable con mantener/eliminar o conteo de éxitos

Cada modificador tiene un análisis de probabilidad exacto, no solo una simulación.

## Seguridad y confianza

Procesa expresiones de dados y nada más. No hay solicitudes de red, no hay escrituras de archivos (excepto que `--loot` lee un archivo JSON), no hay telemetría, no hay secretos. Todas las tiradas de dados utilizan `crypto.randomInt` para la aleatoriedad criptográfica. Las expresiones tienen un límite en el momento del análisis (recuento de dados, caras del dado, longitud) para evitar el agotamiento de recursos, y cualquier texto leído de un archivo `--loot` se elimina de los caracteres de control de terminal antes de mostrarse para que una tabla hostil no pueda inyectar secuencias de escape ANSI en su terminal.

Consulte [SECURITY.md](./SECURITY.md) para conocer la política de notificación de vulnerabilidades.

## Licencia

MIT

---

Creado por <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
