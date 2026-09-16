import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const appName = (process.env.CHATGPT2CODEX_WORKER_APP_NAME || "ChatGPT To Codex Worker").trim();
const profileDir = process.env.CHATGPT2CODEX_WORKER_PROFILE_DIR || path.join(os.homedir(), ".local", "share", "chatgpt2codex", "agents", "chrome-worker-profile");
const port = Number.parseInt((await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/)[0] || "", 10);
if (!Number.isInteger(port) || port <= 0) throw new Error("Invalid worker Chrome DevTools port");

const opened = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("https://chatgpt.com/")}`, { method: "PUT", signal: AbortSignal.timeout(5000) });
if (!opened.ok) throw new Error(`Could not open ChatGPT tab: HTTP ${opened.status}`);
const target = await opened.json();
if (!target?.webSocketDebuggerUrl) throw new Error("Chrome target has no DevTools WebSocket URL");

const socket = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const commandId = ++id;
  const timer = setTimeout(() => { pending.delete(commandId); reject(new Error(`Timeout: ${method}`)); }, 10000);
  pending.set(commandId, { resolve, reject, timer });
  socket.send(JSON.stringify({ id: commandId, method, params }));
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id); clearTimeout(item.timer);
  if (message.error) item.reject(new Error(message.error.message || "CDP error")); else item.resolve(message.result || {});
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed")), { once: true });
});
await send("Runtime.enable");

let ready = false;
for (let n = 0; n < 60; n += 1) {
  const r = await send("Runtime.evaluate", { expression: `Boolean(document.querySelector('#prompt-textarea'))`, returnByValue: true });
  if (r?.result?.value === true) { ready = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!ready) throw new Error("ChatGPT composer not available; confirm worker profile is signed in");

const focus = await send("Runtime.evaluate", {
  expression: `(() => { const c=document.querySelector('#prompt-textarea'); if(!(c instanceof HTMLElement)) return false; c.focus(); return true; })()`,
  returnByValue: true,
});
if (focus?.result?.value !== true) throw new Error("ChatGPT composer was not focusable");

// Clear whatever ChatGPT left in the fresh composer. Do this through normal
// keyboard editing first so ProseMirror updates its own state.
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
await new Promise((resolve) => setTimeout(resolve, 100));

// If the editor still exposes residual text, clear it only for this disposable
// diagnostic tab. No message is ever submitted by this script.
await send("Runtime.evaluate", {
  expression: `(() => {
    const c=document.querySelector('#prompt-textarea');
    if(!(c instanceof HTMLElement)) return false;
    if((c.textContent||'').trim()) {
      c.textContent='';
      c.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'deleteContentBackward', data:null }));
    }
    c.focus();
    return true;
  })()`,
  returnByValue: true,
});

await send("Input.insertText", { text: `@${appName}` });
await new Promise((resolve) => setTimeout(resolve, 1200));

const result = await send("Runtime.evaluate", { expression: `(() => {
  const expected=${JSON.stringify(appName)}.toLocaleLowerCase();
  const c=document.querySelector('#prompt-textarea');
  const visible=(e)=>e instanceof HTMLElement&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
  const norm=(v)=>String(v||'').replace(/\\s+/g,' ').trim().toLocaleLowerCase();
  const describe=(e)=>({tag:e.tagName,role:e.getAttribute('role'),ariaLabel:e.getAttribute('aria-label'),dataTestId:e.getAttribute('data-testid'),text:norm(e.textContent).slice(0,300),className:typeof e.className==='string'?e.className.slice(0,160):'',parents:(()=>{const a=[];let p=e.parentElement;for(let i=0;p&&i<6;i++,p=p.parentElement)a.push({tag:p.tagName,role:p.getAttribute('role'),dataTestId:p.getAttribute('data-testid'),className:typeof p.className==='string'?p.className.slice(0,120):''});return a;})()});
  const all=[...document.querySelectorAll('*')].filter(visible).filter(e=>!(c&&(e===c||c.contains(e))));
  const matches=all.filter(e=>norm(e.textContent).includes(expected)&&norm(e.textContent).length<=expected.length+140).slice(0,40).map(describe);
  const interactive=all.filter(e=>{const t=norm(e.textContent);return t.includes(expected)&&(e.getAttribute('role')||e.tagName==='BUTTON'||e.tagName==='A');}).slice(0,40).map(describe);
  return {url:location.href,composerText:norm(c?.textContent),matches,interactive};
})()`, returnByValue: true });

console.log(JSON.stringify({ appName, devtoolsPort: port, target: { id: target.id, url: target.url }, dom: result?.result?.value ?? null }, null, 2));
console.error("[worker-picker-diagnostic] Tab left open. No app selected; no message submitted.");
socket.close();
