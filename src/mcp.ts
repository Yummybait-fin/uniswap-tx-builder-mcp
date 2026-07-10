import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Address } from "viem";
import { z } from "zod";

import {
  closeOp,
  collectOp,
  increaseOp,
  mintOp,
  planOp,
  poolStateOp,
  swapOp,
  wrapOp,
} from "./operations.js";

// uniswap-tx-builder-mcp — a PUBLIC, KEYLESS MCP server.
//
// It builds *unsigned* Uniswap v3 position transactions (collect / close /
// mint) and, optionally, simulates them via eth_call. It never holds keys and
// never signs or broadcasts — signing is the caller's wallet's job. Simulation
// is opt-in to let a caller prove a tx would succeed before signing, which
// boosts trust without taking custody.

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x EVM address");
// uint256 token ids / amounts exceed JS safe integers → accept decimal strings.
const uintStringSchema = z.string().regex(/^\d+$/, "must be a decimal integer string");

// Single-source the version from package.json (resolves from src/ in dev and
// dist/ once built — package.json sits one level up in both layouts).
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

// All logging goes to stderr: in stdio mode stdout carries the MCP protocol.
function log(msg: string) {
  process.stderr.write(`${new Date().toISOString()} [uniswap-tx-builder] ${msg}\n`);
}

