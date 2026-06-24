# uniswap-tx-builder-mcp

A **keyless** [MCP](https://modelcontextprotocol.io) server that builds *unsigned* Uniswap v3
liquidity-position transactions and optionally simulates them via `eth_call`. **It never holds
keys and never signs** — you take the returned calldata and sign + broadcast it with your own
wallet (viem, a CDP wallet MCP, any signer).

Because it's keyless, the only limits that apply to a built tx are *your wallet's* — the server's
threat surface is just "it returns calldata and reads public RPCs."

## Tools

Every build tool returns `tx = { to, data, value, chainId }` (`value` is always `"0"`) plus a
human `description`. Addresses are `0x…40`; `positionId` and amounts are decimal **strings** (they
exceed JS safe integers).

| Tool | Purpose |
|------|---------|
| `build_collect` | Collect all uncollected fees from a position to `recipient`. |
| `build_close` | Remove all liquidity **+** collect; `burn: true` also burns the empty NFT. Returns the read position. |
| `build_mint` | Mint a new position (raw ticks + wei amounts). |
| `build_increase` | Add liquidity to an existing position. |
| `plan_position` | **Read-only.** Turn a human price range + human amounts into aligned ticks + wei amounts for `build_mint`. Reads token decimals over RPC. |

`simulate` runs an opt-in `eth_call` dry-run: **on by default** for collect/close, **off** for
mint/increase (those need approvals + balances, so the dry-run usually reverts). A reverted
simulation comes back as an error — don't sign a tx that failed to simulate. See the companion
skill for the full argument reference and position lifecycle.

## Install & run

```bash
npm install
npm run dev                 # stdio MCP from source via tsx
npm run build && npm start  # compile to dist/, then run the built server
npm test                    # vitest
```

Set `MCP_HTTP_PORT` to serve the streamable-HTTP transport instead of stdio (endpoint:
`http://<host>:<port>/mcp`):

```bash
MCP_HTTP_PORT=8102 npm run dev
```

Docker:

```bash
docker build -t uniswap-tx-builder-mcp:local .
docker run -i --rm uniswap-tx-builder-mcp:local                       # stdio
docker run --rm -p 8102:8102 -e MCP_HTTP_PORT=8102 uniswap-tx-builder-mcp:local  # HTTP
```

## Connect to an MCP client

**Claude Code** (stdio, from a local build):

```bash
npm run build
claude mcp add uniswap-tx-builder -- node /abs/path/to/uniswap-tx-builder-mcp/dist/mcp.js
```

**Generic client config** (Claude Desktop, etc.) — add to the client's `mcpServers`:

```json
{
  "mcpServers": {
    "uniswap-tx-builder": {
      "command": "node",
      "args": ["/abs/path/to/uniswap-tx-builder-mcp/dist/mcp.js"],
      "env": { "RPC_ETH": "https://your-eth-rpc" }
    }
  }
}
```

For HTTP, run the server with `MCP_HTTP_PORT` and point the client at `http://<host>:<port>/mcp`.

## Install the companion skill

`skill/uniswap-tx-builder/` is a generic agent **skill** (no app- or wallet-specific knowledge)
that teaches an agent how to drive these tools: the argument reference, simulate-first, the
close→mint rebalance sequence, and the "your wallet signs" handoff. It pairs with the MCP — install
both.

For **Claude Code**, copy the skill folder into a skills directory:

```bash
# personal (available in every project)
cp -r skill/uniswap-tx-builder ~/.claude/skills/

# or project-scoped (checked in with a repo)
mkdir -p .claude/skills && cp -r skill/uniswap-tx-builder .claude/skills/
```

The agent picks it up by its `SKILL.md` frontmatter — no restart needed for project skills.

## Configuration

Per-chain RPCs default to public endpoints; override with env vars (see `src/config.ts`):

| Chain | ID | RPC env var |
|-------|----|-------------|
| Ethereum | 1 | `RPC_ETH` |
| Optimism | 10 | `RPC_OP` |
| Polygon | 137 | `RPC_POLYGON` |
| Base | 8453 | `RPC_BASE` |
| Arbitrum | 42161 | `RPC_ARB` |

Public RPCs are rate-limited and best-effort — set your own for anything beyond casual use.

## Architecture

One code path, transport kept separate so it stays testable and ready for a future v4 tool set:

```
builder.ts     calldata encoding (viem) + position reads
ticks.ts       pure price ↔ tick math (no I/O)
operations.ts  build + optional eth_call simulate + response shaping
mcp.ts         the MCP transport (stdio / streamable HTTP)
```

## Scope

Uniswap v3 `NonfungiblePositionManager` on the chains above. Calling an unconfigured chain returns
an "Unsupported chain" error. Roadmap: Uniswap v4 as a separate set of tools alongside these.
