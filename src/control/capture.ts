import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DomainError, ErrorCode } from "../types.js";
import { captureE2eAppScreenshot, captureE2eScreenshot, type E2eScreenshotResult } from "../e2e/local-e2e.js";
import { withComputerUseActivity, withComputerUseIndicatorSuppressed } from "./activity-indicator.js";
import * as winNative from "./win-native.js";

export interface ControlScreenshotResult extends E2eScreenshotResult {
  dpi?: number;
  scaleFactor?: number;
  captureMethod?: "print-window" | "screen-region";
}

function slug(value: string): string {
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return clean || "control";
}

async function screenshotDir(projectRoot: string): Promise<string> {
  const root = await fs.realpath(projectRoot);
  const dir = path.join(root, ".chatgpt2codex", "e2e", "screenshots");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function captureControlAppScreenshot(
  projectRoot: string,
  input: { appName: string; label?: string; waitMs?: number },
): Promise<ControlScreenshotResult> {
  if (process.platform !== "win32") {
    return captureE2eAppScreenshot(projectRoot, input);
  }

  return withComputerUseActivity(async () => {
    if (input.waitMs && input.waitMs > 0) {
      await delay(Math.min(input.waitMs, 30_000));
    }
    const dir = await screenshotDir(projectRoot);
    const file = path.join(dir, `${Date.now()}-${slug(input.label ?? input.appName)}.png`);

    // WDA_EXCLUDEFROMCAPTURE is applied to the indicator windows themselves,
    // but CopyFromScreen/driver behavior is not uniform across Windows builds
    // and VMs. Hide the cosmetic overlay during the actual pixel read as a
    // second line of defense, then restore it while the activity scope stays
    // alive. This never changes control authorization.
    const captured = await withComputerUseIndicatorSuppressed(() => winNative.captureAppWindow(input.appName, file));
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0) {
      await fs.unlink(file).catch(() => undefined);
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Windows app-window capture returned an empty image", {
        appName: input.appName,
      });
    }
    return {
      path: file,
      bytes: stat.size,
      opened: false,
      captureMode: "app-window",
      targetAppName: input.appName,
      shotLabel: input.label,
      dpi: captured.dpi,
      scaleFactor: captured.scaleFactor,
      captureMethod: captured.captureMethod,
    };
  });
}

export async function captureControlScreenScreenshot(
  projectRoot: string,
  input: { label?: string; waitMs?: number },
): Promise<ControlScreenshotResult> {
  // M3 deliberately does not add unrestricted Windows full-screen capture.
  // The remotely exposed path already rejects it for privacy, and local-only
  // Windows full-screen observation can be added later if it gets a separate
  // privacy model. Preserve the existing macOS implementation unchanged.
  if (process.platform === "win32") {
    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      "Windows Computer Use requires an explicit appName for screenshots; unrestricted full-screen capture is not enabled",
    );
  }
  return captureE2eScreenshot(projectRoot, input);
}
