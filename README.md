# Government Contract Award Monitor MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-public-award-monitor)](https://smithery.ai/servers/mambabuilt/mcp-public-award-monitor) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-public-award-monitor/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-public-award-monitor) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-public-award-monitor%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-public-award-monitor&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-public-award-monitor)](https://www.npmjs.com/package/@mambalabsdev/mcp-public-award-monitor) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-public-award-monitor)](https://www.npmjs.com/package/@mambalabsdev/mcp-public-award-monitor) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-public-award-monitor)](https://github.com/mambalabsdev/mcp-public-award-monitor/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-public-award-monitor)

MCP server for the Mamba Labs [Government Contract Award Monitor](https://apify.com/mambalabs/public-award-monitor) actor on Apify.

Pick a register and a time window. It returns the companies that won public work in that window, one flat row per winning company, with award count, total value, awarding body, award date, and a resolved company domain.

## Install

```bash
npx -y @mambalabsdev/mcp-public-award-monitor
```

### Claude Desktop

```json
{
  "mcpServers": {
    "mamba-public-award-monitor": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-public-award-monitor"],
      "env": { "APIFY_TOKEN": "your-apify-token" }
    }
  }
}
```

Get an Apify token at [console.apify.com/account/integrations](https://console.apify.com/account/integrations).

## Tool

### `monitor_public_awards`

Register and window in, the companies that won public work out.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `register` | enum | yes | Which award register to read. `us_federal_contracts` and `us_federal_grants` from USASpending, `us_nih_sbir` from NIH RePORTER, `uk_contracts_finder` and `uk_find_a_tender` from the UK registers. Default `us_federal_contracts`. |
| `window_days` | string | no | How many days back from today to read awards for, 1 to 90. US federal data lags about two days, so do not use a one day window on the US registers. Default `7`. |
| `min_award_value` | string | no | Drops awards below this amount in the register's own currency. Set to 0 to keep everything. Default `100000`. |
| `max_entities` | string | no | Hard cap on billed rows, 1 to 1000. Winners are sorted by total award value, and the run log says how many were dropped. Default `100`. |
| `exclude_government_recipients` | boolean | no | Drops winners that are themselves government, universities, or public authorities. Leave this on for the grant registers or you get state departments of education instead of companies. Default `true`. |
| `resolve_domains` | boolean | no | Looks up each winner's website. Turning it off makes the run roughly 20x faster and returns `recipient_domain` as null with `domain_status` `not_attempted`. Default `true`. |
| `domain_confidence_floor` | enum | no | `strict`, `standard` or `loose`. Strict returns fewer domains and almost no wrong ones. Loose returns the most domains and about a third of them are wrong. Default `standard`. |

## Reading the output

One row per winning company, not one per award. `total_award_value`, `largest_award_value` and `award_count_in_window` size the opportunity. `recipient_register_id` is the UEI in the US and the Companies House number in the UK, which is what you match against a CRM. `latest_award_url` is the deep link to the source record.

## Billing

You are charged per winning company returned, plus a small actor start fee. `max_entities` is therefore a hard cost cap.

Pricing is on the [actor's Apify page](https://apify.com/mambalabs/public-award-monitor). Running this server consumes Apify credits.

## What this server does and does not do

It is a thin client for the Apify actor. It passes your input through and returns the actor's output unchanged. Every behavior described above lives in the actor, not here.

This is not a tender feed and not a procurement pipeline tool. It does not tell you what is open to bid on. It reports awards that have already been made and names the company that won.

Errors are surfaced, never swallowed. An invalid input, an invalid token, an exhausted balance, a timeout, or a run that returns anything other than a dataset all come back as an explicit tool error rather than as an empty result.

## Source

The actor is on the [Apify Store](https://apify.com/mambalabs/public-award-monitor). This wrapper is [MIT licensed](LICENSE).

Built by [Mamba Labs](https://apify.com/mambalabs)
