import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

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

const server = new McpServer({ name: "uniswap-tx-builder", version: "0.3.0" });

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

server.registerTool(
  "build_collect",
  {
    title: "Build a collect-fees transaction",
    description:
      "Build an UNSIGNED tx that collects all uncollected fees from a Uniswap v3 " +
      "position to `recipient`. Returns {to,data,value,chainId}. Set simulate=false " +
      "to skip the eth_call dry-run (on by default).",
    inputSchema: {
      chainId: z.number().int(),
      positionId: uintStringSchema,
      recipient: addressSchema,
      simulate: z.boolean().optional(),
    },
  },
  async ({ chainId, positionId, recipient, simulate }) => {
    try {
      return ok(
        await collectOp({
          chainId,
          positionId: BigInt(positionId),
          recipient: recipient as Address,
          simulate,
        }),
      );
    } catch (err) {
      return fail(`build_collect failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.registerTool(
  "build_close",
  {
    title: "Build a close-position transaction",
    description:
      "Build an UNSIGNED tx that removes all liquidity and collects everything from a " +
      "Uniswap v3 position (multicalls when needed). Returns the tx plus the read " +
      "position. Set burn=true to also burn the now-empty NFT in the same multicall. " +
      "Set simulate=false to skip the eth_call dry-run (on by default).",
    inputSchema: {
      chainId: z.number().int(),
      positionId: uintStringSchema,
      recipient: addressSchema,
      burn: z.boolean().optional(),
      simulate: z.boolean().optional(),
    },
  },
  async ({ chainId, positionId, recipient, burn, simulate }) => {
    try {
      return ok(
        await closeOp({
          chainId,
          positionId: BigInt(positionId),
          recipient: recipient as Address,
          burn,
          simulate,
        }),
      );
    } catch (err) {
      return fail(`build_close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.registerTool(
  "build_mint",
  {
    title: "Build a mint-position transaction",
    description:
      "Build an UNSIGNED tx that mints a new Uniswap v3 position. Amounts are decimal " +
      "strings (wei). Simulation is OFF by default here (minting needs token approvals " +
      "and balances, so eth_call usually reverts); pass simulate=true to attempt it.",
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
  async (args) => {
    try {
      return ok(
        await mintOp({
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
      );
    } catch (err) {
      return fail(`build_mint failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.registerTool(
  "build_increase",
  {
    title: "Build an increase-liquidity transaction",
    description:
      "Build an UNSIGNED tx that adds liquidity to an EXISTING Uniswap v3 position. " +
      "Amounts are decimal strings (wei); mins are derived from slippageBps (default 0.5%). " +
      "Simulation is OFF by default (needs token approvals + balances); pass simulate=true " +
      "to attempt it.",
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
  async (args) => {
    try {
      return ok(
        await increaseOp({
          chainId: args.chainId,
          positionId: BigInt(args.positionId),
          amount0Desired: BigInt(args.amount0Desired),
          amount1Desired: BigInt(args.amount1Desired),
          recipient: args.recipient as Address,
          slippageBps: args.slippageBps,
          simulate: args.simulate,
        }),
      );
    } catch (err) {
      return fail(`build_increase failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
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
  async (args) => {
    try {
      return ok(
        await planOp({
          chainId: args.chainId,
          token0: args.token0 as Address,
          token1: args.token1 as Address,
          fee: args.fee,
          priceLower: args.priceLower,
          priceUpper: args.priceUpper,
          amount0: args.amount0,
          amount1: args.amount1,
        }),
      );
    } catch (err) {
      return fail(`plan_position failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// Transport: HTTP (streamable) when MCP_HTTP_PORT is set — for running as a
// docker-compose service a local agent connects to — otherwise stdio.
const httpPort = process.env.MCP_HTTP_PORT;
if (httpPort) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  createServer((req, res) => {
    void transport.handleRequest(req, res);
  }).listen(Number(httpPort), "0.0.0.0", () => {
    process.stderr.write(`[uniswap-tx-builder] streamable HTTP on :${httpPort}/mcp\n`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
