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

server.registerTool(
  "analyze_channel",
  {
    title: "Analyze YouTube Channel",
    description: "Analyze a YouTube channel and return a JSON object with: channel_id, channel_title, channel_url, sample_video_ids[], videos_analyzed (count of videos fetched from playlist), transcripts_available (count with actual caption content), topics[] (top keyword frequencies across all transcripts), topics_structured[] (per-video semantic analysis — each entry has video_id/theme/entities[]/tags[]), note (which analysis mode ran), and optional output_path (local artifact path). Requires YOUTUBE_API_KEY and APIFY_TOKEN; set GEMINI_API_KEY for topics_structured semantic analysis (falls back to keyword-only when absent). Supported channel inputs: @handle (e.g. @fireship), youtube.com/@handle URL, /channel/UC... URL, bare 24-char UCxxxxxx ID, or legacy /c/ and /user/ URLs.",
    inputSchema: {
      channel_url: z.string().describe("YouTube channel URL or @handle (e.g. @fireship, https://www.youtube.com/@fireship, UCxxxxxxx)"),
      max_videos: z.number().int().min(1).max(50).optional().default(5).describe("Number of recent videos to analyze (default 5, max 50)"),
    },
    annotations: {
      // Writes a local JSON artifact as a side effect, so not strictly read-only —
      // but that write is purely additive (a new timestamped file) and every run
      // hits live, rate-limited external APIs, so results are not idempotent.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
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
