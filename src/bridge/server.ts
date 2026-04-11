#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { BridgeHandler } from "./handler.js";

const handler = new BridgeHandler();

// ─── Stdio transport ─────────────────────────────────────────────────────────

function runStdio(): void {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const response = handler.handleRaw(trimmed);

    // Check for shutdown
    if (response.result && typeof response.result === "object" && "shutdown" in response.result) {
      process.stdout.write(JSON.stringify(response) + "\n");
      process.exit(0);
    }

    process.stdout.write(JSON.stringify(response) + "\n");
  });

  rl.on("close", () => process.exit(0));
}

// ─── HTTP transport ──────────────────────────────────────────────────────────

function runHttp(port: number): void {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "POST /rpc only" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const response = handler.handleRaw(body);

      if (response.result && typeof response.result === "object" && "shutdown" in response.result) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        server.close();
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });

  server.listen(port, () => {
    process.stderr.write(`Roll bridge listening on http://localhost:${port}/rpc\n`);
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function main(): void {
  const { values } = parseArgs({
    options: {
      stdio: { type: "boolean", default: false },
      http: { type: "boolean", default: false },
      port: { type: "string", default: "3947" },
    },
    strict: false,
  });

  if (values.http) {
    runHttp(parseInt(values.port as string, 10));
  } else {
    // Default to stdio
    runStdio();
  }
}

main();
