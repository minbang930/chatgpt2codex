import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserLaunchBroker } from "../agents/browser-bridge.js";
import {
  BROWSER_WORKER_ACK_PREFIX,
  BROWSER_WORKER_BOOTSTRAP_PREFIX,
  BROWSER_WORKER_CLAIM_PREFIX,
  isLoopbackBrowserBridgeRequest,
  registerBrowserBridgeRoutes,
} from "./browser-bridge-routes.js";

const servers: Server[] = [];

async function makeBridge() {
  const app = express();
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  const broker = new BrowserLaunchBroker();
  registerBrowserBridgeRoutes(app, { broker, port: address.port });
  return { broker, port: address.port };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("server/browser-bridge-routes", () => {
  it("requires both loopback socket and loopback Host", () => {
    expect(
      isLoopbackBrowserBridgeRequest({ host: "127.0.0.1:7979", remoteAddress: "127.0.0.1", port: 7979 }),
    ).toBe(true);
    expect(
      isLoopbackBrowserBridgeRequest({ host: "localhost:7979", remoteAddress: "::ffff:127.0.0.1", port: 7979 }),
    ).toBe(true);
    expect(
      isLoopbackBrowserBridgeRequest({ host: "public-tunnel.example", remoteAddress: "127.0.0.1", port: 7979 }),
    ).toBe(false);
    expect(
      isLoopbackBrowserBridgeRequest({ host: "127.0.0.1:7979", remoteAddress: "10.0.0.5", port: 7979 }),
    ).toBe(false);
    expect(
      isLoopbackBrowserBridgeRequest({ host: "127.0.0.1:9999", remoteAddress: "127.0.0.1", port: 7979 }),
    ).toBe(false);
  });

  it("serves a no-store bootstrap document without exposing the launch payload", async () => {
    const { broker, port } = await makeBridge();
    const issued = broker.issue({
      workerId: "wrk_00000000-0000-0000-0000-000000000001",
      projectId: "project-1",
      task: "sensitive task text",
      workerToken: "wcap.sensitive-worker-token",
      route: { mode: "standalone" },
    });

    const response = await fetch(`http://127.0.0.1:${port}${BROWSER_WORKER_BOOTSTRAP_PREFIX}/${issued.ticket}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("browser worker controller");
    expect(html).not.toContain("sensitive task text");
    expect(html).not.toContain("wcap.sensitive-worker-token");
  });

  it("claims the sensitive launch payload once and accepts an acknowledgement", async () => {
    const { broker, port } = await makeBridge();
    const issued = broker.issue({
      workerId: "wrk_00000000-0000-0000-0000-000000000002",
      projectId: "project-2",
      task: "Implement worker task",
      workerToken: "wcap.worker-secret",
      route: {
        mode: "project",
        projectRef: { url: "https://chatgpt.com/g/g-p-example/project" },
      },
    });

    const claim = await fetch(`http://127.0.0.1:${port}${BROWSER_WORKER_CLAIM_PREFIX}/${issued.ticket}`, {
      method: "POST",
    });
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toMatchObject({
      ok: true,
      payload: {
        workerId: "wrk_00000000-0000-0000-0000-000000000002",
        task: "Implement worker task",
        workerToken: "wcap.worker-secret",
        route: { mode: "project" },
      },
    });

    const secondClaim = await fetch(`http://127.0.0.1:${port}${BROWSER_WORKER_CLAIM_PREFIX}/${issued.ticket}`, {
      method: "POST",
    });
    expect(secondClaim.status).toBe(403);

    const ack = await fetch(`http://127.0.0.1:${port}${BROWSER_WORKER_ACK_PREFIX}/${issued.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "launched", browserHandle: "tab-42" }),
    });
    expect(ack.status).toBe(200);
    await expect(ack.json()).resolves.toMatchObject({
      ok: true,
      acknowledgement: { status: "launched", browserHandle: "tab-42" },
    });
    await expect(broker.waitForAcknowledgement(issued.ticket, 10)).resolves.toEqual({
      status: "launched",
      browserHandle: "tab-42",
    });
  });
});
