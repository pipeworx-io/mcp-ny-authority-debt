# ny-authority-debt

New York public authority debt issuance — which authority borrowed, for what
project, on what terms, and when. Sourced from the four Authorities Budget
Office datasets New York publishes on data.ny.gov. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

| Tool | Answers |
|---|---|
| `ny_authority_debt_search` | Which New York bonds were issued — by authority, project, size, date or tax status? |
| `ny_authority_debt_profile` | Everything one authority has issued, with totals by year and new-money vs refunding. |
| `ny_authority_debt_totals` | Aggregate borrowing by year and authority class; the largest issuers. |
| `ny_authority_debt_coverage` | What is covered, how far back, and explicitly what is not here. |

## Coverage

Four authority classes, ~4,470 reported rows:

| Class | Dataset | Rows |
|---|---|---|
| State Authority | [83xh-6x8i](https://data.ny.gov/d/83xh-6x8i) | 1,617 |
| Local Authority | [qbd7-9grw](https://data.ny.gov/d/qbd7-9grw) | 814 |
| Industrial Development Agency | [cci8-aavx](https://data.ny.gov/d/cci8-aavx) | 632 |
| Local Development Corporation | [sh2f-cc7d](https://data.ny.gov/d/sh2f-cc7d) | 1,410 |

Each row is one authority's report for one fiscal year. Rows where
`issued_debt_obligations` is `N` mean *this authority issued nothing that
year* — the tools filter to `Y` so an authority's quiet year never looks like
an issue with blank fields.

## What this is not

- **No secondary-market trade prices.** This is primary issuance: what was
  sold and on what terms. Beyond that, most municipal bonds trade infrequently
  enough to have no current market price at all — what vendors sell as a muni
  "price" is usually an *evaluated* price, an estimate rather than a trade. A
  caller who assumes otherwise will read absence as "no trades happened".
- **No CUSIPs.** See below.
- **New York only.** California is covered by `ca-debtwatch`. For identifying
  one individual bond anywhere, use `openfigi_search` with
  `marketSecDes: "Muni"`.

## Two constraints that shaped the code

**CUSIP is dropped deliberately.** The State Authorities dataset carries a
`cusip_number` column, populated on 1,295 rows with real 9-character CUSIPs.
CUSIP identifiers are licensed by CUSIP Global Services, and that licence —
not copyright in the underlying facts — is the binding constraint. The column
is stripped before anything is returned, there is no CUSIP filter, and nothing
is stored. Key on the issuer name here, and on FIGI via `openfigi` for an
individual bond. Do not add it back.

**EMMA is linked, never fetched.** MSRB's terms are a contract accepted by
using EMMA and they forbid building a database from their content. The
`official_statement_url` this pack returns is a link New York itself published
— often to a PDF hosted on emma.msrb.org, sometimes to the authority's own
site — and it is passed straight through without being requested or parsed.
`emma_search_url` is a composed search link, named for what it honestly is:
the path returns 200, but the page is script-driven and we deliberately do not
parse it, so it may not pre-fill the search.

## Data sources

- New York State Open Data — <https://data.ny.gov> (Authorities Budget Office
  debt-issuance reporting)

### Gotcha: Socrata catalog search federates across states

Querying another state's Socrata catalog (e.g. `data.texas.gov`) returns these
same dataset ids, because the catalog API federates. Texas does not publish
them. Always check `metadata.domain` on a catalog hit before attributing a
dataset to a state — verified 2026-09-01 that all four report
`domain: data.ny.gov`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ny-authority-debt": {
      "url": "https://gateway.pipeworx.io/ny-authority-debt/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ny-authority-debt/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ny-authority-debt": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ny-authority-debt"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ny-authority-debt
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ny Authority Debt data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
