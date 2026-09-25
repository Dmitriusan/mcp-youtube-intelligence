import { describe, it, expect } from "vitest";
import { getCliOutput } from "./cli.js";

describe("getCliOutput", () => {
  it("returns the version string for --version", () => {
    expect(getCliOutput(["node", "index.js", "--version"], "1.2.3")).toBe("1.2.3");
  });

  it("returns the version string for -v", () => {
    expect(getCliOutput(["node", "index.js", "-v"], "1.2.3")).toBe("1.2.3");
  });

  it("returns help text containing usage and the version for --help", () => {
    const output = getCliOutput(["node", "index.js", "--help"], "1.2.3");
    expect(output).toContain("v1.2.3");
    expect(output).toContain("Usage:");
    expect(output).toContain("analyze_channel");
  });

  it("returns help text for -h", () => {
    expect(getCliOutput(["node", "index.js", "-h"], "1.2.3")).toContain("Usage:");
  });

  it("returns null when neither flag is present (normal server-startup path)", () => {
    expect(getCliOutput(["node", "index.js"], "1.2.3")).toBeNull();
  });

  it("prefers --version over --help when both are present", () => {
    expect(getCliOutput(["node", "index.js", "--help", "--version"], "1.2.3")).toBe("1.2.3");
  });
});
