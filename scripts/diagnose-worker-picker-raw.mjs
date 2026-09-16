import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const appName = (process.env.CHATGPT2CODEX_WORKER_APP_NAME || "ChatGPT To Codex Worker").trim();
const profileDir = process.env.CHATGPT2CODEX_WORKER_PROFILE_DIR || path.join(os.homedir(), ".local", "share", "chatgpt2codex", "agents", "chrome-worker-profile");
const port = Number.parseInt((await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/)[0] || "", 10);
if (!Number.isInteger(port) || port <= 0) throw new Error("Invalid worker Chrome DevTools port");

const opened = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("https://chatgpt.com/")}`, {
  method: "PUT",
  signal: AbortSignal.timeout(5000),
});
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

const initial = await send("Runtime.evaluate", {
  expression: `(() => {
    const c=document.querySelector('#prompt-textarea');
    if(!(c instanceof HTMLElement)) return null;
    c.focus();
    return { text:(c.textContent||''), html:c.innerHTML.slice(0,500) };
  })()`,
  returnByValue: true,
});

await send("Input.insertText", { text: `@${appName}` });

const snapshots = [];
for (let n = 0; n < 20; n += 1) {
  const r = await send("Runtime.evaluate", {
    expression: `(() => {
      const expected=${JSON.stringify(appName)};
      const norm=(v)=>String(v||'').replace(/\\s+/g,' ').trim().toLocaleLowerCase();
      const expectedText=norm(expected);
      const visible=(e)=>e instanceof HTMLElement&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
      const c=document.querySelector('#prompt-textarea');
      const roots=[...document.querySelectorAll('[role="listbox"], [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper], [data-floating-ui-portal]')].filter(visible);
      const selector='[role="option"], [role="menuitem"], [role="menuitemradio"], [data-radix-collection-item], button';
      const standard=roots.flatMap(root=>[...root.querySelectorAll(selector)]).filter(visible);
      const popover=[...document.querySelectorAll('.popover .__menu-item')].filter(visible);
      const candidates=[...new Set([...standard,...popover])];
      const hasExact=(element)=>[
        element.textContent,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        ...[...element.querySelectorAll('*')].flatMap(child=>[child.textContent,child.getAttribute('aria-label'),child.getAttribute('title')]),
      ].some(label=>norm(label)===expectedText);
      const exact=candidates.filter(hasExact);
      const prefix=exact.length===0?candidates.filter(element=>norm(element.textContent).startsWith(expectedText+' ')):[];
      const anchors=c instanceof HTMLElement?[...c.querySelectorAll('a')].filter(visible).map(a=>norm(a.textContent)):[];
      return {
        composerText:norm(c?.textContent),
        rootCount:roots.length,
        standardCount:standard.length,
        popoverCount:popover.length,
        exactCount:exact.length,
        prefixCount:prefix.length,
        exactTexts:exact.slice(0,5).map(e=>norm(e.textContent).slice(0,180)),
        popoverTexts:popover.slice(0,8).map(e=>norm(e.textContent).slice(0,180)),
        selectedAnchor:anchors.includes(expectedText),
      };
    })()`,
    returnByValue: true,
  });
  snapshots.push({ atMs: n * 100, ...(r?.result?.value || {}) });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

console.log(JSON.stringify({
  appName,
  devtoolsPort: port,
  target: { id: target.id, url: target.url },
  initial: initial?.result?.value ?? null,
  snapshots,
}, null, 2));
console.error("[worker-picker-raw-diagnostic] Tab left open. No app selected; no message submitted.");
socket.close();
