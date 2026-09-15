import { describe, expect, it } from "vitest";
import {
  applyPonytailToWorkerTask,
  buildPonytailPolicy,
  resolvePonytailTask,
} from "./ponytail.js";

describe("agents/ponytail", () => {
  it("defaults coding tasks to FULL mode", () => {
    const resolved = resolvePonytailTask("Fix the parser");
    expect(resolved).toEqual({ mode: "full", task: "Fix the parser" });
    const prompt = applyPonytailToWorkerTask("Fix the parser");
    expect(prompt).toContain("Ponytail coding policy (FULL)");
    expect(prompt).toContain("Fix the parser");
  });

  it("accepts slash and plain task-local mode directives on the first non-empty line", () => {
    expect(resolvePonytailTask("\n/ponytail ultra\nReduce duplicated adapters")).toEqual({
      mode: "ultra",
      task: "Reduce duplicated adapters",
    });
    expect(resolvePonytailTask("ponytail lite\r\nImplement the compatibility path")).toEqual({
      mode: "lite",
      task: "Implement the compatibility path",
    });
  });

  it("does not reinterpret later task prose as a directive", () => {
    expect(resolvePonytailTask("Document behavior\nponytail off\nKeep this literal text")).toEqual({
      mode: "full",
      task: "Document behavior\nponytail off\nKeep this literal text",
    });
  });

  it("removes the directive and injects no Ponytail policy in OFF mode", () => {
    expect(applyPonytailToWorkerTask("/ponytail off\nImplement the requested design")).toBe(
      "Implement the requested design",
    );
    expect(buildPonytailPolicy("off")).toBe("");
  });

  it("keeps correctness and trust-boundary safeguards explicit in active modes", () => {
    for (const mode of ["lite", "full", "ultra"] as const) {
      const policy = buildPonytailPolicy(mode);
      expect(policy).toContain("trust-boundary validation");
      expect(policy).toContain("security controls");
      expect(policy).toContain("explicitly requested by the user");
    }
    expect(buildPonytailPolicy("ultra")).toContain("YAGNI aggressively");
  });
});
