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

<p align="center">Universal RPG dice engine — full notation, probability analysis, game tables, and engine integration.</p>

```
npx @mcptoolshop/roll 8d6cs>=5 --analyze
```

## Instalar

```bash
npm install @mcptoolshop/roll
```

Requer Node.js >= 22. Sem dependências de tempo de execução.

## Notação de dados

Roll suporta o padrão completo de notação Roll20/VTT, abrangendo D&D, Mundo das Trevas, Shadowrun, Savage Worlds, Fate e muito mais.

| Notação | Significado |
|----------|---------|
| `2d6` | Lance 2 dados de seis lados |
| `d20+5` | Lance d20, adicione o modificador |
| `4d6kh3` | Lance 4d6, mantenha os 3 mais altos |
| `4d6dl1` | Lance 4d6, descarte o menor 1 |
| `1d6!` | Explosivo (relançar no máximo, adicionar) |
| `1d6!>4` | Explodir em 4 ou superior |
| `1d6!!` | Composição (somar as explosões no mesmo dado) |
| `1d6!p` | Penetrante (as explosões subtraem 1) |
| `2d6r<2` | Relançar valores menores que 2 (ilimitado) |
| `2d6ro=1` | Relançar 1s uma vez |
| `2d6min3` | Limite inferior: nenhum dado abaixo de 3 |
| `2d6max5` | Limite superior: nenhum dado acima de 5 |
| `8d6cs>=5` | Contar sucessos (dados >= 5) |
| `8d6cs>=5cf<=1` | Sucessos menos falhas |
| `1d20cs>19cf<2` | Marcação de sucesso/falha crítica |
| `4d6sa` / `4d6sd` | Ordenar em ordem crescente/decrescente |
| `d%` | Percentil (1-100) |
| `4dF` | Dados Fate/Fudge |
| `(2d6+3)*2` | Aritmética com agrupamento |

## Uso da CLI

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

### Consultas de probabilidade

Além de `--at-least`, quatro flags respondem às perguntas que um designer realmente faz. Cada uma imprime uma linha limpa e respeita a mesma marcação exata/Monte Carlo de `--analyze`:

| Flag | Respostas |
|------|---------|
| `--at-least N` | P(resultado ≥ N) |
| `--at-most N` | P(resultado ≤ N) |
| `--exactly N` | P(resultado = N) |
| `--between L..H` | P(L ≤ resultado ≤ H) — também aceita `L,H` |
| `--target-for P` | O maior alvo T de modo que P(resultado ≥ T) ≥ P ("para acertar 65% das vezes, alvo ≤ T") |

`--compare A B` agora adiciona um veredicto **Versus** no topo dos dois blocos de estatísticas — P(A vence), P(empate), P(B vence) e a margem média E[A−B] — para que você possa resolver a questão do equilíbrio diretamente. Com `--json`, ele carrega um objeto `comparison` (`pAGreater`, `pEqual`, `pBGreater`, `meanMargin`).

### Lançamentos determinísticos (`--seed`)

`--seed <int>` define a semente do RNG para que um lançamento (ou uma sequência inteira `--times N`) seja reproduzível byte a byte — o determinismo que o motor, a ponte e o MCP já tinham, agora na CLI. A semente deve ser um inteiro finito; uma semente ruim gera um erro e sai com código 1. Para passar uma semente **negativa**, use o formato `=` (`--seed=-3`), pois um valor de hífen inicial separado por espaço é ambíguo para o analisador de argumentos. `--json` ecoa a `seed` para que a saída registre exatamente o que a produziu.

```bash
roll 4d6kh3 --seed 42             # same result every time
roll 1d20 --seed 7 --times 5      # a fixed, reproducible sequence of 5 rolls
roll 2d6 --seed 99 --json         # output includes "seed": 99
```

### Cor

A cor está ativada por padrão. Desative-a de duas maneiras:

