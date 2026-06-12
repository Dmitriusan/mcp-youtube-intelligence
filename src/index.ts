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
import { analyzeChannel } from "./analyze_channel.js";

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
  "Extract structured intelligence from a YouTube channel. Returns: channel metadata, sampled video IDs, word-frequency topics (topics), per-video structured topics (topics_structured) with theme/entities/tags from Gemini semantic analysis, and a note field indicating whether semantic or keyword-only analysis was used. Supported channel inputs: @handle (e.g. @fireship), youtube.com/@handle URL, /channel/UC... URL, bare UC... channel ID (24 chars), or legacy youtube.com/c/ and youtube.com/user/ URLs.",
  {
    channel_url: z.string().describe("YouTube channel URL or @handle (e.g. @fireship, https://www.youtube.com/@fireship, UCxxxxxxx)"),
    max_videos: z.number().optional().default(5).describe("Number of recent videos to analyze (default 5, max 50)"),
  },
  async ({ channel_url, max_videos }) => {
    try {
      const result = await analyzeChannel(channel_url, max_videos);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `Error analyzing channel "${channel_url}": ${message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
