#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }

    let message: string;
    switch (response.status) {
      case 400:
        message = `The ${actorLabel} run was rejected as invalid input.${detail}`;
        break;
      case 401:
        message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
        break;
      case 402:
        message =
          "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
        break;
      case 408:
        message = `The ${actorLabel} run timed out after 300 seconds. Ask for less per call, or run the actor on Apify directly for larger jobs.`;
        break;
      default:
        message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  // A 2xx from run-sync-get-dataset-items normally carries the dataset array.
  // Anything else on this path is a failure the caller must see, never an empty
  // success: surfacing it here is what keeps a failed run from reading as "no
  // results found".
  let items: unknown;
  try {
    items = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-public-award-monitor",
  version: pkg.version,
});

// Government Contract Award Monitor (immutable actor ID zhEtllASykOcx9hJ8)
server.registerTool(
  "monitor_public_awards",
  {
    title: "Monitor Public Awards",
    description:
      "Pick a public award register and a time window and it returns the companies that won public work in it, one flat row per winning company rather than one per award, with award count, total value, largest award, awarding body, award date, a deep link to the source record, and a resolved company domain. Five registers are covered: US federal contracts and US federal grants from USASpending, NIH SBIR and STTR from NIH RePORTER, and UK Contracts Finder and UK Find a Tender. This reports awards that have already been made, so it is not a tender feed and will not tell you what is open to bid on. US federal data lags about two days, so a one day window on a US register returns little or nothing. Winners are sorted by total award value and max_entities is the hard cap on billed rows. Requires an APIFY_TOKEN and consumes Apify credits. Read only.",
    annotations: {
      title: "Monitor Public Awards",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    register: z.enum(["us_federal_contracts", "us_federal_grants", "us_nih_sbir", "uk_contracts_finder", "uk_find_a_tender"]).describe("Which award register to read. US federal contracts and grants come from USASpending, NIH SBIR and STTR from NIH RePORTER, and the two UK registers from Contracts Finder and Find a Tender. Default: \"us_federal_contracts\"."),
    window_days: z.string().optional().describe("How many days back from today to read awards for. 1 to 90. US federal data lags about two days, so do not use a one day window on the US registers. Sent as a string so it works from Clay. Default: \"7\"."),
    min_award_value: z.string().optional().describe("Drops awards below this amount in the register's own currency. Set to 0 to keep everything. Sent as a string so it works from Clay. Default: \"100000\"."),
    max_entities: z.string().optional().describe("Hard cap on billed rows. 1 to 1000. Winners are sorted by total award value, and the run log says how many were dropped. Sent as a string so it works from Clay. Default: \"100\"."),
    exclude_government_recipients: z.boolean().optional().describe("Drops winners that are themselves government, universities, or public authorities. Leave this on for the grant registers or you get state departments of education instead of companies. Default: true."),
    resolve_domains: z.boolean().optional().describe("Looks up each winner's website. Turning it off makes the run roughly 20x faster and returns recipient_domain as null with domain_status not_attempted. Default: true."),
    domain_confidence_floor: z.enum(["strict", "standard", "loose"]).optional().describe("How sure the actor has to be before it gives you a domain. Strict returns fewer domains and almost no wrong ones. Loose returns the most domains and about a third of them are wrong. Default: \"standard\"."),
    },
  },
  async (args) =>
    runActor("zhEtllASykOcx9hJ8", "Government Contract Award Monitor", compact(args as Record<string, unknown>)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
