# uniswap-tx-builder-mcp

[![CI](https://github.com/Yummybait-fin/uniswap-tx-builder-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Yummybait-fin/uniswap-tx-builder-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40yummybait%2Funiswap-tx-builder-mcp)](https://www.npmjs.com/package/@yummybait/uniswap-tx-builder-mcp)
[![node](https://img.shields.io/node/v/%40yummybait%2Funiswap-tx-builder-mcp)](https://www.npmjs.com/package/@yummybait/uniswap-tx-builder-mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Yummybait-fin/uniswap-tx-builder-mcp/badge)](https://scorecard.dev/viewer/?uri=github.com/Yummybait-fin/uniswap-tx-builder-mcp)

A **keyless** [MCP](https://modelcontextprotocol.io) server that builds *unsigned* Uniswap v3
liquidity-position transactions and optionally simulates them via `eth_call`. **It never holds
keys and never signs** — you take the returned calldata and sign + broadcast it with your own
wallet (viem, a CDP wallet MCP, any signer).

Because it's keyless, the only limits that apply to a built tx are *your wallet's* — the server's
threat surface is just "it returns calldata and reads public RPCs."

## Tools

Every build tool returns `tx = { to, data, value, chainId }` plus `rlp` — the **unsigned
EIP-1559 (type-2)** serialization of `tx` with nonce/fees/gas zeroed (signing services like the
CDP API populate them; serialize `tx` yourself if you manage nonces) — and a human `description`.
`value` is `"0"` except the payable Universal Router wrap/swap builds. Addresses are `0x…40`;
`positionId` and amounts are decimal **strings** (they exceed JS safe integers).

| Tool | Purpose |
|------|---------|
| `build_collect` | Collect all uncollected fees from a position to `recipient`. |
| `build_close` | Remove all liquidity **+** collect; `burn: true` also burns the empty NFT. Returns the read position. |
| `build_mint` | Mint a new position (raw ticks + wei amounts). |
| `build_increase` | Add liquidity to an existing position. |
| `build_wrap` | Wrap native ETH → WETH via the Universal Router (`WRAP_ETH`). |
| `build_swap` | Exact-in WETH → token swap via the Universal Router; with `wrapWei` it wraps native ETH first and sweeps the WETH remainder in the same tx. |
| `plan_position` | **Read-only.** Turn a human price range + human amounts into aligned ticks + wei amounts for `build_mint`. Reads token decimals over RPC. |
| `get_pool_state` | **Read-only.** Live pool state (tick, sqrtPriceX96, human price, spacing); optional ±pct range suggestion (rounded inward) and live-ratio `amount0Desired`/`amount1Desired` from wallet balances. |

`simulate` runs an opt-in `eth_call` dry-run: **on by default** for collect/close, **off** for
mint/increase (those need approvals + balances, so the dry-run usually reverts); wrap/swap
simulate when you pass `sender` (the signing wallet). A reverted simulation comes back as an
error — don't sign a tx that failed to simulate. See the companion skill for the full argument
reference and position lifecycle.

## Install & run

From npm (no clone, stdio transport — what MCP clients spawn):

```bash
npx -y @yummybait/uniswap-tx-builder-mcp
```

From source:

```bash
npm install
npm run dev                 # stdio MCP from source via tsx
npm run build && npm start  # compile to dist/, then run the built server
npm test                    # vitest
```

Set `MCP_HTTP_PORT` to serve the streamable-HTTP transport instead of stdio (endpoint:
`http://<host>:<port>/mcp`). HTTP runs **stateless** — every POST gets a fresh server/transport
pair, so any number of clients can connect and reconnect freely with no session bookkeeping:

```bash
MCP_HTTP_PORT=8102 npm run dev
```

Docker — build locally, or pull a released image from GHCR:

```bash
docker build -t uniswap-tx-builder-mcp:local .                        # local build
docker pull ghcr.io/yummybait-fin/uniswap-tx-builder-mcp:latest       # released image

docker run -i --rm uniswap-tx-builder-mcp:local                       # stdio
docker run --rm -p 8102:8102 -e MCP_HTTP_PORT=8102 uniswap-tx-builder-mcp:local  # HTTP
```

## Connect to an MCP client

**Claude Code** (stdio via npm):

```bash
claude mcp add uniswap-tx-builder -- npx -y @yummybait/uniswap-tx-builder-mcp
```

**Generic client config** (Claude Desktop, etc.) — add to the client's `mcpServers`:

```json
{
  "mcpServers": {
    "uniswap-tx-builder": {
      "command": "npx",
      "args": ["-y", "@yummybait/uniswap-tx-builder-mcp"],
      "env": { "RPC_ETH": "https://your-eth-rpc" }
    }
  }
}
```

(For a local build, swap the command for `node /abs/path/to/uniswap-tx-builder-mcp/dist/mcp.js`.)

For HTTP, run the server with `MCP_HTTP_PORT` and point the client at `http://<host>:<port>/mcp`.

## Install the companion skill

`skills/uniswap-tx-builder/` is a generic agent **skill** (no app- or wallet-specific knowledge)
that teaches an agent how to drive these tools: the argument reference, simulate-first, the
close→mint rebalance sequence, and the "your wallet signs" handoff. It pairs with the MCP — install
both. Pick whichever install path suits you.

**A. Claude Code plugin (`/plugin`)** — the repo doubles as a plugin marketplace:

```text
/plugin marketplace add Yummybait-fin/uniswap-tx-builder-mcp
/plugin install uniswap-tx-builder@yummybait
```

**B. npx** — copies the skill into a skills dir (no clone needed):

```bash
# personal (~/.claude/skills, every project)
npx -p @yummybait/uniswap-tx-builder-mcp uniswap-tx-builder-skill

# or project-scoped (./.claude/skills, checked in with a repo)
npx -p @yummybait/uniswap-tx-builder-mcp uniswap-tx-builder-skill --project
```

**C. Manual copy** — straight from a checkout:

```bash
cp -r skills/uniswap-tx-builder ~/.claude/skills/                       # personal
mkdir -p .claude/skills && cp -r skills/uniswap-tx-builder .claude/skills/  # project
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
builder.ts     calldata + unsigned-RLP encoding (viem), position/pool reads
ticks.ts       pure tick / sqrt-price / liquidity math (no I/O)
operations.ts  build + optional eth_call simulate + response shaping
mcp.ts         the MCP transport (stdio / stateless streamable HTTP)
```

## CI / releases

GitHub Actions (`.github/workflows/`):

- **CI** — typecheck + tests + npm-tarball allowlist check on every push to `main` and on PRs.
- **Release** — pushing a `v*` tag re-runs the tests, bumps the version on `main` to match the tag
  (`package.json` + `.claude-plugin/plugin.json`), publishes the npm package
  (`@yummybait/uniswap-tx-builder-mcp`) **with provenance**, and builds + publishes the Docker
  image to GHCR (`ghcr.io/yummybait-fin/uniswap-tx-builder-mcp`), tagged with the version (and
  `latest`). The tag is the single version source for both artifacts; the bump lands on `main`
  after the tag, so the tagged commit keeps its old version.

```bash
git tag v0.3.0 && git push origin v0.3.0   # cut a release
```

### npm supply-chain posture

The npm publish job is locked down; keep these properties when touching it:

- **Trusted publishing (OIDC)** — no long-lived npm token in CI. Configured on npmjs.com under
  *package → Settings → Trusted publisher* (GitHub Actions, this repo, `release.yml`). The
  `NPM_TOKEN` secret path in the workflow exists **only to bootstrap the first release** (trusted
  publishers can't be configured before the package exists) — delete the secret afterwards and
  set the package's publishing access to *"Require two-factor authentication and disallow
  tokens"*.
- **Provenance** — `publishConfig.provenance: true` attaches a Sigstore attestation linking every
  published tarball to the exact workflow run and commit. It also makes an accidental local
  `npm publish` fail (no OIDC outside CI). Consumers verify with `npm audit signatures`.
- **Gates before publish** — `npm audit signatures` (registry attestations of the dep tree),
  `npm audit --omit=dev --audit-level=high` (no known high/critical vulns in shipped deps),
  typecheck + full test suite (`prepublishOnly`), and `scripts/verify-tarball.mjs` (the tarball
  must contain exactly the allowlisted files — no secrets, no strays).
- **Hardened job** — `npm ci --ignore-scripts` (no dependency postinstall runs where publish
  credentials live), minimal per-job permissions, actions pinned to commit SHAs, Dependabot
  keeping pins and deps fresh.

## Scope

Uniswap v3 `NonfungiblePositionManager` on the chains above. Calling an unconfigured chain returns
an "Unsupported chain" error. Roadmap: Uniswap v4 as a separate set of tools alongside these.
