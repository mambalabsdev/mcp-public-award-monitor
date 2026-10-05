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

// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoint carries a platform
// ceiling of 300 seconds on the HTTP wait and answers 408 past it while the run
// keeps going and keeps billing. Starting the run, polling it to a terminal
// status, and then reading the dataset waits as long as the actor needs.
//
// How long the actor run itself may take, in seconds: long enough for a large
// batch, short enough that a hung run cannot bill indefinitely.
const ACTOR_RUN_TIMEOUT_SECS = 1800;
// How long this wrapper waits: the run's own timeout plus two minutes, so the
// run's TIMED-OUT status is what the caller sees.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = Number(process.env.MAMBA_POLL_INTERVAL_MS ?? 3000);
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success.
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset. Pass actor output through unchanged: the wrapper never
  // reinterprets a status field.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message ? `${asObj.error.message}` : JSON.stringify(items);
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
