import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import {
  parseChannelInput,
  extractTopics,
  extractTopicsWithLLM,
  resolveChannel,
  getRecentVideoIds,
  runApifyTranscriptScraper,
  analyzeChannel,
  persistAnalysisResult,
  TRANSCRIPT_ACTOR_ID,
  type AnalyzeChannelResult,
} from "./analyze_channel.js";

// Mock fs so that mkdirSync/writeFileSync are no-ops in all tests (persistence side-effect),
// while readFileSync (used by loadEnvKey) stays real so secret loading works normally.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

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

  it("parses @handle with period (e.g. @web.dev)", () => {
    expect(parseChannelInput("@web.dev")).toEqual({ type: "handle", value: "@web.dev" });
  });

  it("parses youtube.com/@handle URL with period in handle", () => {
    expect(parseChannelInput("https://www.youtube.com/@google.cloud")).toEqual({
      type: "handle",
      value: "@google.cloud",
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

  it("captures short tech terms below 4-char minimum via TECH_TERMS allowlist", () => {
    const items = [{ transcript: [{ text: "building an api with the gpu accelerated llm using npm and css animations" }] }];
    const topics = extractTopics(items, 20);
    expect(topics).toContain("api");
    expect(topics).toContain("gpu");
    expect(topics).toContain("llm");
    expect(topics).toContain("npm");
    expect(topics).toContain("css");
  });

  it("does not capture arbitrary 2-3 char words that are not in the TECH_TERMS allowlist", () => {
    const items = [{ transcript: [{ text: "it ok mr vs ip run" }] }];
    const topics = extractTopics(items, 20);
    // "ok", "mr", "vs", "ip", "run" are short non-allowlisted words — must not appear
    expect(topics).not.toContain("ok");
    expect(topics).not.toContain("mr");
    expect(topics).not.toContain("vs");
    expect(topics).not.toContain("ip");
    expect(topics).not.toContain("run");
  });

  it("returns all unique words when topN exceeds the number of unique words found", () => {
    const items = [{ transcript: [{ text: "javascript typescript" }] }];
    // Only 2 unique qualifying words; requesting 100 should return exactly those 2
    const topics = extractTopics(items, 100);
    expect(topics).toHaveLength(2);
    expect(topics).toContain("javascript");
    expect(topics).toContain("typescript");
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
    expect(result.note).toContain("3 video(s)");

    // Verify Apify actor ID was used
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(TRANSCRIPT_ACTOR_ID),
      expect.any(Object),
    );

    // topics_structured is [] because GEMINI_API_KEY is not set in this test
    expect(result.topics_structured).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// analyzeChannel — max_videos validation
// ---------------------------------------------------------------------------
describe("analyzeChannel (input validation)", () => {
  beforeEach(() => {
    process.env["APIFY_TOKEN"] = "test-apify-token";
    process.env["YOUTUBE_API_KEY"] = "test-yt-key";
  });

  afterEach(() => {
    delete process.env["APIFY_TOKEN"];
    delete process.env["YOUTUBE_API_KEY"];
    vi.restoreAllMocks();
  });

  it("throws immediately when max_videos is 0", async () => {
    await expect(analyzeChannel("@fireship", 0)).rejects.toThrow(/max_videos must be at least 1/);
  });

  it("throws immediately when max_videos is negative", async () => {
    await expect(analyzeChannel("@fireship", -5)).rejects.toThrow(/max_videos must be at least 1/);
  });
});

// ---------------------------------------------------------------------------
// analyzeChannel — Apify terminal failure
// ---------------------------------------------------------------------------
describe("analyzeChannel (Apify terminal failure, mocked fetch)", () => {
  beforeEach(() => {
    process.env["APIFY_TOKEN"] = "test-apify-token";
    process.env["YOUTUBE_API_KEY"] = "test-yt-key";
  });

  afterEach(() => {
    delete process.env["APIFY_TOKEN"];
    delete process.env["YOUTUBE_API_KEY"];
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rejects with FAILED status when Apify run terminates unsuccessfully", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn();

    // Call 1: YouTube channels API
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

    // Call 2: YouTube playlistItems API
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [{ contentDetails: { videoId: "vid001" } }],
      }),
    });

    // Call 3: Apify start run → RUNNING
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { id: "run-fail", defaultDatasetId: "ds-fail", status: "RUNNING" },
      }),
    });

    // Call 4: Apify poll → FAILED
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { id: "run-fail", defaultDatasetId: "ds-fail", status: "FAILED" },
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const resultPromise = analyzeChannel("@fireship", 3);
    // Attach rejection handler before running timers to avoid unhandled-rejection race
    const failExpectation = expect(resultPromise).rejects.toThrow(/FAILED/);
    await vi.runAllTimersAsync();
    await failExpectation;
  });
});