// JSON for log lines: long hex blobs (calldata) collapse to a prefix + byte
// count so the readable parts of a result (to, value, description, position)
// aren't drowned out; anything still oversized is hard-capped.
function loggable(data: unknown, max = 1200): string {
  const json = JSON.stringify(data, (_key, value) =>
    typeof value === "string" && value.length > 80 && /^0x[0-9a-fA-F]+$/.test(value)
      ? `${value.slice(0, 18)}…(${(value.length - 2) / 2} bytes)`
      : value,
  );
  return json.length <= max ? json : `${json.slice(0, max)}…(+${json.length - max} chars)`;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// Shared tool-call wrapper: logs the call with its args, the outcome with
// duration, and converts thrown errors into MCP tool errors.
async function run(name: string, args: unknown, fn: () => Promise<unknown>) {
  const started = Date.now();
  log(`→ ${name} ${loggable(args)}`);
  try {
    const data = await fn();
    log(`← ${name} ok ${Date.now() - started}ms ${loggable(data)}`);
    return ok(data);
  } catch (err) {
    const message = `${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    log(`← ${name} ERROR ${Date.now() - started}ms ${message}`);
    return fail(message);
  }
}

// A factory rather than a singleton: an SDK server/transport pair is 1:1 with
// a session, so the HTTP mode below builds a fresh instance per request.
function buildServer(): McpServer {
  const server = new McpServer({ name: "uniswap-tx-builder", version });

  server.registerTool(
    "build_collect",
    {
      title: "Build a collect-fees transaction",
      description:
        "Build an UNSIGNED tx that collects all uncollected fees from a Uniswap v3 " +
        "position to `recipient`. Returns tx={to,data,value,chainId} plus rlp (the " +
        "unsigned EIP-1559 serialization for signing services). Set simulate=false " +
        "to skip the eth_call dry-run (on by default).",
      inputSchema: {
        chainId: z.number().int(),
        positionId: uintStringSchema,
        recipient: addressSchema,
        simulate: z.boolean().optional(),
      },
    },
    async (args) =>
      run("build_collect", args, () =>
        collectOp({
          chainId: args.chainId,
          positionId: BigInt(args.positionId),
          recipient: args.recipient as Address,
          simulate: args.simulate,
        }),
      ),
  );

  server.registerTool(
    "build_close",
    {
      title: "Build a close-position transaction",
      description:
        "Build an UNSIGNED tx that removes all liquidity and collects everything from a " +
        "Uniswap v3 position (multicalls when needed). Returns the tx (+ unsigned rlp) " +
        "plus the read position. Set burn=true to also burn the now-empty NFT in the " +
        "same multicall. Set simulate=false to skip the eth_call dry-run (on by default).",
      inputSchema: {
        chainId: z.number().int(),
        positionId: uintStringSchema,
        recipient: addressSchema,
        burn: z.boolean().optional(),
        simulate: z.boolean().optional(),
      },
    },
    async (args) =>
      run("build_close", args, () =>
        closeOp({
          chainId: args.chainId,
          positionId: BigInt(args.positionId),
          recipient: args.recipient as Address,
          burn: args.burn,
          simulate: args.simulate,
        }),
      ),
  );

  server.registerTool(
    "build_mint",
    {
      title: "Build a mint-position transaction",
      description:
        "Build an UNSIGNED tx that mints a new Uniswap v3 position. Amounts are decimal " +
        "strings (wei) — compute them with get_pool_state (live ratio) right before " +
        "minting, or stale prices revert the mint. Returns the tx plus unsigned rlp. " +
        "Simulation is OFF by default here (minting needs token approvals and balances, " +
        "so eth_call usually reverts); pass simulate=true to attempt it.",
      inputSchema: {
        chainId: z.number().int(),
        token0: addressSchema,
        token1: addressSchema,
        fee: z.number().int(),
        tickLower: z.number().int(),
        tickUpper: z.number().int(),
        amount0Desired: uintStringSchema,
        amount1Desired: uintStringSchema,
        recipient: addressSchema,
        slippageBps: z.number().int().optional(),
        simulate: z.boolean().optional(),
      },
    },
    async (args) =>
      run("build_mint", args, () =>
        mintOp({
          chainId: args.chainId,
          token0: args.token0 as Address,
          token1: args.token1 as Address,
          fee: args.fee,
          tickLower: args.tickLower,
          tickUpper: args.tickUpper,
          amount0Desired: BigInt(args.amount0Desired),
          amount1Desired: BigInt(args.amount1Desired),
          recipient: args.recipient as Address,
          slippageBps: args.slippageBps,
          simulate: args.simulate,
        }),
      ),
  );

  server.registerTool(
    "build_increase",
    {
      title: "Build an increase-liquidity transaction",
      description:
        "Build an UNSIGNED tx that adds liquidity to an EXISTING Uniswap v3 position. " +
        "Amounts are decimal strings (wei); mins are derived from slippageBps (default 0.5%). " +
        "Returns the tx plus unsigned rlp. Simulation is OFF by default (needs token " +
        "approvals + balances); pass simulate=true to attempt it.",
      inputSchema: {
        chainId: z.number().int(),
        positionId: uintStringSchema,
        amount0Desired: uintStringSchema,
        amount1Desired: uintStringSchema,
        recipient: addressSchema,
        slippageBps: z.number().int().optional(),
        simulate: z.boolean().optional(),
      },
    },
    async (args) =>
      run("build_increase", args, () =>
        increaseOp({
          chainId: args.chainId,
          positionId: BigInt(args.positionId),
          amount0Desired: BigInt(args.amount0Desired),
          amount1Desired: BigInt(args.amount1Desired),
          recipient: args.recipient as Address,
          slippageBps: args.slippageBps,
          simulate: args.simulate,
        }),
      ),
  );

  server.registerTool(
    "plan_position",
    {
      title: "Plan a position from a human price range",
      description:
        "READ-ONLY helper (builds no tx). Given a human price range (token1 per token0) and " +
        "optional human token amounts, reads each token's decimals over RPC and returns the " +
        "aligned tickLower/tickUpper (for the fee's tick spacing) plus wei amount0Desired/" +
        "amount1Desired — ready to feed into build_mint. token0 must be < token1 by address. " +
        "Does NOT compute the optimal amount ratio for the range.",
      inputSchema: {
        chainId: z.number().int(),
        token0: addressSchema,
        token1: addressSchema,
        fee: z.number().int(),
        priceLower: z.number().positive(),
        priceUpper: z.number().positive(),
        amount0: z.string().optional(),
        amount1: z.string().optional(),
      },
    },
    async (args) =>
      run("plan_position", args, () =>
        planOp({
          chainId: args.chainId,
          token0: args.token0 as Address,
          token1: args.token1 as Address,
          fee: args.fee,
          priceLower: args.priceLower,
          priceUpper: args.priceUpper,
          amount0: args.amount0,
          amount1: args.amount1,
        }),
      ),
  );

  server.registerTool(
    "get_pool_state",
    {
      title: "Read live pool state; plan a range and mint amounts from it",
      description:
        "READ-ONLY (builds no tx). Returns the pool's LIVE state: pool address, tick, " +
        "sqrtPriceX96, price (token1 per token0, human units), tickSpacing. " +
        "With rangePct: suggested tickLower/tickUpper within ±pct of spot, rounded INWARD " +
        "to tick spacing. With balance0+balance1 (raw wei) + tickLower/tickUpper: " +
        "amount0Desired/amount1Desired for build_mint computed from the live sqrtPrice " +
        "ratio, plus which side limits. Errors if spot is outside the range. ALWAYS " +
        "recompute amounts with this right before build_mint — stale ratios revert with " +
        "'Price slippage check'.",
      inputSchema: {
        chainId: z.number().int(),
        token0: addressSchema,
        token1: addressSchema,
        fee: z.number().int(),
        rangePct: z.number().positive().optional(),
        tickLower: z.number().int().optional(),
        tickUpper: z.number().int().optional(),
        balance0: uintStringSchema.optional(),
        balance1: uintStringSchema.optional(),
      },
    },
    async (args) =>
      run("get_pool_state", args, () =>
        poolStateOp({
          chainId: args.chainId,
          token0: args.token0 as Address,
          token1: args.token1 as Address,
          fee: args.fee,
          rangePct: args.rangePct,
          tickLower: args.tickLower,
          tickUpper: args.tickUpper,
          balance0: args.balance0 === undefined ? undefined : BigInt(args.balance0),
          balance1: args.balance1 === undefined ? undefined : BigInt(args.balance1),
        }),
      ),
  );

  server.registerTool(
    "build_wrap",
    {
      title: "Build a wrap-native-ETH transaction (Universal Router)",
      description:
        "Build an UNSIGNED payable tx that wraps `amountWei` native ETH into WETH via the " +
        "Universal Router WRAP_ETH command (works under UR-allowlisting wallet policies " +
        "where a direct WETH.deposit() doesn't). `recipient` defaults to the tx sender — " +
        "omit it unless the WETH should go elsewhere. Returns the tx plus unsigned rlp. " +
        "Pass `sender` (the signing wallet) to eth_call-simulate before signing.",
      inputSchema: {
        chainId: z.number().int(),
        amountWei: uintStringSchema,
        recipient: addressSchema.optional(),
        sender: addressSchema.optional(),
        deadline: z.number().int().positive().optional(),
        simulate: z.boolean().optional(),
      },
    },
    async (args) =>
      run("build_wrap", args, () =>
        wrapOp({
          chainId: args.chainId,
          amountWei: BigInt(args.amountWei),
          recipient: args.recipient as Address | undefined,
          sender: args.sender as Address | undefined,
          deadline: args.deadline,
          simulate: args.simulate,
        }),
      ),
  );

  server.registerTool(
    "build_swap",
    {
      title: "Build a WETH→token swap transaction (Universal Router)",
      description:
        "Build an UNSIGNED tx that swaps `amountInWei` WETH for `tokenOut` (exact-in, " +
        "single hop through the `fee` pool) via the Universal Router. With `wrapWei` " +
        "(≥ amountInWei) the tx is payable and wraps that much native ETH first, swaps " +
        "amountInWei of it, and sweeps the WETH remainder — use this when the wallet " +
        "holds native ETH. Without wrapWei the wallet's WETH pays via Permit2 (needs a " +
        "Permit2 approval). `recipient` defaults to the tx sender. Returns the tx plus " +
        "unsigned rlp. Pass `sender` to eth_call-simulate before signing.",
      inputSchema: {
        chainId: z.number().int(),
        amountInWei: uintStringSchema,
        tokenOut: addressSchema,
        fee: z.number().int(),
        amountOutMin: uintStringSchema,
        recipient: addressSchema.optional(),
        wrapWei: uintStringSchema.optional(),
        sender: addressSchema.optional(),
        deadline: z.number().int().positive().optional(),
        simulate: z.boolean().optional(),
      },
    },
    async (args) =>
      run("build_swap", args, () =>
        swapOp({
          chainId: args.chainId,
          amountInWei: BigInt(args.amountInWei),
          tokenOut: args.tokenOut as Address,
          fee: args.fee,
          amountOutMin: BigInt(args.amountOutMin),
          recipient: args.recipient as Address | undefined,
          wrapWei: args.wrapWei === undefined ? undefined : BigInt(args.wrapWei),
          sender: args.sender as Address | undefined,
          deadline: args.deadline,
          simulate: args.simulate,
        }),
      ),
  );

  return server;
}

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
