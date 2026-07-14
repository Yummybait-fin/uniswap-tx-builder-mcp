#!/usr/bin/env node
/**
 * Transport entry point: connects the server from `server.ts` over stdio, or
 * streamable HTTP when MCP_HTTP_PORT is set. Kept free of tool logic — this
 * file boots transports and nothing else.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildServer, log, version } from "./server.js";

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string) {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// One-glance label for a JSON-RPC payload, e.g. "initialize#1 (claude-code 2.1)"
// or "tools/call#3" or "notifications/initialized".
function describeRpc(body: unknown): string {
  const messages = Array.isArray(body) ? body : [body];
  return messages
    .map((msg) => {
      if (!msg || typeof msg !== "object") return "invalid";
      const { method, id, params } = msg as {
        method?: string;
        id?: unknown;
        params?: { clientInfo?: { name?: string; version?: string } };
      };
      if (!method) return `response#${String(id)}`;
      let label = id === undefined ? method : `${method}#${String(id)}`;
      if (method === "initialize" && params?.clientInfo?.name) {
        label += ` (${params.clientInfo.name} ${params.clientInfo.version ?? "?"})`;
      }
      return label;
    })
    .join(",");
}

// Transport: HTTP (streamable) when MCP_HTTP_PORT is set — for running as a
// docker-compose service a local agent connects to — otherwise stdio.
//
// HTTP runs in STATELESS mode: every tool here is pure request/response, so
// each POST gets its own server + transport (sessionIdGenerator: undefined —
// no Mcp-Session-Id issued or required). Any number of clients can connect,
// and a client vanishing mid-session can't wedge the server. GET (standalone
// SSE) and DELETE (session teardown) only make sense with sessions → 405.
const httpPort = process.env.MCP_HTTP_PORT;
if (httpPort) {
  createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        jsonRpcError(res, 405, -32000, "Method Not Allowed: stateless server accepts POST only");
        log(`HTTP 405 ${req.method} ${req.url}`);
        return;
      }
      let rpcBody: unknown;
      try {
        rpcBody = JSON.parse(await readBody(req));
      } catch {
        jsonRpcError(res, 400, -32700, "Parse error: request body is not valid JSON");
        log("HTTP 400 POST — body is not valid JSON");
        return;
      }
      const rpc = describeRpc(rpcBody);
      const started = Date.now();
      res.on("finish", () => log(`HTTP ${res.statusCode} ${rpc} ${Date.now() - started}ms`));

      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, rpcBody);
      } catch (err) {
        log(`HTTP request failed (${rpc}): ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          jsonRpcError(res, 500, -32603, "Internal server error");
        }
      }
    })();
  }).listen(Number(httpPort), "0.0.0.0", () => {
    log(`v${version} — streamable HTTP (stateless) listening on :${httpPort}/mcp`);
  });
} else {
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  log(`v${version} — stdio transport connected`);
}
