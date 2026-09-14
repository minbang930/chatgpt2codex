import { describe, expect, it } from "vitest";
import { BrowserLaunchBroker, type BrowserLaunchPayload } from "./browser-bridge.js";

function payload(): BrowserLaunchPayload {
  return {
    workerId: "wrk_00000000-0000-0000-0000-000000000001",
    projectId: "project-1",
    task: "Implement the assigned task",
    workerToken: "wcap.wrk_00000000-0000-0000-0000-000000000001.secret",
    route: {
      mode: "project",
      projectRef: { url: "https://chatgpt.com/g/g-p-example/project", label: "Project One" },
    },
  };
}

describe("agents/browser-bridge", () => {
  it("hands the launch payload out exactly once", () => {
    const broker = new BrowserLaunchBroker();
    const issued = broker.issue(payload());

    expect(issued.ticket).toMatch(/^bwt_[A-Za-z0-9_-]{32,}$/);
    expect(broker.claim(issued.ticket)).toEqual(payload());
    expect(() => broker.claim(issued.ticket)).toThrow(/already claimed/);
  });

  it("requires claim before acknowledgement and accepts an idempotent retry", () => {
    const broker = new BrowserLaunchBroker();
    const { ticket } = broker.issue(payload());

    expect(() => broker.acknowledge(ticket, { status: "launched", browserHandle: "tab-1" })).toThrow(
      /must be claimed/,
    );
    broker.claim(ticket);
    expect(broker.acknowledge(ticket, { status: "launched", browserHandle: "tab-1" })).toEqual({
      status: "launched",
      browserHandle: "tab-1",
    });
    expect(broker.acknowledge(ticket, { status: "launched", browserHandle: "tab-1" })).toEqual({
      status: "launched",
      browserHandle: "tab-1",
    });
    expect(() => broker.acknowledge(ticket, { status: "launched", browserHandle: "tab-2" })).toThrow(
      /different acknowledgement/,
    );
  });

  it("supports wait-before-ack and ack-before-wait", async () => {
    const broker = new BrowserLaunchBroker();

    const first = broker.issue(payload());
    broker.claim(first.ticket);
    const waiting = broker.waitForAcknowledgement(first.ticket, 1_000);
    broker.acknowledge(first.ticket, { status: "launched", browserHandle: "tab-live", fallbackUsed: true });
    await expect(waiting).resolves.toEqual({
      status: "launched",
      browserHandle: "tab-live",
      fallbackUsed: true,
    });

    const second = broker.issue({ ...payload(), workerId: "wrk_00000000-0000-0000-0000-000000000002" });
    broker.claim(second.ticket);
    broker.acknowledge(second.ticket, { status: "failed", error: "composer unavailable" });
    await expect(broker.waitForAcknowledgement(second.ticket, 1_000)).resolves.toEqual({
      status: "failed",
      error: "composer unavailable",
    });
  });

  it("expires unclaimed tickets without relying on wall-clock sleeps", () => {
    let now = 1_000;
    const broker = new BrowserLaunchBroker({ now: () => now });
    const { ticket } = broker.issue(payload(), 50);
    now = 1_051;

    expect(() => broker.claim(ticket)).toThrow(/expired/);
    expect(() => broker.claim(ticket)).toThrow(/unknown/);
  });

  it("times out acknowledgement waits and validates bounded durations", async () => {
    const broker = new BrowserLaunchBroker();
    const { ticket } = broker.issue(payload());
    broker.claim(ticket);

    await expect(broker.waitForAcknowledgement(ticket, 5)).rejects.toThrow(/Timed out/);
    expect(() => broker.issue(payload(), 300_001)).toThrow(/ticket TTL/);
    await expect(broker.waitForAcknowledgement(ticket, 120_001)).rejects.toThrow(/acknowledgement wait/);
  });

  it("cancels a launch ticket without affecting other tickets", () => {
    const broker = new BrowserLaunchBroker();
    const first = broker.issue(payload());
    const second = broker.issue({ ...payload(), workerId: "wrk_00000000-0000-0000-0000-000000000003" });

    expect(broker.cancel(first.ticket)).toBe(true);
    expect(broker.cancel(first.ticket)).toBe(false);
    expect(() => broker.claim(first.ticket)).toThrow(/unknown/);
    expect(broker.claim(second.ticket).workerId).toBe("wrk_00000000-0000-0000-0000-000000000003");
  });
});