// ---------------------------------------------------------------------------
// extractTopicsWithLLM — Gemini 2.5 Flash semantic extraction
// ---------------------------------------------------------------------------
describe("extractTopicsWithLLM", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns TopicStructured[] populated from Gemini response", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    theme: "JavaScript frameworks and tooling",
                    entities: ["React", "TypeScript", "Vite"],
                    tags: ["javascript", "frontend", "webdev"],
                  }),
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const items = [
      {
        videoDetails: { videoId: "vid001" },
        transcript: [{ text: "react typescript javascript vite frontend development" }],
      },
    ];

    const result = await extractTopicsWithLLM(items, "test-key");
    expect(result).toHaveLength(1);
    expect(result[0].video_id).toBe("vid001");
    expect(result[0].theme).toBe("JavaScript frameworks and tooling");
    expect(result[0].entities).toContain("React");
    expect(result[0].tags).toContain("javascript");
  });

  it("skips items with no transcript and makes no fetch call", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const items = [{ videoDetails: { videoId: "vid001" } }];
    const result = await extractTopicsWithLLM(items, "test-key");
    expect(result).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses graceful defaults when Gemini response omits optional fields", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ theme: "Machine learning" }) }],
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const items = [
      {
        videoDetails: { videoId: "vid002" },
        transcript: [{ text: "neural networks deep learning training" }],
      },
    ];

    const result = await extractTopicsWithLLM(items, "test-key");
    expect(result).toHaveLength(1);
    expect(result[0].theme).toBe("Machine learning");
    expect(result[0].entities).toEqual([]);
    expect(result[0].tags).toEqual([]);
  });

  it("throws when Gemini returns a non-ok HTTP status", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "Rate limit exceeded",
    });
    vi.stubGlobal("fetch", mockFetch);

    const items = [
      {
        videoDetails: { videoId: "vid003" },
        transcript: [{ text: "some content about coding" }],
      },
    ];

    await expect(extractTopicsWithLLM(items, "test-key")).rejects.toThrow(/Gemini API error 429/);
  });

  it("skips video with malformed JSON response and continues processing remaining videos", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "not-valid-json{{" }] } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ theme: "Testing strategies", entities: [], tags: ["testing"] }) }] } }],
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const items = [
      { videoDetails: { videoId: "vid001" }, transcript: [{ text: "some content about coding" }] },
      { videoDetails: { videoId: "vid002" }, transcript: [{ text: "more content about testing" }] },
    ];

    const result = await extractTopicsWithLLM(items, "test-key");
    // vid001 skipped due to parse failure; vid002 succeeds
    expect(result).toHaveLength(1);
    expect(result[0].video_id).toBe("vid002");
    expect(result[0].theme).toBe("Testing strategies");
  });
});

