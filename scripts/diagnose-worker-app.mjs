import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const appName = (process.env.CHATGPT2CODEX_WORKER_APP_NAME || "ChatGPT To Codex Worker").trim();
const profileDir = process.env.CHATGPT2CODEX_WORKER_PROFILE_DIR
  || path.join(os.homedir(), ".local", "share", "chatgpt2codex", "agents", "chrome-worker-profile");
const activePortFile = path.join(profileDir, "DevToolsActivePort");

function fail(message) {
  console.error(`[worker-app-diagnostic] ${message}`);
  process.exitCode = 1;
}

let activePort;
try {
  const raw = await readFile(activePortFile, "utf8");
  activePort = Number.parseInt(raw.trim().split(/\r?\n/)[0] || "", 10);
} catch (error) {
  fail(`Could not read ${activePortFile}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit();
}

if (!Number.isInteger(activePort) || activePort <= 0) {
  fail(`Invalid Chrome DevTools port in ${activePortFile}`);
  process.exit();
}

let targets;
try {
  const response = await fetch(`http://127.0.0.1:${activePort}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  targets = await response.json();
} catch (error) {
  fail(`Could not query worker Chrome on port ${activePort}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit();
}

const pages = Array.isArray(targets)
  ? targets.filter((target) => target?.type === "page" && typeof target?.webSocketDebuggerUrl === "string")
  : [];
const chatgptPages = pages.filter((target) => typeof target.url === "string" && target.url.startsWith("https://chatgpt.com/"));

if (chatgptPages.length === 0) {
  console.log(JSON.stringify({
    appName,
    devtoolsPort: activePort,
    chatgptTargets: 0,
    pageTargets: pages.map((target) => ({ id: target.id, url: target.url, title: target.title })).slice(0, 20),
  }, null, 2));
  process.exit();
}

function evaluateTarget(target) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("CDP connection timed out"));
    }, 5000);

    socket.addEventListener("open", () => {
      clearTimeout(timer);
      const expression = `(() => {
        const appName = ${JSON.stringify(appName)};
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLocaleLowerCase();
        const expected = normalize(appName);
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const suggestionSelector = '[role="listbox"], [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper], [data-floating-ui-portal]';
        const composer = document.querySelector('#prompt-textarea');
        const composerValue = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
          ? composer.value
          : (composer?.textContent || '');
        const describe = (element) => ({
          tag: element.tagName,
          role: element.getAttribute('role'),
          ariaLabel: element.getAttribute('aria-label'),
          title: element.getAttribute('title'),
          dataTestId: element.getAttribute('data-testid'),
          text: String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
          insideComposer: Boolean(composer && (element === composer || composer.contains(element))),
          insideSuggestionRoot: Boolean(element.closest(suggestionSelector)),
          parentTags: (() => {
            const values = [];
            let current = element.parentElement;
            for (let i = 0; current && i < 6; i += 1, current = current.parentElement) {
              values.push({
                tag: current.tagName,
                role: current.getAttribute('role'),
                dataTestId: current.getAttribute('data-testid'),
                className: typeof current.className === 'string' ? current.className.slice(0, 120) : '',
              });
            }
            return values;
          })(),
        });
        const visibleElements = Array.from(document.querySelectorAll('*')).filter(visible);
        const exactMatches = visibleElements.filter((element) => {
          const labels = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')];
          return labels.some((label) => normalize(label) === expected);
        }).slice(0, 20).map(describe);
        const containingMatches = visibleElements.filter((element) => {
          const text = normalize(element.textContent);
          return text.includes(expected) && text !== expected && text.length <= expected.length + 80;
        }).slice(0, 20).map(describe);
        const suggestionRoots = Array.from(document.querySelectorAll(suggestionSelector))
          .filter(visible)
          .slice(0, 10)
          .map((root) => ({
            tag: root.tagName,
            role: root.getAttribute('role'),
            text: String(root.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
          }));
        return {
          url: location.href,
          title: document.title,
          composer: {
            exists: Boolean(composer),
            length: composerValue.length,
            equalsTypedMention: composerValue.trim() === '@' + appName,
            containsAppName: normalize(composerValue).includes(expected),
          },
          exactMatches,
          containingMatches,
          suggestionRoots,
        };
      })()`;
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true },
      }));
    }, { once: true });

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        if (message.id !== 1) return;
        socket.close();
        if (message.error) reject(new Error(message.error.message || "Runtime.evaluate failed"));
        else resolve(message.result?.result?.value ?? null);
      } catch (error) {
        socket.close();
        reject(error);
      }
    });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed")), { once: true });
  });
}

const results = [];
for (const target of chatgptPages) {
  try {
    results.push({
      target: { id: target.id, url: target.url, title: target.title },
      dom: await evaluateTarget(target),
    });
  } catch (error) {
    results.push({
      target: { id: target.id, url: target.url, title: target.title },
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify({
  appName,
  devtoolsPort: activePort,
  chatgptTargets: chatgptPages.length,
  results,
}, null, 2));
