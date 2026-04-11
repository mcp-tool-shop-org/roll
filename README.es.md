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

## Instalación

```bash
npm install @mcptoolshop/roll
```

Requiere Node.js >= 22.

## Uso de la línea de comandos

### Lanzar dados

```bash
roll 2d6+3
roll d20+5
roll 4d6kh3
roll 1d6!
roll d%
roll 4dF
roll "(2d6+3)*2"
```

### Analizar probabilidad

```bash
roll 2d6 --analyze          # Full distribution + statistics
roll d20+5 --at-least 15    # P(result >= 15)
```

### Comparar distribuciones

```bash
roll --compare "4d6dl1" "3d6"
```

Estadísticas comparativas (media, mediana, moda, desviación estándar, rango, entropía) con columna de diferencias, además de ambos histogramas.

### Tablas de botín

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

Características: selección ponderada, referencias a tablas anidadas, expresiones de dados para cantidad y valor.

### Otras opciones

```bash
roll 2d6+3 --times 5       # Roll 5 times
roll 2d6+3 --json           # Machine-readable output
roll --help                 # Full usage
roll --version              # Version
```

## Notación de dados

| Notación | Significado |
|----------|---------|
| `2d6` | Lanzar 2 dados de seis caras |
| `d20` | Lanzar 1 dado de veinte caras |
| `4d6kh3` | Lanzar 4d6, conservar los 3 más altos |
| `4d6dl1` | Lanzar 4d6, descartar el más bajo |
| `1d6!` | Dado explosivo (relanzar en el máximo, sumar) |
| `1d6!>4` | Explosión al obtener 4 o más |
| `d%` | Dado de percentil (1-100) |
| `4dF` | Dados de Fate/Fudge (-1, 0, +1 cada uno) |
| `(2d6+3)*2` | Aritmética con agrupación |
| `2d6+1d4+3` | Expresiones encadenadas |

## API de la biblioteca

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

## Motor de probabilidad

- **Distribuciones exactas** mediante convolución polinómica para NdM básicos.
- **Enumeración completa** para mecánicas de conservación/descarte (4d6 = 1296 estados).
- **Recursión truncada** para dados explosivos (limitado a 10 explosiones).
- **Método de Monte Carlo** (100.000 muestras) cuando el cálculo exacto supera los 10 millones de estados.

## Sin dependencias externas

Construido completamente con funciones integradas de Node.js 22+:
- `util.styleText` para colores en la terminal.
- `util.parseArgs` para el análisis de argumentos de la línea de comandos.
- `crypto.randomInt` para generación de números aleatorios criptográficamente seguros para el lanzamiento de dados.

## Seguridad y Confianza

`@mcptoolshop/roll` procesa expresiones de dados y nada más. No realiza solicitudes de red, no escribe archivos y no recopila datos. El único acceso al sistema de archivos es a través de la opción `--loot`, que lee un único archivo JSON especificado por el usuario.

No hay telemetría, ni análisis, ni seguimiento de ningún tipo. No se utilizan secretos, tokens ni credenciales en ninguna operación.

Todos los lanzamientos de dados utilizan `crypto.randomInt` del módulo `crypto` de Node.js, proporcionando aleatoriedad criptográficamente segura adecuada para obtener resultados justos.

Consulte [SECURITY.md](./SECURITY.md) para obtener la política de informes de vulnerabilidades.

## Licencia

MIT

---

Desarrollado por <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
