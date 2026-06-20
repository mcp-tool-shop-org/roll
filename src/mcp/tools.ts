/** MCP tool definitions for the Roll dice engine. */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOLS: McpToolDefinition[] = [
  {
    name: "roll_dice",
    description:
      "Roll a dice expression using full RPG notation. Supports: NdM, keep/drop (kh/kl/dh/dl), exploding (!), compounding (!!), penetrating (!p), reroll (r/ro), min/max, success counting (cs>=N), failure counting (cf<=N), sorting (sa/sd). Returns individual die results and total.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Dice expression (e.g., '4d6kh3+5', '8d6cs>=5', '2d6r<2!!')",
        },
        times: {
          type: "number",
          description: "Number of times to roll (default: 1)",
        },
        seed: {
          type: "number",
          description: "Optional seed for deterministic results",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "analyze_dice",
    description:
      "Compute the probability distribution and statistics for a dice expression. Returns mean, median, mode, std dev, percentiles, entropy, the full distribution, and a `method` field (\"exact\" for a closed-form result, or \"monte-carlo\" with a `samples` count when the expression is too complex for exact analysis and was sampled). Optionally computes P(result >= target).",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Dice expression to analyze",
        },
        at_least: {
          type: "number",
          description: "Optional target — returns P(result >= target)",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "compare_dice",
    description:
      "Compare two dice expressions side by side. Returns statistics for both including mean, median, mode, std dev, range, and entropy.",
    inputSchema: {
      type: "object",
      properties: {
        expression_a: {
          type: "string",
          description: "First dice expression",
        },
        expression_b: {
          type: "string",
          description: "Second dice expression",
        },
      },
      required: ["expression_a", "expression_b"],
    },
  },
  {
    name: "roll_table",
    description:
      "Roll on a game table (loot, encounter, critical, fumble, reward, status, event). Supports weighted selection, conditions, level filtering, nested tables, chains, and dice expressions for quantity/roll/duration.",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Name of the table to roll on",
        },
        collection: {
          type: "object",
          description: "GameTableCollection JSON with version and tables array",
        },
        context: {
          type: "object",
          description: "Optional context: {level?, tags?, variables?, triggerRoll?, triggerNat?}",
        },
        count: {
          type: "number",
          description: "Number of rolls (default: 1)",
        },
      },
      required: ["table_name", "collection"],
    },
  },
  {
    name: "query_table",
    description:
      "Inspect a game table definition. Returns the table's entries, conditions, and metadata without rolling.",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Name of the table to inspect",
        },
        collection: {
          type: "object",
          description: "GameTableCollection JSON",
        },
      },
      required: ["table_name", "collection"],
    },
  },
];
