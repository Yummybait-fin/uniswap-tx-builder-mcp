# Security

Found a vulnerability? Report it privately via
[GitHub private vulnerability reporting](https://github.com/Yummybait-fin/uniswap-tx-builder-mcp/security/advisories/new)
or email <mykhail@broscorp.net> — please don't open a public issue. I'll get
back to you within 3 days or so and coordinate a fix and disclosure with you.

Only the latest release on npm gets fixes.

## What counts

This server is keyless by design — it never holds keys, never signs, never
broadcasts. It builds unsigned calldata and reads public RPC state. So the
interesting bugs are:

- calldata that does something other than what the inputs and returned
  `description` say (wrong recipient, wrong contract, wrong amounts, hidden
  approvals);
- a wrong hard-coded contract address for any supported chain;
- a simulation that reports success for a tx that would fail (or lie) on chain;
- issues in the HTTP transport (`MCP_HTTP_PORT` mode);
- a vulnerable or malicious dependency in the published npm package.

Not bugs: anything requiring a malicious RPC (the RPC URL is caller-supplied
and trusted), signing/key management (this server does none), slippage/MEV on
valid transactions, or vulnerabilities in the Uniswap contracts themselves —
report those to [Uniswap](https://github.com/Uniswap/v3-core/blob/main/bug-bounty.md).
