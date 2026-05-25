#!/usr/bin/env node

/**
 * MCP YouTube Intelligence — MCP server for extracting structured intelligence
 * from YouTube channels and videos.
 *
 * Tools:
 *   analyze_channel  — Extract transcripts, topics, and competitive signals from a channel
 */

import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../package.json") as { version: string };

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`mcp-youtube-intelligence v${packageVersion} — MCP server for YouTube channel intelligence

Usage:
  mcp-youtube-intelligence [options]

Options:
  --help, -h   Show this help message

Tools provided:
  analyze_channel   Extract transcripts, topics, and competitive signals from a YouTube channel`);
  process.exit(0);
}

const server = new McpServer({
  name: "mcp-youtube-intelligence",
  version: packageVersion,
});

server.tool(
  "analyze_channel",
  "Extract structured intelligence from a YouTube channel — transcripts, topics, competitive signals",
  {
    channel_url: z.string().describe("YouTube channel URL or @handle"),
    max_videos: z.number().optional().default(10).describe("Maximum number of recent videos to analyze"),
  },
  async ({ channel_url, max_videos }) => {
    // TODO Sprint #3 Day 2+: implement YouTube transcript extraction via Apify actor
    // TODO Sprint #3 Day 3+: implement LLM-based topic + competitive signal analysis
    return {
      content: [
        {
          type: "text" as const,
          text: `[mcp-youtube-intelligence v${packageVersion}] analyze_channel stub\nchannel_url: ${channel_url}\nmax_videos: ${max_videos}\n\nNot yet implemented — Day 1 scaffold.`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
