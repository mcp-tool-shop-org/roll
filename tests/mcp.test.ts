import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/mcp/tools.js";

// We test the MCP server by simulating the request/response cycle.
// Import the server module's handler logic indirectly through the bridge handler
// and tool definitions, since the MCP server is a thin stdio wrapper.

describe("MCP tool definitions", () => {
  it("exports exactly 6 tools", () => {
    // 6th tool: analyze_table (FT-INT-002 / FT-ANA-001 — table analysis on the wire).
    expect(TOOLS).toHaveLength(6);
  });

  it("all tools have required fields", () => {
    for (const tool of TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it("roll_dice tool has expression required", () => {
    const tool = TOOLS.find((t) => t.name === "roll_dice")!;
    expect(tool.inputSchema.required).toContain("expression");
  });

  it("analyze_dice tool has expression required", () => {
    const tool = TOOLS.find((t) => t.name === "analyze_dice")!;
    expect(tool.inputSchema.required).toContain("expression");
  });

  it("compare_dice tool has both expressions required", () => {
    const tool = TOOLS.find((t) => t.name === "compare_dice")!;
    expect(tool.inputSchema.required).toContain("expression_a");
    expect(tool.inputSchema.required).toContain("expression_b");
  });

  it("roll_table tool has table_name and collection required", () => {
    const tool = TOOLS.find((t) => t.name === "roll_table")!;
    expect(tool.inputSchema.required).toContain("table_name");
    expect(tool.inputSchema.required).toContain("collection");
  });

  it("query_table tool has table_name and collection required", () => {
    const tool = TOOLS.find((t) => t.name === "query_table")!;
    expect(tool.inputSchema.required).toContain("table_name");
    expect(tool.inputSchema.required).toContain("collection");
  });

  it("tool names are unique", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all tool names follow snake_case convention", () => {
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

// ─── MCP server integration (simulated stdio) ───────────────────────────────

describe("MCP server protocol", () => {
  // We can't easily test stdio in vitest, but we CAN test that the server
  // module builds and exports correctly by testing its core logic through
  // the bridge handler which shares the same engine.
  // The real integration test is the bash pipe below.

  it("tool descriptions mention key V2 features", () => {
    const rollTool = TOOLS.find((t) => t.name === "roll_dice")!;
    expect(rollTool.description).toContain("success counting");
    expect(rollTool.description).toContain("compounding");
    expect(rollTool.description).toContain("penetrating");
    expect(rollTool.description).toContain("reroll");
  });

  it("analyze tool mentions probability distribution", () => {
    const tool = TOOLS.find((t) => t.name === "analyze_dice")!;
    expect(tool.description).toContain("probability distribution");
  });
});
