/**
 * Pure argv → output-text mapping for the --version/--help flags, split out of
 * index.ts so it can be unit tested without importing index.ts itself — that
 * module connects a stdio MCP transport as a top-level side effect on import,
 * which would hang a test runner.
 */

const HELP_TEXT = (version: string): string => `mcp-youtube-intelligence v${version} — MCP server for YouTube channel intelligence

Usage:
  mcp-youtube-intelligence [options]

Options:
  --help, -h      Show this help message
  --version, -v   Print the installed version

Tools provided:
  analyze_channel   Extract transcripts, topics, and competitive signals from a YouTube channel`;

/**
 * Returns the text to print for --version/-v or --help/-h, or null if argv
 * contains neither (the normal MCP-server-startup path). --version/-v takes
 * precedence when both are present.
 */
export function getCliOutput(argv: readonly string[], version: string): string | null {
  if (argv.includes("--version") || argv.includes("-v")) return version;
  if (argv.includes("--help") || argv.includes("-h")) return HELP_TEXT(version);
  return null;
}
