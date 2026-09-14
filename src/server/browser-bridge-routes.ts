import express, { type Express, type Request, type Response } from "express";
import { DomainError } from "../types.js";
import {
  BrowserLaunchBroker,
  type BrowserLaunchAcknowledgement,
} from "../agents/browser-bridge.js";

export const BROWSER_WORKER_BOOTSTRAP_PREFIX = "/browser-worker/bootstrap";
export const BROWSER_WORKER_CLAIM_PREFIX = "/browser-worker/claim";
export const BROWSER_WORKER_ACK_PREFIX = "/browser-worker/ack";

export interface BrowserBridgeRouteOptions {
  broker: BrowserLaunchBroker;
  port: number;
}

function loopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function loopbackHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  try {
    const parsed = new URL(`http://${hostHeader}`);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]" && hostname !== "::1") {
      return false;
    }
    if (port > 0 && parsed.port !== String(port)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Both checks are intentional. A public tunnel may connect to the local
 * server from loopback, so remoteAddress alone cannot make this private.
 * Requiring a loopback Host keeps these routes unreachable through the public
 * tunnel hostname as well.
 */
export function isLoopbackBrowserBridgeRequest(input: {
  host?: string;
  remoteAddress?: string;
  port: number;
}): boolean {
  return loopbackAddress(input.remoteAddress) && loopbackHost(input.host, input.port);
}

function requireLoopback(req: Request, res: Response, port: number): boolean {
  if (
    !isLoopbackBrowserBridgeRequest({
      host: req.headers.host,
      remoteAddress: req.socket.remoteAddress,
      port,
    })
  ) {
    res.status(404).type("text/plain").send("Not found");
    return false;
  }
  res.setHeader("Cache-Control", "no-store");
  return true;
}

function bridgeError(res: Response, error: unknown): void {
  if (error instanceof DomainError) {
    res.status(403).json({ ok: false, error: error.code });
    return;
  }
  res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
}

/**
 * Install the private local bridge used by a browser extension/controller.
 * These routes must be registered before the normal public-MCP Origin
 * middleware. They have their own stricter loopback Host + socket check and
 * are authorized by one-time launch tickets rather than OAuth.
 */
export function registerBrowserBridgeRoutes(app: Express, options: BrowserBridgeRouteOptions): void {
  const { broker, port } = options;

  app.get(`${BROWSER_WORKER_BOOTSTRAP_PREFIX}/:ticket`, (req, res) => {
    if (!requireLoopback(req, res, port)) return;
    res
      .status(200)
      .type("html")
      .send(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>ChatGPT2Codex Worker</title></head>" +
          "<body><p>Waiting for the ChatGPT2Codex browser worker controller.</p></body></html>",
      );
  });

  app.post(`${BROWSER_WORKER_CLAIM_PREFIX}/:ticket`, (req, res) => {
    if (!requireLoopback(req, res, port)) return;
    try {
      const payload = broker.claim(String(req.params.ticket ?? ""));
      res.status(200).json({ ok: true, payload });
    } catch (error) {
      bridgeError(res, error);
    }
  });

  app.post(
    `${BROWSER_WORKER_ACK_PREFIX}/:ticket`,
    express.json({ limit: "8kb", strict: true }),
    (req, res) => {
      if (!requireLoopback(req, res, port)) return;
      try {
        const acknowledgement = broker.acknowledge(
          String(req.params.ticket ?? ""),
          req.body as BrowserLaunchAcknowledgement,
        );
        res.status(200).json({ ok: true, acknowledgement });
      } catch (error) {
        bridgeError(res, error);
      }
    },
  );
}
