import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const appName = (process.env.CHATGPT2CODEX_WORKER_APP_NAME || "ChatGPT To Codex Worker").trim();
const profileDir = process.env.CHATGPT2CODEX_WORKER_PROFILE_DIR || path.join(
  os.homedir(), ".local", "share", "chatgpt2codex", "agents", "chrome-worker-profile",
);
const port = Number.parseInt(
  (await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/)[0] || "",
  10,
);
if (!Number.isInteger(port) || port <= 0) throw new Error("Invalid worker Chrome DevTools port");

const opened = await fetch(
  `http://127.0.0.1:${port}/json/new?${encodeURIComponent("https://chatgpt.com/")}`,
  { method: "PUT", signal: AbortSignal.timeout(5000) },
);
if (!opened.ok) throw new Error(`Could not open ChatGPT tab: HTTP ${opened.status}`);
const target = await opened.json();
if (!target?.webSocketDebuggerUrl) throw new Error("Chrome target has no DevTools WebSocket URL");

const socket = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const commandId = ++id;
  const timer = setTimeout(() => {
    pending.delete(commandId);
    reject(new Error(`Timeout: ${method}`));
  }, 10000);
  pending.set(commandId, { resolve, reject, timer });
  socket.send(JSON.stringify({ id: commandId, method, params }));
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  clearTimeout(item.timer);
  if (message.error) item.reject(new Error(message.error.message || "CDP error"));
  else item.resolve(message.result || {});
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed")), { once: true });
});
await send("Runtime.enable");

let ready = false;
for (let n = 0; n < 60; n += 1) {
  const r = await send("Runtime.evaluate", {
    expression: `Boolean(document.querySelector('#prompt-textarea'))`,
    returnByValue: true,
  });
  if (r?.result?.value === true) {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!ready) throw new Error("ChatGPT composer not available; confirm worker profile is signed in");

await send("Runtime.evaluate", {
  expression: `(() => { const c=document.querySelector('#prompt-textarea'); if(!(c instanceof HTMLElement)) return false; c.focus(); return true; })()`,
  returnByValue: true,
});
await send("Input.insertText", { text: `@${appName}` });
await new Promise((resolve) => setTimeout(resolve, 300));

const result = await send("Runtime.evaluate", {
  expression: `(() => {
    const expected=${JSON.stringify(appName)};
    const norm=(v)=>String(v||'').replace(/\\s+/g,' ').trim().toLocaleLowerCase();
    const expectedText=norm(expected);
    const rows=[...document.querySelectorAll('.popover .__menu-item')];
    const describe=(e)=>{
      const r=e.getBoundingClientRect();
      const s=getComputedStyle(e);
      const descendantExact=[...e.querySelectorAll('*')].some(child=>norm(child.textContent)===expectedText);
      return {
        text:norm(e.textContent).slice(0,180),
        boundingRect:{x:r.x,y:r.y,width:r.width,height:r.height},
        clientRects:e.getClientRects().length,
        display:s.display,
        visibility:s.visibility,
        opacity:s.opacity,
        descendantExact,
        productionVisible:r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none',
        diagnosticVisible:e.getClientRects().length>0&&s.visibility!=='hidden'&&s.display!=='none',
      };
    };
    return {
      composerText:norm(document.querySelector('#prompt-textarea')?.textContent),
      rowCount:rows.length,
      rows:rows.slice(0,8).map(describe),
    };
  })()`,
  returnByValue: true,
});

console.log(JSON.stringify({
  appName,
  devtoolsPort: port,
  target: { id: target.id, url: target.url },
  geometry: result?.result?.value ?? null,
}, null, 2));
console.error("[worker-picker-geometry-diagnostic] Tab left open. No app selected; no message submitted.");
socket.close();