// ---------------------------------------------------------------------------
// getRecentVideoIds — YouTube playlistItems API
// ---------------------------------------------------------------------------
describe("getRecentVideoIds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns video IDs extracted from playlistItems response", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          { contentDetails: { videoId: "vid001" } },
          { contentDetails: { videoId: "vid002" } },
          { contentDetails: { videoId: "vid003" } },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await getRecentVideoIds("PLtest1234", 3, "test-key");
    expect(result).toEqual(["vid001", "vid002", "vid003"]);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("PLtest1234"));
  });

  it("throws when the playlistItems API returns a non-ok status", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 403 });
    vi.stubGlobal("fetch", mockFetch);

    await expect(getRecentVideoIds("PLtest1234", 3, "test-key")).rejects.toThrow(
      /playlistItems API error 403/,
    );
  });

  it("filters out playlist items with empty videoId", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          { contentDetails: { videoId: "vid001" } },
          { contentDetails: { videoId: "" } },
          { contentDetails: { videoId: "vid003" } },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await getRecentVideoIds("PLtest1234", 3, "test-key");
    expect(result).toEqual(["vid001", "vid003"]);
  });
});

// ---------------------------------------------------------------------------
// runApifyTranscriptScraper — Apify actor polling and terminal status handling
// ---------------------------------------------------------------------------
describe("runApifyTranscriptScraper (terminal statuses)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("throws timeout error when deadline expires before run succeeds", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn();

    // Start run → RUNNING
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { id: "run-timeout", defaultDatasetId: "ds-timeout", status: "RUNNING" },
      }),
    });

    // All subsequent polls also return RUNNING — run never finishes
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { id: "run-timeout", defaultDatasetId: "ds-timeout", status: "RUNNING" },
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const resultPromise = runApifyTranscriptScraper(
      ["https://www.youtube.com/watch?v=test123"],
      "test-token",
    );
    const failExpectation = expect(resultPromise).rejects.toThrow(/did not finish within/);
    await vi.runAllTimersAsync();
    await failExpectation;
  });

  it.each(["ABORTED", "TIMED-OUT"] as const)(
    "throws when Apify run ends with %s status",
    async (terminalStatus) => {
      vi.useFakeTimers();
      const mockFetch = vi.fn();

      // Start run → RUNNING
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { id: "run-term", defaultDatasetId: "ds-term", status: "RUNNING" },
        }),
      });

      // Poll → terminal status
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { id: "run-term", defaultDatasetId: "ds-term", status: terminalStatus },
        }),
      });

      vi.stubGlobal("fetch", mockFetch);

      const resultPromise = runApifyTranscriptScraper(
        ["https://www.youtube.com/watch?v=test123"],
        "test-token",
      );
      const failExpectation = expect(resultPromise).rejects.toThrow(terminalStatus);
      await vi.runAllTimersAsync();
      await failExpectation;
    },
  );
});

