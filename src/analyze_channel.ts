/**
 * analyze_channel — Day 4 implementation.
 *
 * Channel resolution: YouTube Data API v3 (forHandle / by channel ID)
 * Transcript fetch: Apify supreme_coder/youtube-transcript-scraper (vKlQCAJRI72MdyK1u)
 *   — same actor used by IrrationalCorp Scout/R&D signal pipeline
 * Topic extraction: Gemini 2.5 Flash semantic layer (primary); word-frequency fallback
 * Persistence: topics_structured + topics written to disk as JSON artifact (ANALYZE_CHANNEL_OUTPUT_DIR)
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APIFY_BASE = "https://api.apify.com/v2";
// supreme_coder/youtube-transcript-scraper — same actor as scripts/yt-captions/apify_download.py
export const TRANSCRIPT_ACTOR_ID = "vKlQCAJRI72MdyK1u";
const YT_API_BASE = "https://www.googleapis.com/youtube/v3";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Corp secrets path — MCP server runs on the same host as IrrationalCorp repo
const CORP_SECRETS_DIR = "/media/development/irrationals/IrrationalCorp/secrets";

const APIFY_POLL_INTERVAL_MS = 15_000;
const APIFY_MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes
const GEMINI_TRANSCRIPT_WORD_LIMIT = 1000;
const DEFAULT_OUTPUT_DIR = "./output/";
const MAX_VIDEOS = 50;
const FETCH_TIMEOUT_MS = 30_000; // bound every outbound request so a stalled external API can't hang the tool call indefinitely

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, options: RequestInit, label: string): Promise<Response> {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`${label} timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
}

// A 2xx status does not guarantee a parseable (or expected-shape) JSON body —
// proxies/gateways can return HTML error pages with a 200, and flaky connections
// can truncate a response. Surface those as the same kind of descriptive error
// every other failure mode in this file produces, instead of a bare native
// "Unexpected token < in JSON at position 0" SyntaxError.
async function parseJsonResponse<T>(resp: Response, label: string): Promise<T> {
  try {
    return await resp.json() as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: response was not valid JSON (status ${resp.status}): ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChannelResolution {
  channelId: string;
  uploadsPlaylistId: string;
  title: string;
}

export interface TopicStructured {
  video_id: string;
  theme: string;
  entities: string[];
  tags: string[];
}

export interface AnalyzeChannelResult {
  channel_id: string;
  channel_title: string;
  channel_url: string;
  sample_video_ids: string[];
  videos_analyzed: number;
  transcripts_available: number;
  topics: string[];
  topics_structured: TopicStructured[];
  note: string;
  output_path?: string;
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

export function getGeminiApiKey(): string {
  const key = process.env["GEMINI_API_KEY"] ?? loadEnvKey("gemini.env", "GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY not configured. Set env var GEMINI_API_KEY or ensure secrets/gemini.env exists.");
  return key;
}

// ---------------------------------------------------------------------------
// Channel URL / handle parser
// ---------------------------------------------------------------------------

export function parseChannelInput(input: string): ParsedChannel {
  const trimmed = input.trim();

  // Bare @handle — e.g. @fireship or @web.dev (periods allowed in handles)
  if (/^@[\w.-]+$/.test(trimmed)) return { type: "handle", value: trimmed };

  // Full URL with @handle — youtube.com/@fireship or youtube.com/@web.dev/videos
  const handleFromUrl = trimmed.match(/youtube\.com\/@([\w.-]+)/);
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
    const searchResp = await fetchWithTimeout(searchUrl, {}, "YouTube search API");
    if (!searchResp.ok) throw new Error(`YouTube search API error ${searchResp.status}: ${await searchResp.text()}`);
    const searchData = await parseJsonResponse<YtApiResponse>(searchResp, "YouTube search API");
    // Same guard as the handle/channel_id path below and getRecentVideoIds: Google APIs
    // sometimes embed a quota/permission failure in a 200 body instead of the HTTP status.
    // This path costs 100 quota units per call (vs 1 for the others), so it is the most
    // likely of the three to actually hit that failure mode — without this check it was
    // misreported as "Channel not found" instead of the real cause.
    if (searchData.error) throw new Error(`YouTube API: ${searchData.error.message}`);
    const items = searchData.items ?? [];
    if (!items.length) throw new Error(`Channel not found for custom URL: ${input}`);
    const channelId = (items[0]["id"] as Record<string, string> | undefined)?.["channelId"];
    if (!channelId) throw new Error(`Channel not found for custom URL: ${input} (search result had no channel ID)`);
    return resolveChannel(channelId, apiKey);
  }

  const resp = await fetchWithTimeout(apiUrl, {}, "YouTube channels API");
  if (!resp.ok) throw new Error(`YouTube channels API error ${resp.status}: ${await resp.text()}`);
  const data = await parseJsonResponse<YtApiResponse>(resp, "YouTube channels API");

  if (data.error) throw new Error(`YouTube API: ${data.error.message}`);
  const items = data.items ?? [];
  if (!items.length) throw new Error(`Channel not found: ${input}`);

  const item = items[0];
  const snippet = item["snippet"] as Record<string, string>;
  const contentDetails = item["contentDetails"] as { relatedPlaylists?: Record<string, string> } | undefined;
  const uploadsPlaylistId = contentDetails?.relatedPlaylists?.["uploads"];
  if (!uploadsPlaylistId) {
    throw new Error(
      `Channel "${input}" has no uploads playlist (it may be terminated, suspended, or otherwise unavailable).`,
    );
  }

  return {
    channelId: item["id"] as string,
    uploadsPlaylistId,
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
  const resp = await fetchWithTimeout(apiUrl, {}, "YouTube playlistItems API");
  if (!resp.ok) throw new Error(`YouTube playlistItems API error ${resp.status}: ${await resp.text()}`);
  const data = await parseJsonResponse<YtApiResponse>(resp, "YouTube playlistItems API");
  // Google APIs usually mirror an API-level error into the HTTP status, but not
  // always (e.g. some quota/permission failures land in the body of a 200) —
  // resolveChannel already guards this; mirror it here instead of silently
  // proceeding as if the channel simply had zero videos.
  if (data.error) throw new Error(`YouTube API: ${data.error.message}`);
  const items = (data.items ?? []) as Array<{ contentDetails?: { videoId?: string } }>;
  return items.map((item) => item.contentDetails?.videoId).filter((id): id is string => Boolean(id));
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
  const startRun = () =>
    fetchWithTimeout(
      `${APIFY_BASE}/acts/${TRANSCRIPT_ACTOR_ID}/runs?memory=1024&timeout=300`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ urls: videoUrls.map((url) => ({ url })) }),
      },
      "Apify start run",
    );
  let runResp = await startRun();
  // Retry once on a transient 5xx — the same one-shot tolerance already given to
  // Gemini calls and to every status poll below; a 503 here previously failed the
  // whole tool call immediately instead of getting that same retry.
  if (!runResp.ok && runResp.status >= 500) {
    runResp = await startRun();
  }
  if (!runResp.ok) {
    throw new Error(`Apify start run failed ${runResp.status}: ${await runResp.text()}`);
  }
  const runBody = await parseJsonResponse<{ data?: Partial<ApifyRunData> }>(runResp, "Apify start run");
  if (!runBody.data?.id || !runBody.data?.defaultDatasetId) {
    throw new Error(`Apify start run: response missing run id or dataset id: ${JSON.stringify(runBody)}`);
  }
  const { id: runId, defaultDatasetId: datasetId } = runBody.data;

  // Poll until SUCCEEDED or terminal status
  const deadline = Date.now() + APIFY_MAX_WAIT_MS;
  let lastStatus = "RUNNING";
  while (Date.now() < deadline) {
    await sleep(APIFY_POLL_INTERVAL_MS);
    let statusResp: Response;
    try {
      statusResp = await fetchWithTimeout(
        `${APIFY_BASE}/actor-runs/${runId}`,
        { headers: { Authorization: `Bearer ${token}` } },
        "Apify poll",
      );
    } catch {
      // Connection error or per-request timeout — genuinely transient, same as a 5xx below.
      continue;
    }
    if (!statusResp.ok) {
      // 4xx = permanent error (invalid run ID, bad token) — fail fast instead of polling to timeout
      if (statusResp.status >= 400 && statusResp.status < 500) {
        throw new Error(`Apify poll error ${statusResp.status} for run ${runId}: ${await statusResp.text()}`);
      }
      continue; // 5xx or network transient — keep polling
    }
    let statusBody: { data?: Partial<ApifyRunData> };
    try {
      statusBody = await parseJsonResponse<{ data?: Partial<ApifyRunData> }>(statusResp, "Apify poll");
    } catch {
      continue; // malformed body on an otherwise-ok poll response — as transient as a 5xx
    }
    if (!statusBody.data?.status) continue; // unexpected shape — same treatment
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
  const itemsResp = await fetchWithTimeout(
    `${APIFY_BASE}/datasets/${datasetId}/items?limit=100`,
    { headers: { Authorization: `Bearer ${token}` } },
    "Apify dataset fetch",
  );
  if (!itemsResp.ok) throw new Error(`Apify dataset fetch failed ${itemsResp.status}: ${await itemsResp.text()}`);
  const items = await parseJsonResponse<unknown>(itemsResp, "Apify dataset fetch");
  if (!Array.isArray(items)) {
    throw new Error(`Apify dataset fetch: expected an array of items, got ${typeof items}`);
  }
  return items;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Disk persistence — write topics_structured artifact as JSON (Day 4)
// ---------------------------------------------------------------------------

export function persistAnalysisResult(
  result: AnalyzeChannelResult,
  outputDir: string = process.env["ANALYZE_CHANNEL_OUTPUT_DIR"] ?? DEFAULT_OUTPUT_DIR,
): string | null {
  try {
    mkdirSync(outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `analyze_channel-${result.channel_id}-${timestamp}.json`;
    const filepath = join(outputDir, filename);
    const payload = {
      channel_id: result.channel_id,
      channel_title: result.channel_title,
      channel_url: result.channel_url,
      sample_video_ids: result.sample_video_ids,
      video_count: result.videos_analyzed,
      topics_structured: result.topics_structured,
      topics: result.topics,
      generated_at: new Date().toISOString(),
    };
    writeFileSync(filepath, JSON.stringify(payload, null, 2), "utf8");
    return filepath;
  } catch (err) {
    console.warn(`[analyze_channel] Failed to persist output: ${(err as Error).message}`);
    return null;
  }
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

// The word regex below splits on the apostrophe in negation contractions (e.g.
// "wasn't" tokenizes as "wasn", dropping the "t"), and several of those prefixes
// are 4+ characters — long enough to pass the length filter — and were not caught
// by the modal-verb stopwords above, so they leaked into topics as noise on any
// transcript with normal spoken-English contraction density.
const CONTRACTION_STOPWORDS = new Set([
  "wasn","aren","weren","hasn","haven","hadn","doesn","didn","couldn","wouldn","shouldn",
]);

// Short technical abbreviations exempt from the 4-char minimum in extractTopics.
// The base regex only matches [a-z]{4,} to suppress noise, but these 2-3 char
// terms are high-signal in tech content (channels discussing AI, web dev, cloud, etc.).
const TECH_TERMS = new Set([
  "ai","ml","vr","ar","xr",
  "api","sdk","npm","css","gpu","llm","cli","sql","git","aws","gcp","ios",
  "ui","ux","ci","cd","ide","orm","jwt","ssh","tcp","dns","cdn",
  "js","ts","tsx","jsx","php","os",
]);

// ---------------------------------------------------------------------------
// LLM semantic extraction — Gemini 2.5 Flash (primary route per SC Night 141)
// ---------------------------------------------------------------------------

interface GeminiContent {
  parts: Array<{ text: string }>;
}

interface GeminiCandidate {
  content: GeminiContent;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
}

export async function extractTopicsWithLLM(
  transcriptItems: unknown[],
  geminiApiKey: string,
): Promise<TopicStructured[]> {
  const results: TopicStructured[] = [];
  let attempted = 0;
  let lastRequestError: string | undefined;

  for (const item of transcriptItems) {
    const record = item as Record<string, unknown>;
    const videoDetails = record["videoDetails"] as Record<string, string> | undefined;
    const videoId = videoDetails?.["videoId"] ?? "unknown";

    const snippets = record["transcript"];
    let rawText = "";
    if (Array.isArray(snippets)) {
      rawText = snippets.map((s: unknown) => (s as Record<string, string>)["text"] ?? "").join(" ");
    } else if (typeof snippets === "string") {
      rawText = snippets;
    }
    if (!rawText.trim()) continue;

    // Truncate to limit Gemini input tokens
    const words = rawText.split(/\s+/);
    const truncated = words.slice(0, GEMINI_TRANSCRIPT_WORD_LIMIT).join(" ");

    const prompt = `Analyze this YouTube video transcript excerpt and return a JSON object with fields:
- "theme": one short phrase describing the main topic (max 8 words)
- "entities": array of up to 6 specific named technologies, products, companies, or people mentioned
- "tags": array of up to 8 topical keywords relevant for content classification

Transcript (video_id: ${videoId}):
${truncated}`;

    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            theme: { type: "STRING" },
            entities: { type: "ARRAY", items: { type: "STRING" } },
            tags: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["theme", "entities", "tags"],
        },
      },
    };

    attempted++;
    try {
      let resp = await fetchWithTimeout(
        `${GEMINI_API_BASE}/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        },
        "Gemini API",
      );

      // Retry once on transient failures: 5xx (Gemini 503 overloaded is common) or 429
      // (rate limit) — both are worth a single backoff-free retry rather than discarding
      // this video's topics outright.
      if (!resp.ok && (resp.status >= 500 || resp.status === 429)) {
        resp = await fetchWithTimeout(
          `${GEMINI_API_BASE}/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          },
          "Gemini API",
        );
      }

      if (!resp.ok) {
        throw new Error(`Gemini API error ${resp.status}: ${await resp.text()}`);
      }

      const body = await parseJsonResponse<GeminiResponse>(resp, "Gemini API");
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      let parsed: { theme?: string; entities?: string[]; tags?: string[] } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        console.warn(`[analyze_channel] Gemini returned unparseable JSON for video ${videoId}, skipping`);
        continue;
      }

      results.push({
        video_id: videoId,
        theme: parsed.theme ?? "",
        entities: parsed.entities ?? [],
        tags: parsed.tags ?? [],
      });
    } catch (err) {
      // Isolate this video's failure so one bad request doesn't discard
      // structured topics already extracted for the rest of the channel's videos.
      lastRequestError = err instanceof Error ? err.message : String(err);
      console.warn(`[analyze_channel] Gemini request failed for video ${videoId}, skipping: ${lastRequestError}`);
    }
  }

  // Every attempted video failed at the HTTP level — surface it as a total
  // failure so analyzeChannel's note reports a Gemini outage instead of
  // silently claiming success with zero structured topics.
  if (attempted > 0 && results.length === 0 && lastRequestError) {
    throw new Error(lastRequestError);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Topic extraction — word frequency (kept as fallback when LLM unavailable)
// ---------------------------------------------------------------------------

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

    const words = text.toLowerCase().match(/\b[a-z]{2,}\b/g) ?? [];
    for (const word of words) {
      if ((word.length >= 4 || TECH_TERMS.has(word)) && !STOPWORDS.has(word) && !CONTRACTION_STOPWORDS.has(word)) {
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
  if (maxVideos < 1) throw new Error(`max_videos must be at least 1, got ${maxVideos}`);
  const clampedMaxVideos = Math.min(maxVideos, MAX_VIDEOS);

  const apifyToken = getApifyToken();
  const youtubeApiKey = getYouTubeApiKey();

  // Step 1: Resolve channel URL/handle → ID + uploads playlist
  const channel = await resolveChannel(channelInput, youtubeApiKey);

  // Step 2: Get recent video IDs from uploads playlist
  const videoIds = await getRecentVideoIds(channel.uploadsPlaylistId, clampedMaxVideos, youtubeApiKey);
  if (!videoIds.length) throw new Error(`No videos found for channel: ${channelInput}`);

  // Step 3: Fetch transcripts via Apify actor (same actor as Scout/R&D pipeline)
  const videoUrls = videoIds.map((id) => `https://www.youtube.com/watch?v=${id}`);
  const transcriptItems = await runApifyTranscriptScraper(videoUrls, apifyToken);

  // Step 4a: Word-frequency topics (always computed — fallback if LLM fails)
  const topics = extractTopics(transcriptItems);

  // Count only items where the transcript field contains actual content.
  // Apify returns one item per video even when captions are unavailable,
  // so raw transcriptItems.length overstates how many videos were actually transcribed.
  const transcriptsAvailable = transcriptItems.filter((item) => {
    const record = item as Record<string, unknown>;
    const snippets = record["transcript"];
    if (Array.isArray(snippets)) return snippets.length > 0;
    if (typeof snippets === "string") return snippets.trim().length > 0;
    return false;
  }).length;

  // Step 4b: LLM semantic extraction via Gemini 2.5 Flash (primary route)
  let topics_structured: TopicStructured[] = [];
  let geminiUsed = false;
  let geminiConfigured = false;
  try {
    const geminiKey = getGeminiApiKey();
    geminiConfigured = true;
    topics_structured = await extractTopicsWithLLM(transcriptItems, geminiKey);
    geminiUsed = true;
  } catch (err) {
    // Graceful degradation — topics_structured stays empty; topics is the fallback
    console.warn(`[analyze_channel] Gemini extraction unavailable, using keyword fallback: ${err instanceof Error ? err.message : String(err)}`);
  }

  const note = geminiUsed
    ? `Analyzed ${videoIds.length} video(s), ${transcriptsAvailable} with transcripts — ${topics_structured.length} semantic topics (topics_structured) via Gemini, ${topics.length} keyword topics as supplemental.`
    : geminiConfigured
    ? `Analyzed ${videoIds.length} video(s), ${transcriptsAvailable} with transcripts — ${topics.length} keyword topics only (Gemini API error — check logs for details).`
    : `Analyzed ${videoIds.length} video(s), ${transcriptsAvailable} with transcripts — ${topics.length} keyword topics only (GEMINI_API_KEY not configured). Set GEMINI_API_KEY for richer structured analysis.`;

  const result: AnalyzeChannelResult = {
    channel_id: channel.channelId,
    channel_title: channel.title,
    channel_url: channelInput,
    sample_video_ids: videoIds,
    videos_analyzed: videoIds.length,
    transcripts_available: transcriptsAvailable,
    topics,
    topics_structured,
    note,
  };

  // Side-effect: persist artifact to disk (configurable via ANALYZE_CHANNEL_OUTPUT_DIR)
  const outputPath = persistAnalysisResult(result);
  if (outputPath) result.output_path = outputPath;

  return result;
}
