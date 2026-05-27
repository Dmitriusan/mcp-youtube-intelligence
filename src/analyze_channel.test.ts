import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseChannelInput,
  extractTopics,
  resolveChannel,
  getRecentVideoIds,
  runApifyTranscriptScraper,
  analyzeChannel,
  TRANSCRIPT_ACTOR_ID,
} from "./analyze_channel.js";

// ---------------------------------------------------------------------------
// parseChannelInput — pure function, no mocks needed
// ---------------------------------------------------------------------------
describe("parseChannelInput", () => {
  it("parses bare @handle", () => {
    expect(parseChannelInput("@fireship")).toEqual({ type: "handle", value: "@fireship" });
  });

  it("parses full youtube.com/@handle URL", () => {
    expect(parseChannelInput("https://www.youtube.com/@fireship")).toEqual({
      type: "handle",
      value: "@fireship",
    });
  });

  it("parses youtube.com/@handle/videos URL", () => {
    expect(parseChannelInput("https://www.youtube.com/@fireship/videos")).toEqual({
      type: "handle",
      value: "@fireship",
    });
  });

  it("parses /channel/UC... URL", () => {
    expect(
      parseChannelInput("https://www.youtube.com/channel/UCVHVAPyVgjkAyfLiwbHyXyg"),
    ).toEqual({ type: "channel_id", value: "UCVHVAPyVgjkAyfLiwbHyXyg" });
  });

  it("parses bare UC... channel ID", () => {
    expect(parseChannelInput("UCVHVAPyVgjkAyfLiwbHyXyg")).toEqual({
      type: "channel_id",
      value: "UCVHVAPyVgjkAyfLiwbHyXyg",
    });
  });

  it("parses /c/customname URL as custom_url", () => {
    expect(parseChannelInput("https://www.youtube.com/c/fireship")).toEqual({
      type: "custom_url",
      value: "fireship",
    });
  });

  it("parses /user/username URL as custom_url", () => {
    expect(parseChannelInput("https://www.youtube.com/user/fireship")).toEqual({
      type: "custom_url",
      value: "fireship",
    });
  });

  it("throws on unrecognized input", () => {
    expect(() => parseChannelInput("notavalidinput")).toThrow(
      /Cannot parse YouTube channel/,
    );
  });

  it("trims whitespace from input", () => {
    expect(parseChannelInput("  @fireship  ")).toEqual({
      type: "handle",
      value: "@fireship",
    });
  });
});

// ---------------------------------------------------------------------------
// extractTopics — pure function, no mocks needed
// ---------------------------------------------------------------------------
describe("extractTopics", () => {
  it("returns top N keywords by frequency", () => {
    const items = [
      {
        transcript: [
          { text: "machine learning models training neural networks deep learning" },
          { text: "machine learning data science python programming neural networks" },
          { text: "machine learning transformer models attention mechanism" },
        ],
      },
    ];
    const topics = extractTopics(items, 5);
    expect(topics).toContain("machine");
    expect(topics).toContain("learning");
    expect(topics.length).toBeLessThanOrEqual(5);
  });

  it("filters stopwords", () => {
    const items = [
      {
        transcript: [{ text: "the quick brown foxes jumped over lazy dogs really" }],
      },
    ];
    const topics = extractTopics(items, 10);
    expect(topics).not.toContain("the");
    expect(topics).not.toContain("over");
    expect(topics).not.toContain("really");
  });

  it("handles string transcript format", () => {
    const items = [{ transcript: "javascript typescript programming language development" }];
    const topics = extractTopics(items, 10);
    expect(topics).toContain("javascript");
    expect(topics).toContain("typescript");
    expect(topics).toContain("programming");
  });

  it("returns empty array for empty input", () => {
    expect(extractTopics([])).toEqual([]);
  });

  it("ignores items with no transcript field", () => {
    const items = [{ videoId: "abc123" }];
    expect(extractTopics(items)).toEqual([]);
  });

  it("only includes words with 4+ characters", () => {
    const items = [{ transcript: [{ text: "an the is go run fast" }] }];
    // "fast" = 4 chars, not a stopword — should appear. "run" = 3 chars — excluded.
    const topics = extractTopics(items, 10);
    expect(topics).toContain("fast");
    expect(topics).not.toContain("run");
  });
});

// ---------------------------------------------------------------------------
// analyzeChannel — happy path with mocked fetch + fake timers
// ---------------------------------------------------------------------------
describe("analyzeChannel (happy path, mocked fetch)", () => {
  beforeEach(() => {
    // Set env vars so credential loading succeeds without hitting the filesystem
    process.env["APIFY_TOKEN"] = "test-apify-token";
    process.env["YOUTUBE_API_KEY"] = "test-yt-key";
  });

  afterEach(() => {
    delete process.env["APIFY_TOKEN"];
    delete process.env["YOUTUBE_API_KEY"];
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("resolves channel, fetches videos, runs Apify actor, extracts topics", async () => {
    // Use fake timers so the 15s poll sleep resolves instantly
    vi.useFakeTimers();

    const mockFetch = vi.fn();

    // Call 1: YouTube channels API (resolveChannel)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "UCVHVAPyVgjkAyfLiwbHyXyg",
            snippet: { title: "Fireship" },
            contentDetails: { relatedPlaylists: { uploads: "UUVHVAPyVgjkAyfLiwbHyXyg" } },
          },
        ],
      }),
    });

    // Call 2: YouTube playlistItems API (getRecentVideoIds)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          { contentDetails: { videoId: "vid001" } },
          { contentDetails: { videoId: "vid002" } },
          { contentDetails: { videoId: "vid003" } },
        ],
      }),
    });

    // Call 3: Apify start run
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { id: "run-001", defaultDatasetId: "ds-001", status: "RUNNING" },
      }),
    });

    // Call 4: Apify poll status → SUCCEEDED (after first sleep fires)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { id: "run-001", defaultDatasetId: "ds-001", status: "SUCCEEDED" },
      }),
    });

    // Call 5: Apify dataset items
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          videoDetails: { videoId: "vid001", title: "JavaScript Tutorial" },
          transcript: [
            { text: "javascript programming tutorial beginner coding" },
            { text: "typescript javascript framework react development" },
          ],
        },
        {
          videoDetails: { videoId: "vid002", title: "TypeScript Deep Dive" },
          transcript: [{ text: "typescript javascript types interfaces generics programming" }],
        },
      ],
    });

    vi.stubGlobal("fetch", mockFetch);

    // Start the async operation, then advance fake timers to fire the poll sleep
    const resultPromise = analyzeChannel("@fireship", 3);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.channel_id).toBe("UCVHVAPyVgjkAyfLiwbHyXyg");
    expect(result.channel_title).toBe("Fireship");
    expect(result.sample_video_ids).toEqual(["vid001", "vid002", "vid003"]);
    expect(result.videos_analyzed).toBe(3);
    expect(result.transcripts_available).toBe(2);
    expect(result.topics).toContain("javascript");
    expect(result.topics).toContain("typescript");
    expect(result.topics).toContain("programming");
    expect(result.note).toContain("Day 2");

    // Verify Apify actor ID was used
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(TRANSCRIPT_ACTOR_ID),
      expect.any(Object),
    );
  });
});
