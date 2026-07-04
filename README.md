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

`GEMINI_API_KEY` is optional — if omitted, the tool falls back to word-frequency topic extraction instead of semantic analysis.

**Optional**

| Variable | Default | Description |
|----------|---------|-------------|
| `ANALYZE_CHANNEL_OUTPUT_DIR` | `./output/` | Directory where per-channel JSON analysis artifacts are written |

## Installation

```bash
npm install -g mcp-youtube-intelligence
```

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
channel_url: YouTube channel URL or @handle (e.g. @fireship, youtube.com/@fireship)
max_videos:  Number of recent videos to analyze (default: 5)
```

**Example prompt:** "Analyze the @fireship YouTube channel and tell me what topics they cover most."

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
