/**
 * analyze_channel — Day 2 implementation.
 *
 * Channel resolution: YouTube Data API v3 (forHandle / by channel ID)
 * Transcript fetch: Apify supreme_coder/youtube-transcript-scraper (vKlQCAJRI72MdyK1u)
 *   — same actor used by IrrationalCorp Scout/R&D signal pipeline
 * Topic extraction: word frequency (Day 3 adds LLM semantic layer)
 */

import { readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APIFY_BASE = "https://api.apify.com/v2";
// supreme_coder/youtube-transcript-scraper — same actor as scripts/yt-captions/apify_download.py
export const TRANSCRIPT_ACTOR_ID = "vKlQCAJRI72MdyK1u";
const YT_API_BASE = "https://www.googleapis.com/youtube/v3";
// Corp secrets path — MCP server runs on the same host as IrrationalCorp repo
const CORP_SECRETS_DIR = "/media/development/irrationals/IrrationalCorp/secrets";

const APIFY_POLL_INTERVAL_MS = 15_000;
const APIFY_MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChannelResolution {
  channelId: string;
  uploadsPlaylistId: string;
  title: string;
}

export interface AnalyzeChannelResult {
  channel_id: string;
  channel_title: string;
  channel_url: string;
  sample_video_ids: string[];
  videos_analyzed: number;
  transcripts_available: number;
  topics: string[];
  note: string;
}

export interface ParsedChannel {
  type: "handle" | "channel_id" | "custom_url";
  value: string;
}

// ---------------------------------------------------------------------------
// Secret loader
// ---------------------------------------------------------------------------

function loadEnvKey(filename: string, key: string): string | undefined {
  try {
    const content = readFileSync(join(CORP_SECRETS_DIR, filename), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eqIdx = trimmed.indexOf("=");
      const k = trimmed.slice(0, eqIdx).trim();
      if (k === key) return trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // File not found or unreadable — caller throws descriptive error
  }
  return undefined;
}

export function getApifyToken(): string {
  const token = process.env["APIFY_TOKEN"] ?? loadEnvKey("apify.env", "APIFY_TOKEN");
  if (!token) throw new Error("APIFY_TOKEN not configured. Set env var APIFY_TOKEN or ensure secrets/apify.env exists.");
  return token;
}

export function getYouTubeApiKey(): string {
  const key = process.env["YOUTUBE_API_KEY"] ?? loadEnvKey("google-cloud.env", "GOOGLE_CLOUD_API_KEY");
  if (!key) throw new Error("YOUTUBE_API_KEY not configured. Set env var YOUTUBE_API_KEY or ensure secrets/google-cloud.env exists.");
  return key;
}

// ---------------------------------------------------------------------------
// Channel URL / handle parser
// ---------------------------------------------------------------------------

export function parseChannelInput(input: string): ParsedChannel {
  const trimmed = input.trim();

  // Bare @handle — e.g. @fireship
  if (/^@[\w-]+$/.test(trimmed)) return { type: "handle", value: trimmed };

  // Full URL with @handle — youtube.com/@fireship or youtube.com/@fireship/videos
  const handleFromUrl = trimmed.match(/youtube\.com\/@([\w-]+)/);
  if (handleFromUrl) return { type: "handle", value: `@${handleFromUrl[1]}` };

  // /channel/UC... URL
  const channelIdFromUrl = trimmed.match(/\/channel\/(UC[\w-]{22})/);
  if (channelIdFromUrl) return { type: "channel_id", value: channelIdFromUrl[1] };

  // Bare UC... channel ID (24 chars: "UC" + 22)
  if (/^UC[\w-]{22}$/.test(trimmed)) return { type: "channel_id", value: trimmed };

  // Legacy /c/name or /user/name URL
  const customFromUrl = trimmed.match(/youtube\.com\/(?:c|user)\/([\w-]+)/);
  if (customFromUrl) return { type: "custom_url", value: customFromUrl[1] };

  throw new Error(
    `Cannot parse YouTube channel from: "${input}". ` +
    `Use @handle, youtube.com/@handle URL, or UC... channel ID.`
  );
}

// ---------------------------------------------------------------------------
// YouTube Data API helpers
// ---------------------------------------------------------------------------

interface YtApiResponse {
  items?: Array<Record<string, unknown>>;
  error?: { message: string };
}

export async function resolveChannel(input: string, apiKey: string): Promise<ChannelResolution> {
  const parsed = parseChannelInput(input);
  let apiUrl: string;

  if (parsed.type === "handle") {
    apiUrl = `${YT_API_BASE}/channels?part=id,contentDetails,snippet&forHandle=${encodeURIComponent(parsed.value)}&key=${apiKey}`;
  } else if (parsed.type === "channel_id") {
    apiUrl = `${YT_API_BASE}/channels?part=id,contentDetails,snippet&id=${encodeURIComponent(parsed.value)}&key=${apiKey}`;
  } else {
    // custom_url — fall back to search (costs 100 quota units); rare path
    const searchUrl = `${YT_API_BASE}/search?part=snippet&type=channel&q=${encodeURIComponent(parsed.value)}&maxResults=1&key=${apiKey}`;
    const searchResp = await fetch(searchUrl);
    if (!searchResp.ok) throw new Error(`YouTube search API error ${searchResp.status}`);
    const searchData = await searchResp.json() as YtApiResponse;
    const items = searchData.items ?? [];
    if (!items.length) throw new Error(`Channel not found for custom URL: ${input}`);
    const channelId = ((items[0]["id"] as Record<string, string>)["channelId"]) as string;
    return resolveChannel(channelId, apiKey);
  }

  const resp = await fetch(apiUrl);
  if (!resp.ok) throw new Error(`YouTube channels API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as YtApiResponse;

  if (data.error) throw new Error(`YouTube API: ${data.error.message}`);
  const items = data.items ?? [];
  if (!items.length) throw new Error(`Channel not found: ${input}`);

  const item = items[0];
  const snippet = item["snippet"] as Record<string, string>;
  const contentDetails = item["contentDetails"] as { relatedPlaylists: Record<string, string> };

  return {
    channelId: item["id"] as string,
    uploadsPlaylistId: contentDetails.relatedPlaylists["uploads"],
    title: snippet["title"],
  };
}

export async function getRecentVideoIds(
  uploadsPlaylistId: string,
  maxResults: number,
  apiKey: string,
): Promise<string[]> {
  const apiUrl =
    `${YT_API_BASE}/playlistItems?part=contentDetails` +
    `&playlistId=${encodeURIComponent(uploadsPlaylistId)}` +
    `&maxResults=${maxResults}` +
    `&key=${apiKey}`;
  const resp = await fetch(apiUrl);
  if (!resp.ok) throw new Error(`YouTube playlistItems API error ${resp.status}`);
  const data = await resp.json() as YtApiResponse;
  const items = (data.items ?? []) as Array<{ contentDetails: { videoId: string } }>;
  return items.map((item) => item.contentDetails.videoId).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Apify transcript scraper
// ---------------------------------------------------------------------------

interface ApifyRunData {
  id: string;
  defaultDatasetId: string;
  status: string;
}

export async function runApifyTranscriptScraper(
  videoUrls: string[],
  token: string,
): Promise<unknown[]> {
  // Start actor run — 1GB memory is enough for a few videos
  const runResp = await fetch(
    `${APIFY_BASE}/acts/${TRANSCRIPT_ACTOR_ID}/runs?memory=1024&timeout=300`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ urls: videoUrls.map((url) => ({ url })) }),
    },
  );
  if (!runResp.ok) {
    throw new Error(`Apify start run failed ${runResp.status}: ${await runResp.text()}`);
  }
  const runBody = await runResp.json() as { data: ApifyRunData };
  const { id: runId, defaultDatasetId: datasetId } = runBody.data;

  // Poll until SUCCEEDED or terminal status
  const deadline = Date.now() + APIFY_MAX_WAIT_MS;
  let lastStatus = "RUNNING";
  while (Date.now() < deadline) {
    await sleep(APIFY_POLL_INTERVAL_MS);
    const statusResp = await fetch(`${APIFY_BASE}/actor-runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!statusResp.ok) continue; // transient — keep polling
    const statusBody = await statusResp.json() as { data: ApifyRunData };
    lastStatus = statusBody.data.status;
    if (lastStatus === "SUCCEEDED") break;
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(lastStatus)) {
      throw new Error(`Apify run ${runId} ended with status: ${lastStatus}`);
    }
  }

  if (lastStatus !== "SUCCEEDED") {
    throw new Error(
      `Apify run ${runId} did not finish within ${APIFY_MAX_WAIT_MS / 1000}s (last: ${lastStatus})`,
    );
  }

  // Fetch dataset items
  const itemsResp = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!itemsResp.ok) throw new Error(`Apify dataset fetch failed ${itemsResp.status}`);
  return await itemsResp.json() as unknown[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Topic extraction — word frequency (Day 3 replaces with LLM semantic layer)
// ---------------------------------------------------------------------------

// Common English stopwords + YouTube filler words to suppress from topics
const STOPWORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
  "from","as","is","was","are","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","can","it",
  "its","this","that","these","those","i","you","he","she","we","they","me",
  "him","her","us","them","what","which","who","when","where","why","how",
  "all","each","every","both","few","more","most","other","some","such","no",
  "not","only","own","same","so","than","too","very","just","about","up","out",
  "if","also","like","into","over","after","get","know","think","want","go",
  "see","one","two","time","new","year","way","going","really","actually",
  "basically","literally","right","okay","yeah","well","kind","sort","much",
  "many","here","there","then","now","even","back","come","came","good","great",
  "thing","things","make","made","take","took","look","put","use","used","need",
  "let","say","said","gonna","wanna","gotta",
]);

