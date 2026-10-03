/** Offline Chromium checks against real dashboard CSS. No API or credentials.
 * Run: CHROME_BIN=<path> bun tests/ui-consistency-browser.ts [output-dir]
 * --source uses source CSS; --baseline records issues without failing. */
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
const gui = resolve(import.meta.dir, "..");
const output = resolve(process.argv.find((arg, i) => i > 1 && !arg.startsWith("--")) ?? join(gui, ".tmp/ui-consistency-browser"));
const chrome = process.env.CHROME_BIN;
if (!chrome) throw new Error("Set CHROME_BIN to Chrome/Chromium.");
async function sourceCss(path: string): Promise<string> {
  let css = await readFile(path, "utf8");
  for (const match of [...css.matchAll(/@import "([^"]+)";/g)]) css = css.replace(match[0], await sourceCss(resolve(dirname(path), match[1])));
  return css;
}
const index = process.argv.includes("--source") ? "" : await readFile(join(gui, "dist/index.html"), "utf8");
const css = process.argv.includes("--source") ? await sourceCss(join(gui, "src/styles.css")) : await readFile(join(gui, "dist", index.match(/href="([^"]+\.css)"/)![1].replace(/^\//, "")), "utf8");
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main style="padding:16px"><h1>UI consistency fixture</h1><p>Offline sample / 中文输入 / 한국어</p><p class="mono" id="canonical">model-012345</p><div class="tbl-wrap"><table class="pws-model-table"><tbody><tr class="pws-model-row"><td class="mono" id="model">model-012345<div class="pws-model-attribution" id="attribution">Unresolved requested model / 未解析的请求模型</div></td><td class="num mono">1,234</td></tr><tr class="pws-model-detail"><td colspan="2">Expanded model detail</td></tr></tbody></table></div><label class="remote-composer">Message<textarea class="input" id="message">自然语言消息 / Hello</textarea></label><label>JSON<textarea class="input pwi-json-textarea" id="json">{ "model": "example" }</textarea></label><button class="remote-revoke" id="revoke" aria-label="Remove device">×</button></main></body></html>`;
const profile = await mkdtemp(join(tmpdir(), "ocx-sidebar-chrome-"));
const browser = Bun.spawn([chrome, "--headless", "--disable-gpu", "--disable-background-networking",
  "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  ...(process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), "about:blank"],
{ stdout: "ignore", stderr: "ignore" });
let socket: WebSocket | undefined;
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
try {
  let debugPort = "";
  const deadline = Date.now() + 10_000;
  while (!debugPort && Date.now() < deadline) {
    try { debugPort = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; }
    catch { await delay(50); }
  }
  if (!/^\d+$/.test(debugPort)) throw new Error("Chrome did not expose its local debugging port within 10 seconds.");
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Cannot create browser target: ${response.status}`);
  const target = await response.json() as { webSocketDebuggerUrl: string };
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const ws = socket;
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("CDP connection timed out")), 5_000);
    ws.addEventListener("open", () => { clearTimeout(timer); done(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); fail(new Error("CDP connection failed")); }, { once: true });
  });
  let id = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  ws.addEventListener("message", event => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id === undefined) return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
  });
  function cdp<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((done, fail) => {
      const next = ++id;
      const timer = setTimeout(() => { pending.delete(next); fail(new Error(`CDP timeout: ${method}`)); }, 5_000);
      pending.set(next, { resolve: value => { clearTimeout(timer); done(value as T); }, reject: error => { clearTimeout(timer); fail(error); } });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  }
  async function evaluate<T>(expression: string): Promise<T> {
    const result = await cdp<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  }
  await cdp("Page.enable");
  // Offline document: no proxy, management API, external assets or browser navigation.
  const { frameTree } = await cdp<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  await cdp("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate<boolean>('document.readyState === "complete" && !!document.querySelector("#message")')) break;
    if (attempt === 99) throw new Error(`Built-CSS fixture did not finish loading: ${await evaluate<string>('JSON.stringify({url:location.href,state:document.readyState,html:document.body?.innerHTML.slice(0,500)})')}`);
    await delay(25);
  }
  const cases: unknown[] = [];
  await mkdir(output, { recursive: true });
  for (const theme of ["light", "dark"]) for (const width of [375, 1280]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: width < 600 });
    await cdp("Emulation.setTouchEmulationEnabled", { enabled: width < 600 });
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await evaluate('document.querySelector("#json").focus()');
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const result = await evaluate<{ ok: boolean; [key: string]: unknown }>(`(() => {
      const style = id => getComputedStyle(document.getElementById(id));
      const body = getComputedStyle(document.body), canonical = style("canonical"), model = style("model"), message = style("message"), json = style("json"), attribution = style("attribution"), revoke = style("revoke");
      const checks = {
        modelFont: model.fontFamily === canonical.fontFamily,
        proseFont: message.fontFamily === body.fontFamily,
        jsonFont: json.fontFamily === canonical.fontFamily,
        attributionFont: attribution.fontFamily === body.fontFamily,
        keyboardFocus: document.querySelector("#revoke").matches(":focus-visible") && revoke.outlineStyle !== "none" && parseFloat(revoke.outlineWidth) >= 2,
        touchTarget: !matchMedia("(pointer: coarse)").matches || (parseFloat(revoke.width) >= 44 && parseFloat(revoke.height) >= 44),
        viewport: document.documentElement.scrollWidth <= innerWidth,
      };
      return { ok: Object.values(checks).every(Boolean), checks, fonts: {body:body.fontFamily, model:model.fontFamily, message:message.fontFamily, json:json.fontFamily}, focus:revoke.outline, target:[revoke.width,revoke.height], detailBackground:getComputedStyle(document.querySelector(".pws-model-detail")).backgroundColor };
    })()`);
    cases.push({theme, width, ...result});
    const shot = await cdp<{data:string}>("Page.captureScreenshot", {format:"png"});
    await writeFile(join(output, `${theme}-${width}.png`), Buffer.from(shot.data, "base64"));
  }
  await writeFile(join(output, "results.json"), JSON.stringify(cases, null, 2));
  console.log(JSON.stringify(cases, null, 2));
  if (!process.argv.includes("--baseline") && cases.some(row => !(row as { ok: boolean }).ok)) throw new Error("UI consistency regression; see results.json");

} finally {
  socket?.close();
  browser.kill();
  await Promise.race([browser.exited, delay(2_000)]);
  if (browser.exitCode === null) { browser.kill("SIGKILL"); await browser.exited; }
  await rm(profile, { recursive: true, force: true });
}
