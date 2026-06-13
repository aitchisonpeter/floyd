#!/usr/bin/env node
// Floyd MCP server — exposes your Floyd store to Claude (or any MCP client) as
// three tools. Runs locally over stdio. The write token stays in this process's
// environment, never sent to the model.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readContext, queryLog, appendEntries } from "./floyd.js";

const server = new McpServer({ name: "floyd", version: "0.1.0" });

const asText = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const asError = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] });

server.registerTool(
  "floyd_read_context",
  {
    title: "Read Floyd context",
    description:
      "Read the assembled Floyd context packet: current state, open tasks, recent log, " +
      "config, calendar, partner state, and more. Optionally pass `sections` to return " +
      "only specific top-level keys (e.g. ['current_state','tasks','calendar']) to keep it small.",
    inputSchema: {
      sections: z
        .array(z.string())
        .optional()
        .describe("Top-level sections to return. Omit for the full packet."),
    },
  },
  async ({ sections }) => {
    try {
      return asText(await readContext(sections));
    } catch (e) {
      return asError(e);
    }
  }
);

server.registerTool(
  "floyd_query_log",
  {
    title: "Query Floyd log",
    description:
      "Return recent PERSONAL_LOG entries, optionally filtered by person and/or tag " +
      "(e.g. tag '#mood', person 'peter'). Searches the most recent ~50 entries.",
    inputSchema: {
      person: z.string().optional().describe("Filter by person id, e.g. 'peter' or 'esther'."),
      tag: z.string().optional().describe("Filter by exact tag, e.g. '#mood', '#note'."),
      limit: z.number().int().positive().max(50).optional().describe("Max entries (default 50)."),
    },
  },
  async ({ person, tag, limit }) => {
    try {
      return asText(await queryLog({ person, tag, limit }));
    } catch (e) {
      return asError(e);
    }
  }
);

server.registerTool(
  "floyd_append_entries",
  {
    title: "Append Floyd entries",
    description:
      "Write one or more atomic entries to PERSONAL_LOG. This MODIFIES the live store — " +
      "confirm intent with the user before calling. The backend fills in timestamp/id/days_alive " +
      "and applies retention rules. Each entry needs at least a tag and value.",
    inputSchema: {
      entries: z
        .array(
          z.object({
            tag: z.string().describe("Floyd tag, e.g. '#mood', '#note', '#idea', '#health'."),
            value: z.string().describe("The entry value, e.g. '7/10 calm'."),
            person: z.string().optional().describe("Defaults to the owner id."),
            notes: z.string().optional(),
            confidence: z.number().min(0).max(1).optional(),
          })
        )
        .min(1)
        .describe("Atomic entries to append."),
    },
  },
  async ({ entries }) => {
    try {
      return asText(await appendEntries(entries));
    } catch (e) {
      return asError(e);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("floyd-mcp: connected over stdio");