// ---------------------------------------------------------------------------
// resolveChannel — YouTube Data API channel resolution
// ---------------------------------------------------------------------------
describe("resolveChannel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves @handle via forHandle API call and returns channel metadata", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "UCtest1234567890ABCDE12",
            snippet: { title: "Test Channel" },
            contentDetails: { relatedPlaylists: { uploads: "UUtest1234567890ABCDE12" } },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await resolveChannel("@testchannel", "test-api-key");
    expect(result.channelId).toBe("UCtest1234567890ABCDE12");
    expect(result.title).toBe("Test Channel");
    expect(result.uploadsPlaylistId).toBe("UUtest1234567890ABCDE12");
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("forHandle="));
  });

  it("resolves bare UC... channel ID via id parameter", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
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
    vi.stubGlobal("fetch", mockFetch);

    const result = await resolveChannel("UCVHVAPyVgjkAyfLiwbHyXyg", "test-api-key");
    expect(result.channelId).toBe("UCVHVAPyVgjkAyfLiwbHyXyg");
    expect(result.uploadsPlaylistId).toBe("UUVHVAPyVgjkAyfLiwbHyXyg");
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("id=UCVHVAPyVgjkAyfLiwbHyXyg"));
  });

  it("throws 'Channel not found' when API returns empty items array", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(resolveChannel("@unknown", "test-api-key")).rejects.toThrow(/Channel not found/);
  });

  it("throws on non-ok HTTP response from channels API", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(resolveChannel("@testchannel", "test-api-key")).rejects.toThrow(
      /YouTube channels API error 403/,
    );
  });

  it("throws when API body contains error object", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: { message: "API key is invalid" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(resolveChannel("@testchannel", "bad-api-key")).rejects.toThrow(
      /API key is invalid/,
    );
  });

  it("resolves legacy /c/ URL via search API then re-resolves by channel ID", async () => {
    const mockFetch = vi.fn();

    // Call 1: YouTube search API (custom URL path — costs 100 quota units)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [{ id: { channelId: "UCVHVAPyVgjkAyfLiwbHyXyg" } }],
      }),
    });

    // Call 2: YouTube channels API (recursive re-resolve by channel ID)
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

    vi.stubGlobal("fetch", mockFetch);

    const result = await resolveChannel("https://www.youtube.com/c/fireship", "test-api-key");
    expect(result.channelId).toBe("UCVHVAPyVgjkAyfLiwbHyXyg");
    expect(result.title).toBe("Fireship");
    expect(result.uploadsPlaylistId).toBe("UUVHVAPyVgjkAyfLiwbHyXyg");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining("search?"));
  });

  it("throws 'Channel not found' when search returns no results for legacy /user/ URL", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      resolveChannel("https://www.youtube.com/user/unknownuser", "test-api-key"),
    ).rejects.toThrow(/Channel not found for custom URL/);
  });
});

// ---------------------------------------------------------------------------
// persistAnalysisResult — disk persistence of topics_structured artifact
// ---------------------------------------------------------------------------
describe("persistAnalysisResult", () => {
  const sampleResult: AnalyzeChannelResult = {
    channel_id: "UCtest1234567890ABCDEFG",
    channel_title: "Test Channel",
    channel_url: "@testchannel",
    sample_video_ids: ["vid1", "vid2"],
    videos_analyzed: 2,
    transcripts_available: 2,
    topics: ["javascript", "typescript"],
    topics_structured: [{ video_id: "vid1", theme: "JavaScript basics", entities: ["Node"], tags: ["js"] }],
    note: "Day 4 test",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env["ANALYZE_CHANNEL_OUTPUT_DIR"];
  });

  it("writes JSON artifact to output dir with correct schema and returns the file path", () => {
    const returnedPath = persistAnalysisResult(sampleResult, "/tmp/test-output");

    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith("/tmp/test-output", { recursive: true });
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce();

    const [filepath, content] = vi.mocked(writeFileSync).mock.calls[0] as [string, string, string];
    expect(filepath).toMatch(/analyze_channel-UCtest1234567890ABCDEFG-.*\.json$/);
    expect(returnedPath).toBe(filepath);

    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed["channel_id"]).toBe("UCtest1234567890ABCDEFG");
    expect(parsed["channel_title"]).toBe("Test Channel");
    expect(parsed["video_count"]).toBe(2);
    expect(Array.isArray(parsed["topics_structured"])).toBe(true);
    expect((parsed["topics_structured"] as unknown[]).length).toBe(1);
    expect(parsed["topics"]).toContain("javascript");
    expect(typeof parsed["generated_at"]).toBe("string");
  });

  it("returns null and continues without error when directory creation fails (unwritable path)", () => {
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied");
    });

    const returnedPath = persistAnalysisResult(sampleResult, "/unwritable/dir");
    expect(returnedPath).toBeNull();
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  it("uses ANALYZE_CHANNEL_OUTPUT_DIR env var as default output dir", () => {
    process.env["ANALYZE_CHANNEL_OUTPUT_DIR"] = "/env/custom/output";
    const returnedPath = persistAnalysisResult(sampleResult); // no explicit outputDir — reads env var

    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith("/env/custom/output", { recursive: true });
    expect(returnedPath).toMatch(/^\/env\/custom\/output\//);
  });
});
