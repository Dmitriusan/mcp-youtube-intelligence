# mcp-youtube-intelligence

MCP server for extracting structured intelligence from YouTube channels and videos.

## What it does

Analyzes YouTube channels to produce structured intelligence reports:
- Transcript extraction across recent videos
- Topic frequency and trend analysis
- Competitive signal detection (product mentions, competitor references)
- Content positioning analysis

## Installation

```bash
npm install -g mcp-youtube-intelligence
```

## Usage

Add to your Claude Desktop / MCP client config:

```json
{
  "mcpServers": {
    "youtube-intelligence": {
      "command": "mcp-youtube-intelligence"
    }
  }
}
```

### Tools

**`analyze_channel`** — Extract intelligence from a YouTube channel

```
channel_url: YouTube channel URL or @handle
max_videos:  Number of recent videos to analyze (default: 10)
```

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
