'use strict';
/**
 * lib.js
 * Shared helpers used by both map.js (map a page, save dom.json) and
 * interact.js (replay actions against a previously mapped page in a fresh
 * browser session). Keeping this in one place means both scripts agree on
 * selector generation, categorization, and upload/file-chooser handling.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Runs inside the page context via page.evaluate. Walks the live DOM after
// JS execution and builds a structured tree (tag, id, classes, text, role,
// bounding box, a stable-ish CSS selector, interactive-ness).
function extractTree() {
  const MAX_TEXT = 80;
  const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'FORM']);

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function shortText(el) {
    const t = (el.innerText || el.value || el.placeholder || '').trim().replace(/\s+/g, ' ');
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '…' : t;
  }

  // Builds a selector that can be reused later — in a *different* page
  // load/session — to re-find this element. #id is used when available;
  // otherwise an nth-of-type path up to <body>.
  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let selector = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(selector);
      node = parent;
    }
    return 'body > ' + parts.join(' > ');
  }

  function walk(el, depth) {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META'].includes(tag)) return null;

    const rect = el.getBoundingClientRect();
    const visible = isVisible(el);
    const interactive = INTERACTIVE_TAGS.has(tag) || el.hasAttribute('onclick') || el.getAttribute('role') === 'button';

    const node = {
      tag: tag.toLowerCase(),
      id: el.id || undefined,
      classes: el.className && typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : undefined,
      role: el.getAttribute('role') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      name: el.getAttribute('name') || undefined,
      type: el.getAttribute('type') || undefined,
      href: tag === 'A' ? el.getAttribute('href') || undefined : undefined,
      text: shortText(el) || undefined,
      sel: cssPath(el),
      visible,
      interactive,
      bbox: visible ? {
        x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height)
      } : undefined,
      children: []
    };

    for (const child of el.children) {
      const c = walk(child, depth + 1);
      if (c) node.children.push(c);
    }
    return node;
  }

  return walk(document.body, 0);
}

function flattenInteractive(node, list = []) {
  if (!node) return list;
  if (node.interactive && node.visible) {
    list.push({
      tag: node.tag, id: node.id, classes: node.classes, role: node.role,
      ariaLabel: node.ariaLabel, name: node.name, type: node.type,
      href: node.href, text: node.text, bbox: node.bbox, sel: node.sel
    });
  }
  (node.children || []).forEach(c => flattenInteractive(c, list));
  return list;
}

function countNodes(node) {
  if (!node) return 0;
  return 1 + (node.children || []).reduce((sum, c) => sum + countNodes(c), 0);
}

// Attaches request/response listeners to a page and returns a live array
// that fills up with entries as traffic happens. Attach BEFORE goto() so
// the initial page load is captured too, not just later interactions.
function attachNetworkLogging(page) {
  const log = [];
  const byRequest = new Map();

  page.on('request', (req) => {
    const entry = {
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      requestHeaders: req.headers(),
      postDataSize: (() => { try { const d = req.postData(); return d ? d.length : 0; } catch { return 0; } })(),
      startedAt: new Date().toISOString(),
      status: null,
      statusText: null,
      responseHeaders: null,
      durationMs: null,
      failed: null,
    };
    byRequest.set(req, entry);
    log.push(entry);
  });

  page.on('response', (res) => {
    const req = res.request();
    const entry = byRequest.get(req);
    if (!entry) return;
    entry.status = res.status();
    entry.statusText = res.statusText();
    entry.responseHeaders = res.headers();
    entry.durationMs = Date.now() - Date.parse(entry.startedAt);
  });

  page.on('requestfailed', (req) => {
    const entry = byRequest.get(req);
    if (!entry) return;
    const failure = req.failure();
    entry.failed = failure ? failure.errorText : 'failed';
  });

  return log;
}

// Path to a throwaway 1x1 PNG, generated on first use, for upload actions
// where the caller doesn't care what the file contains.
function placeholderImagePath() {
  const filePath = path.join(os.tmpdir(), 'domap-test-upload.png');
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    ));
  }
  return filePath;
}

// Uploads a file at `selector`, handling both cases:
//  1. A bare <input type="file">: setInputFiles works directly, no dialog
//     ever opens.
//  2. A button/link/div that *triggers* a native OS file-chooser dialog
//     when clicked (e.g. a styled "Upload Image" button wired to a hidden
//     file input, or one opened via JS). Clicking this blind would open a
//     real native dialog that headless/remote Chromium can never dismiss —
//     the click just hangs until the remote session's own idle timeout
//     kills it. Playwright avoids that by intercepting the dialog at the
//     CDP level, but only if a 'filechooser' listener is registered in
//     parallel with the click, per Playwright's docs.
async function performUpload(page, selector, filePath) {
  const info = await page.$eval(selector, (el) => ({
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute('type') || '').toLowerCase(),
  })).catch(() => null);

  if (info && info.tag === 'input' && info.type === 'file') {
    await page.setInputFiles(selector, filePath);
    return 'input';
  }

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 8000 }),
    page.click(selector),
  ]);
  await chooser.setFiles(filePath);
  return 'filechooser';
}

// Sorts an interactive element into the bucket that determines its default
// action and which menu section it shows up under.
function categorize(el) {
  const tag = el.tag;
  const type = (el.type || '').toLowerCase();
  if (tag === 'input' && type === 'file') return 'upload';
  if (tag === 'textarea' || (tag === 'input' && !['submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'].includes(type))) return 'text';
  if (tag === 'button' || tag === 'a' || (tag === 'input' && ['submit', 'button', 'image'].includes(type)) || el.role === 'button') return 'click';
  return 'other';
}

function elementLabel(el) {
  return el.text || el.ariaLabel || el.name || el.id || '(no label)';
}

// Prints the categorized element menu to the console. Pure/offline — takes
// an already-loaded `interactive` array, no page/browser needed.
function printElementMenu(interactive) {
  const grouped = { upload: [], text: [], click: [], other: [] };
  interactive.forEach((el, i) => grouped[categorize(el)].push({ ...el, idx: i }));

  const printGroup = (label, arr) => {
    if (!arr.length) return;
    console.log(label);
    arr.forEach((el) => {
      console.log(`  [${el.idx}] <${el.tag}${el.type ? ' type=' + el.type : ''}> ${elementLabel(el)}`);
    });
    console.log('');
  };
  printGroup('\ud83d\udce4 Upload targets:', grouped.upload);
  printGroup('\u2328\ufe0f  Text fields:', grouped.text);
  printGroup('\ud83d\uddb1\ufe0f  Clickable:', grouped.click);
  printGroup('\u2753 Other interactive:', grouped.other);
}

// Connects to the configured Browserless.io endpoint and returns a
// Playwright `browser` handle. Handles the Termux/Android platform spoof
// that playwright-chromium needs to even require() cleanly.
async function connectBrowserless() {
  // playwright-core throws "Unsupported platform: android" the moment it's
  // require()'d on Termux — this check runs eagerly in its registry module,
  // not just when launching a bundled browser. Termux's userland is Linux
  // underneath, and we only ever use chromium.connect() (attaching to a
  // Chromium process we don't manage), which never touches Android-specific
  // binary paths. So it's safe to spoof the platform just for this require.
  const realPlatform = process.platform;
  if (realPlatform === 'android') {
    Object.defineProperty(process, 'platform', { value: 'linux' });
  }
  let chromium;
  try {
    chromium = require('playwright-chromium').chromium;
  } catch (e) {
    chromium = require('playwright').chromium;
  } finally {
    if (realPlatform === 'android') {
      Object.defineProperty(process, 'platform', { value: realPlatform });
    }
  }

  // Android/Termux can't launch Playwright's bundled browser binaries, so we
  // always connect to a remote Browserless.io session instead. Browserless
  // recommends chromium.connect() (Playwright's own server protocol) over a
  // wss://.../chromium/playwright?token=... endpoint for Playwright clients
  // — connectOverCDP() expects an http(s) endpoint it can query for a CDP
  // websocket URL, and rejects a raw wss:// URL outright.
  const wsUrl = process.env.BROWSERLESS_WS_URL || process.env.CDP_URL;
  if (!wsUrl) {
    throw new Error(
      'Missing BROWSERLESS_WS_URL. Set it to your Browserless endpoint, e.g.:\n' +
      '  wss://production-sfo.browserless.io/chromium/playwright?token=YOUR_TOKEN'
    );
  }
  try {
    return await chromium.connect(wsUrl);
  } catch (e) {
    throw new Error(`Could not connect to Browserless at ${wsUrl.replace(/token=[^&]+/, 'token=***')}: ${e.message}`);
  }
}

function buildHtmlReport(data) {
  const esc = (s) => (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderNode(node) {
    if (!node) return '';
    const attrs = [
      node.id ? `id="${esc(node.id)}"` : '',
      node.classes && node.classes.length ? `class="${esc(node.classes.join(' '))}"` : '',
      node.role ? `role="${esc(node.role)}"` : '',
    ].filter(Boolean).join(' ');
    const label = `&lt;${node.tag}${attrs ? ' ' + attrs : ''}&gt;`;
    const text = node.text ? `<span class="txt">"${esc(node.text)}"</span>` : '';
    const badge = node.interactive ? '<span class="badge">interactive</span>' : '';
    const childrenHtml = (node.children || []).map(renderNode).join('');
    const hasChildren = node.children && node.children.length > 0;
    return `<li>
      <details ${hasChildren ? '' : 'class="leaf"'}>
        <summary><code>${label}</code> ${text} ${badge}</summary>
        ${hasChildren ? `<ul>${childrenHtml}</ul>` : ''}
      </details>
    </li>`;
  }

  const interactiveRows = data.interactive.map(el => `
    <tr>
      <td><code>${esc(el.tag)}</code></td>
      <td>${esc(el.id || '')}</td>
      <td>${esc((el.classes || []).join(' '))}</td>
      <td>${esc(el.text || el.ariaLabel || '')}</td>
      <td>${esc(el.href || '')}</td>
      <td>${el.bbox ? `${el.bbox.x},${el.bbox.y} ${el.bbox.w}x${el.bbox.h}` : ''}</td>
      <td class="url-cell">${esc(el.sel || '')}</td>
    </tr>`).join('');

  const network = data.network || [];
  const networkRows = network.map(n => `
    <tr>
      <td><code>${esc(n.method)}</code></td>
      <td class="url-cell">${esc(n.url)}</td>
      <td>${esc(n.resourceType || '')}</td>
      <td>${n.status != null ? n.status : (n.failed ? 'FAILED' : 'pending')}</td>
      <td>${n.durationMs != null ? n.durationMs + 'ms' : ''}</td>
      <td>${n.postDataSize ? n.postDataSize + ' B' : ''}</td>
    </tr>`).join('');

  const actions = data.actions || [];
  const actionsRows = actions.map(a => `
    <tr>
      <td>${esc((a.timestamp || '').replace('T', ' ').slice(0, 19))}</td>
      <td><code>${esc(a.action || '')}</code></td>
      <td>${esc(a.label || '')}</td>
      <td class="url-cell">${esc(a.selector || '')}</td>
      <td>${a.success ? '<span class="badge">ok</span>' : '<span class="badge" style="background:#8b1a1a">failed</span>'}</td>
      <td>${esc(a.error || a.file || a.value || '')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>DOM Map: ${esc(data.url)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 20px; background: #0d1117; color: #c9d1d9; }
  h1 { font-size: 18px; word-break: break-all; }
  .meta { color: #8b949e; font-size: 13px; margin-bottom: 20px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .tab { padding: 6px 14px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; cursor: pointer; }
  .tab.active { background: #1f6feb; }
  section { display: none; }
  section.active { display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #21262d; }
  th { color: #58a6ff; }
  code { background: #161b22; padding: 1px 5px; border-radius: 4px; color: #79c0ff; }
  .txt { color: #7ee787; font-size: 12px; }
  .badge { font-size: 10px; background: #238636; padding: 1px 6px; border-radius: 10px; }
  .url-cell { max-width: 420px; overflow-wrap: anywhere; color: #79c0ff; }
  ul { list-style: none; padding-left: 18px; border-left: 1px dashed #30363d; }
  summary { cursor: pointer; padding: 2px 0; }
  details.leaf summary::-webkit-details-marker { color: #484f58; }
</style></head>
<body>
  <h1>${esc(data.url)}</h1>
  <div class="meta">Captured ${esc(data.timestamp)} • ${data.totalNodes} DOM nodes • ${data.interactive.length} interactive elements • ${network.length} network requests • ${actions.length} actions performed</div>
  <div class="tabs">
    <div class="tab active" onclick="show('tree')">Tree View</div>
    <div class="tab" onclick="show('interactive')">Interactive Elements</div>
    <div class="tab" onclick="show('network')">Network (${network.length})</div>
    <div class="tab" onclick="show('actions')">Actions (${actions.length})</div>
  </div>
  <section id="tree" class="active"><ul>${renderNode(data.tree)}</ul></section>
  <section id="interactive">
    <table>
      <tr><th>Tag</th><th>ID</th><th>Classes</th><th>Text / Label</th><th>Href</th><th>Position (x,y w×h)</th><th>Selector</th></tr>
      ${interactiveRows}
    </table>
  </section>
  <section id="network">
    <table>
      <tr><th>Method</th><th>URL</th><th>Type</th><th>Status</th><th>Duration</th><th>Post size</th></tr>
      ${networkRows}
    </table>
  </section>
  <section id="actions">
    <table>
      <tr><th>Time</th><th>Action</th><th>Element</th><th>Selector</th><th>Result</th><th>Detail</th></tr>
      ${actionsRows}
    </table>
  </section>
  <script>
    function show(id) {
      document.querySelectorAll('section').forEach(s => s.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      event.target.classList.add('active');
    }
  </script>
</body></html>`;
}

module.exports = {
  extractTree,
  flattenInteractive,
  countNodes,
  attachNetworkLogging,
  placeholderImagePath,
  performUpload,
  categorize,
  elementLabel,
  printElementMenu,
  connectBrowserless,
  buildHtmlReport,
};
