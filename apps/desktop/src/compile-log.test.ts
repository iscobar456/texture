import { describe, expect, it } from "vitest";
import { parseCompileErrors } from "./compile-log";

describe("parseCompileErrors", () => {
  it("reads tectonic errors with their line", () => {
    const log = [
      "note: Running TeX ...",
      "error: main.tex:12: Undefined control sequence",
      "error: halted on potentially-recoverable error as specified",
      "error: ./main.tex:30: Missing $ inserted.",
      "error: main.tex:12: Undefined control sequence",
    ].join("\n");
    expect(parseCompileErrors(log)).toEqual([
      { line: 12, message: "Undefined control sequence" },
      { line: 30, message: "Missing $ inserted" },
    ]);
  });

  it("reads pdflatex errors, finding the line in the context that follows", () => {
    const log = "This is pdfTeX\n! Undefined control sequence.\n<recently read> \\foo\n\nl.7 \\foo\n       bar\n! Emergency stop.\n";
    expect(parseCompileErrors(log)).toEqual([
      { line: 7, message: "Undefined control sequence" },
      { line: null, message: "Emergency stop" },
    ]);
  });

  it("finds nothing in output without errors", () => {
    expect(parseCompileErrors("warning: main.tex:3: Overfull \\hbox\nnote: done")).toEqual([]);
  });
});
