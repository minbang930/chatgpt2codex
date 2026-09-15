import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetComputerUseCancelForTests,
  assertComputerUseNotRecentlyCancelled,
  computerUseCancelGeneration,
  signalComputerUseCancel,
  waitForComputerUseDelay,
  wasComputerUseCancelledSince,
} from "./cancel.js";
import { ErrorCode } from "../types.js";
import {
  __getComputerUseActivityStateForTests,
  __setComputerUseActivityDriverForTests,
  beginComputerUseActivity,
  forceHideComputerUseActivity,
  probeWindowsActivityIndicatorSupport,
  stopWindowsActivityIndicatorHelper,
  withComputerUseIndicatorSuppressed,
} from "./activity-indicator.js";

describe("control/activity-indicator lifecycle", () => {
  afterEach(async () => {
    __setComputerUseActivityDriverForTests(undefined);
    __resetComputerUseCancelForTests();
    await stopWindowsActivityIndicatorHelper();
  });

  it("shares one overlay across overlapping activity scopes and debounces the final hide", async () => {
    const calls: string[] = [];
    __setComputerUseActivityDriverForTests(
      {
        show: async () => { calls.push("show"); },
        hide: async () => { calls.push("hide"); },
      },
      { idleHideMs: 5 },
    );

    const releaseA = await beginComputerUseActivity();
    const releaseB = await beginComputerUseActivity();
    expect(calls).toEqual(["show"]);
    expect(__getComputerUseActivityStateForTests()).toEqual({ activeCount: 2, suppressCount: 0, visible: true });

    await releaseA();
    await delay(12);
    expect(calls).toEqual(["show"]);

    await releaseB();
    await delay(20);
    expect(calls).toEqual(["show", "hide"]);
    expect(__getComputerUseActivityStateForTests()).toEqual({ activeCount: 0, suppressCount: 0, visible: false });
  });

  it("temporarily hides the overlay while pixels are captured and restores it afterwards", async () => {
    const calls: string[] = [];
    __setComputerUseActivityDriverForTests(
      {
        show: async () => { calls.push("show"); },
        hide: async () => { calls.push("hide"); },
      },
      { idleHideMs: 5 },
    );

    const release = await beginComputerUseActivity();
    await withComputerUseIndicatorSuppressed(async () => {
      expect(__getComputerUseActivityStateForTests()).toEqual({ activeCount: 1, suppressCount: 1, visible: false });
    });
    expect(calls).toEqual(["show", "hide", "show"]);

    await release();
    await delay(20);
    expect(calls).toEqual(["show", "hide", "show", "hide"]);
  });

  it("force-hides immediately without letting a late scope release re-show the indicator", async () => {
    const calls: string[] = [];
    __setComputerUseActivityDriverForTests(
      {
        show: async () => { calls.push("show"); },
        hide: async () => { calls.push("hide"); },
      },
      { idleHideMs: 5 },
    );

    const release = await beginComputerUseActivity();
    await forceHideComputerUseActivity();
    expect(calls).toEqual(["show", "hide"]);
    expect(__getComputerUseActivityStateForTests()).toEqual({ activeCount: 0, suppressCount: 0, visible: false });

    await release();
    await delay(20);
    expect(calls).toEqual(["show", "hide"]);
  });

  it("records local Esc cancellation and rejects immediate follow-up control", () => {
    __resetComputerUseCancelForTests({ latchMs: 5_000 });
    const before = computerUseCancelGeneration();
    signalComputerUseCancel("escape");
    expect(wasComputerUseCancelledSince(before)).toBe(true);
    try {
      assertComputerUseNotRecentlyCancelled();
      throw new Error("expected cancellation");
    } catch (error) {
      expect((error as { code?: string }).code).toBe(ErrorCode.CONTROL_CANCELLED);
    }
  });

  it("interrupts screenshot-style waits immediately on local Esc", async () => {
    const before = computerUseCancelGeneration();
    const started = Date.now();
    const pending = waitForComputerUseDelay(5_000, before);
    setTimeout(() => signalComputerUseCancel("escape"), 20);
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.CONTROL_CANCELLED });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

});

if (process.platform === "win32") {
  describe("control/activity-indicator Windows native probe", () => {
    it("compiles the click-through overlay helper without showing any window", async () => {
      const result = await probeWindowsActivityIndicatorSupport();
      expect(result.ok).toBe(true);
      expect(result.screens).toBeGreaterThanOrEqual(0);
    }, 150_000);
  });
}