export function extractTopics(transcriptItems: unknown[], topN = 20): string[] {
  const freq: Record<string, number> = {};

  for (const item of transcriptItems) {
    const record = item as Record<string, unknown>;
    const snippets = record["transcript"];
    let text = "";

    if (Array.isArray(snippets)) {
      text = snippets
        .map((s: unknown) => (s as Record<string, string>)["text"] ?? "")
        .join(" ");
    } else if (typeof snippets === "string") {
      text = snippets;
    }

    const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? [];
    for (const word of words) {
      if (!STOPWORDS.has(word)) {
        freq[word] = (freq[word] ?? 0) + 1;
      }
    }
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}

// ---------------------------------------------------------------------------
// Main: analyzeChannel
// ---------------------------------------------------------------------------

export async function analyzeChannel(
  channelInput: string,
  maxVideos: number,
): Promise<AnalyzeChannelResult> {
  const apifyToken = getApifyToken();
  const youtubeApiKey = getYouTubeApiKey();

  // Step 1: Resolve channel URL/handle → ID + uploads playlist
  const channel = await resolveChannel(channelInput, youtubeApiKey);

  // Step 2: Get recent video IDs from uploads playlist
  const videoIds = await getRecentVideoIds(channel.uploadsPlaylistId, maxVideos, youtubeApiKey);
  if (!videoIds.length) throw new Error(`No videos found for channel: ${channelInput}`);

  // Step 3: Fetch transcripts via Apify actor (same actor as Scout/R&D pipeline)
  const videoUrls = videoIds.map((id) => `https://www.youtube.com/watch?v=${id}`);
  const transcriptItems = await runApifyTranscriptScraper(videoUrls, apifyToken);

  // Step 4: Extract topics (word frequency; Day 3 adds LLM semantic layer)
  const topics = extractTopics(transcriptItems);

  return {
    channel_id: channel.channelId,
    channel_title: channel.title,
    channel_url: channelInput,
    sample_video_ids: videoIds,
    videos_analyzed: videoIds.length,
    transcripts_available: transcriptItems.length,
    topics,
    note: "Day 2: word-frequency topic extraction. Day 3 adds LLM-based semantic analysis.",
  };
}