- `--no-color` — suprime o estilo ANSI para uma única invocação
- `NO_COLOR=1` (variável de ambiente) — respeita o padrão [NO_COLOR](https://no-color.org/)

Quando o analisador recorre ao Monte Carlo para uma expressão grande ou complexa, `--analyze` e `--at-least` rotulam o resultado como estimado (com a contagem de amostras) em vez de apresentar os números amostrados como exatos. Os resultados exatos são indicados como tal. A saída `--json` carrega um campo `method` (`"exact"` ou `"monte-carlo"`, com `samples` quando amostrado), para que os consumidores da máquina também possam diferenciá-los.

### Códigos de saída

Roll segue um contrato deliberado de dois códigos — uma promessa de estabilidade na qual os scripts podem confiar:

| Código | Significado |
|------|---------|
| `0` | Sucesso |
| `1` | Qualquer erro — expressão inválida, falha na validação, arquivo de saque ausente ou limite excedido |

Os erros sempre imprimem uma única linha limpa (código/mensagem/dica) para stderr; a CLI nunca vaza um rastreamento de pilha.

## Tabelas de jogo

A V2 introduz um sistema universal de tabelas de jogo para encontros, sucessos críticos, saques, efeitos de status e muito mais.

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

Recursos: 8 tipos de tabela, seleção ponderada, condições (comparar, nativo, tag, contexto), filtragem de nível, tabelas aninhadas, encadeamento de tabelas, expressões de dados para quantidade/lançamento/duração, níveis de raridade, validação com detecção de referência circular.

## API da biblioteca

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

### Estabilidade

A **API de alto nível é estável** e segue o semver — alterações significativas apenas em um aumento principal:

- `roll`, `analyze`
- as APIs de saque (`rollLootTable`, `validateLootTables`) e as APIs de tabela de jogo (`rollGameTable`)
- a superfície JSON-RPC do `BridgeHandler`

**Os internos do analisador de baixo nível são avançados e podem mudar em versões secundárias** — use-os apenas se precisar percorrer o AST sozinho e fixar uma versão se depender deles:

- `tokenize`, `Token`, `TokenType`
- `runPipeline`, `matchesCompare`

`analyze` também relata `.method` (`"exact"` | `"monte-carlo"`) e, para o caminho amostrado, `.samples` — para que os chamadores possam respeitar o contrato de probabilidades exatas programaticamente.

## Ponte JSON (Godot / Unreal / Rust)

Roll inclui uma ponte JSON-RPC 2.0 para integração com o mecanismo do jogo por meio de um processo filho:

```bash
# Stdio mode (pipe JSON in, get JSON out)
echo '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"4d6kh3","seed":42}}' | roll-bridge

# HTTP mode
roll-bridge --http --port 3947
curl -X POST http://localhost:3947/rpc -d '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"2d6+3"}}'
```

Métodos: `roll`, `roll_batch`, `analyze`, `at_least`, `compare`, `table_roll`, `table_load`, `table_list`, `seed`, `ping`, `shutdown`.

## Servidor MCP

Roll é fornecido como um servidor MCP para integração com o Claude durante o design do jogo:

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

5 ferramentas: `roll_dice`, `analyze_dice`, `compare_dice`, `roll_table`, `query_table`.

## Motor de probabilidade

- **Distribuições exatas** por meio de convolução polinomial para o sistema básico NdM
- **Enumeração completa** para as mecânicas de manter/descartar (4d6 = 1.296 estados)
- **Recálculo analítico** — redistribui a massa de probabilidade sobre faces não correspondentes
- **Valor mínimo/máximo analítico** — trunca a distribuição e acumula a massa no limite
- **Contagem analítica de sucessos** — mapeia as faces para +1/0/-1, realiza a convolução N vezes
- **Recursão truncada** para dados explosivos/acumulativos/penetrantes
- **Alternativa Monte Carlo** (100 mil amostras) quando o cálculo exato ultrapassa 10 milhões de estados

Cada modificador possui uma análise de probabilidade exata — não apenas simulação.

## Segurança e Confiança

Processa expressões de dados e nada mais. Sem solicitações de rede, sem gravações em arquivos (exceto `--loot`, que lê um arquivo JSON), sem telemetria, sem segredos. Todas as rolagens de dados usam `crypto.randomInt` para aleatoriedade criptográfica. As expressões são limitadas no momento da análise (contagem de dados, lados dos dados, comprimento) para evitar o esgotamento de recursos, e qualquer texto lido de um arquivo `--loot` é desprovido de caracteres de controle de terminal antes da exibição, para que uma tabela hostil não possa injetar sequências de escape ANSI no seu terminal.

Consulte [SECURITY.md](./SECURITY.md) para obter a política de notificação de vulnerabilidades.

## Licença

MIT

---

Criado por <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
