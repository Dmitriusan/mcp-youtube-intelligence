# mcp-youtube-intelligence

MCP server for extracting structured intelligence from YouTube channels and videos.

## What it does

Analyzes YouTube channels to produce structured intelligence reports:
- Transcript extraction across recent videos (up to 50 videos)
- Semantic topic extraction per video via Gemini (theme, named entities, tags)
- Keyword frequency analysis across all transcripts (fallback when Gemini is unavailable)

## Prerequisites

You need API keys for three services:

| Variable | Where to get it |
|----------|----------------|
| `YOUTUBE_API_KEY` | [Google Cloud Console](https://console.cloud.google.com/) → YouTube Data API v3 |
| `APIFY_TOKEN` | [Apify Console](https://console.apify.com/) → Account → Integrations → API token |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/) → Get API key |

`GEMINI_API_KEY` is optional — if omitted, the tool falls back to word-frequency topic extraction instead of semantic analysis. The same fallback applies when a configured Gemini call fails (invalid key, exhausted quota, blocked content); the result's `note` says why.

**Optional**

| Variable | Default | Description |
|----------|---------|-------------|
| `ANALYZE_CHANNEL_OUTPUT_DIR` | `./output/` | Directory where per-channel JSON analysis artifacts are written. The default is relative to the server's working directory, which your MCP client chooses (some start servers in `/`, where the write is denied). Set an absolute path to be sure: when the write fails the analysis still succeeds, but the result has no `output_path` and the reason goes only to stderr |

## Installation

```bash
npm install -g mcp-youtube-intelligence
```

## CLI flags

```bash
mcp-youtube-intelligence --version   # or -v — print the installed version and exit
mcp-youtube-intelligence --help      # or -h — print usage and exit
```

Running the command with no flags starts the MCP server itself (stdio transport) — this is what
an MCP client config invokes; it's not meant to be run bare in a terminal for interactive use.

## Usage

Add to your Claude Desktop / MCP client config:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "youtube-intelligence": {
      "command": "mcp-youtube-intelligence",
      "env": {
        "YOUTUBE_API_KEY": "your-youtube-api-key",
        "APIFY_TOKEN": "your-apify-token",
        "GEMINI_API_KEY": "your-gemini-api-key"
      }
    }
  }
}
```

### Tools

**`analyze_channel`** — Extract intelligence from a YouTube channel

```
channel_url: YouTube channel URL or @handle. Accepts:
               - @handle (e.g. @fireship; handles in any script work, e.g. @фокусхплаза)
               - full URL with handle (e.g. youtube.com/@fireship; a percent-encoded
                 non-ASCII handle copied from a browser address bar is decoded)
               - /channel/UC... URL
               - bare 24-character UC... channel ID
               - legacy /c/name or /user/name URL
max_videos:  Number of recent videos to analyze (default: 5, max: 50)
```

Returns a JSON object:

| Field | Meaning |
|-------|---------|
| `channel_id`, `channel_title` | The resolved channel |
| `channel_url` | Your `channel_url` input, echoed back |
| `sample_video_ids` | The most recent uploads that were analyzed |
| `videos_analyzed` | How many videos were fetched from the channel's uploads playlist |
| `transcripts_available` | How many of those came back with caption content |
| `topics` | Up to 20 top keywords by frequency across all transcripts. Always computed. Counts plain English words only: a word with an accented or non-Latin letter is skipped, so a transcript in another language gives few or no keywords here (`topics_structured` still works for it when Gemini is configured) |
| `topics_structured` | Per video: `theme`, `entities[]`, `tags[]` from Gemini. Empty when Gemini is not configured or fails. Only the first 1,000 words of each transcript are sent, and a video Gemini blocks or returns nothing usable for is left out. After 3 videos in a row that Gemini never answers or keeps refusing (timeout, connection failure, 429 or 5xx after one retry) the remaining videos are not sent, so a rate-limited key or an unreachable Gemini costs seconds, not minutes |
| `note` | Which analysis mode ran. When Gemini was configured but failed, or when none of the videos returned a transcript (so there was nothing to analyze), it also says why. When Gemini answered for some transcripts but not others, it says how many are missing from `topics_structured` and the most recent cause |
| `output_path` | Where the JSON artifact was written. Absent if the write failed |

**Example prompt:** "Analyze the @fireship YouTube channel and tell me what topics they cover most."

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
