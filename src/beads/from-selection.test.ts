import { describe, expect, it } from "vitest";
import {
  MAX_SNIPPET_LINES,
  SOURCE_FILE_KEY,
  SOURCE_LINES_KEY,
  buildBeadInput,
  buildSelectionDescription,
  formatLocation,
  lineRange,
  suggestTitle,
  type CodeSelectionContext,
} from "./from-selection.ts";

const ctx = (over: Partial<CodeSelectionContext> = {}): CodeSelectionContext => ({
  file: "src/foo.ts",
  startLine: 10,
  endLine: 20,
  selectedText: "const x = 1;\nconst y = 2;",
  languageId: "typescript",
  ...over,
});

describe("lineRange / formatLocation", () => {
  it("renders a multi-line range", () => {
    expect(lineRange(ctx())).toBe("10-20");
    expect(formatLocation(ctx())).toBe("src/foo.ts:10-20");
  });

  it("collapses a single line to one number", () => {
    expect(lineRange(ctx({ startLine: 10, endLine: 10 }))).toBe("10");
    expect(formatLocation(ctx({ startLine: 7, endLine: 7 }))).toBe("src/foo.ts:7");
  });
});

describe("suggestTitle", () => {
  it("defaults the title to the location reference", () => {
    expect(suggestTitle(ctx({ startLine: 3, endLine: 5 }))).toBe("src/foo.ts:3-5");
  });
});

describe("buildSelectionDescription", () => {
  it("leads with the source location and fences the snippet with its language", () => {
    const md = buildSelectionDescription(ctx());
    expect(md).toContain("**Source:** `src/foo.ts:10-20`");
    expect(md).toContain("```typescript\nconst x = 1;\nconst y = 2;\n```");
  });

  it("omits the language tag when none is known", () => {
    const md = buildSelectionDescription(ctx({ languageId: undefined, selectedText: "plain" }));
    expect(md).toContain("```\nplain\n```");
  });

  it("widens the fence past backtick runs inside the snippet", () => {
    const md = buildSelectionDescription(ctx({ languageId: undefined, selectedText: "a ``` b" }));
    // A 3-backtick run inside forces a 4-backtick fence so the block can't break out.
    expect(md).toContain("````\na ``` b\n````");
  });

  it("trims trailing blank lines from the snippet", () => {
    const md = buildSelectionDescription(ctx({ languageId: undefined, selectedText: "code\n\n  \n" }));
    expect(md).toContain("```\ncode\n```");
  });

  it("drops the snippet block when the selection is blank", () => {
    const md = buildSelectionDescription(ctx({ selectedText: "   \n\t" }));
    expect(md).toBe("**Source:** `src/foo.ts:10-20`");
    expect(md).not.toContain("```");
  });

  it("clamps an oversized selection and notes how many lines were hidden", () => {
    const lines = Array.from({ length: MAX_SNIPPET_LINES + 5 }, (_, i) => `line ${i + 1}`);
    const md = buildSelectionDescription(ctx({ languageId: undefined, selectedText: lines.join("\n") }));
    expect(md).toContain(`line ${MAX_SNIPPET_LINES}`);
    expect(md).not.toContain(`line ${MAX_SNIPPET_LINES + 1}`);
    expect(md).toContain("_…5 more lines not shown._");
  });

  it("uses the singular form when exactly one line is hidden", () => {
    const lines = Array.from({ length: MAX_SNIPPET_LINES + 1 }, (_, i) => `line ${i + 1}`);
    const md = buildSelectionDescription(ctx({ languageId: undefined, selectedText: lines.join("\n") }));
    expect(md).toContain("_…1 more line not shown._");
  });
});

describe("buildBeadInput", () => {
  it("carries the title, the auto-attached description and provenance metadata", () => {
    const input = buildBeadInput(ctx(), "Fix the off-by-one");
    expect(input.title).toBe("Fix the off-by-one");
    expect(input.description).toContain("**Source:** `src/foo.ts:10-20`");
    expect(input.metadata).toEqual({
      [SOURCE_FILE_KEY]: "src/foo.ts",
      [SOURCE_LINES_KEY]: "10-20",
    });
  });

  it("records a single-line range in metadata", () => {
    const input = buildBeadInput(ctx({ startLine: 42, endLine: 42 }), "Note");
    expect(input.metadata?.[SOURCE_LINES_KEY]).toBe("42");
  });
});
