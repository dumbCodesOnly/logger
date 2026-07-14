#!/usr/bin/env node
/**
 * map.js
 * Renders a URL in headless Chromium, walks the live DOM after JS execution,
 * and dumps a structured tree (tag, id, classes, text, role, bounding box,
 * interactive-ness) to JSON plus a human-browsable HTML report.
 *
 * Usage:
 *   node map.js --url https://example.com --depth 0 --wait-selector "#app" --out ./reports/example
 *
 * On Android/Termux, Playwright cannot launch its bundled browser binaries
 * ("Unsupported platform: android"), so this script connects to a remote
 * browser instead — specifically Browserless.io's Playwright-native
 * WebSocket endpoint (wss://.../chromium/playwright?token=...), via
 * chromium.connect(). Set BROWSERLESS_WS_URL (or the legacy CDP_URL name)
 * to point at your endpoint.
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { depth: 0, waitSelector: '', out: './out' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i];
    else if (a === '--depth') args.depth = parseInt(argv[++i], 10) || 0;
    else if (a === '--wait-selector') args.waitSelector = argv[++i] || '';
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--upload-selector') args.uploadSelector = argv[++i] || '';
    else if (a === '--upload-file') args.uploadFile = argv[++i] || '';
    else if (a === '--click-after-upload') args.clickAfterUpload = argv[++i] || '';
  }
  return args;
}

// Runs inside the page context via page.evaluate
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
      href: node.href, text: node.text, bbox: node.bbox
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

// Finds a file input (by selector, or the first <input type="file"> on the
// page if no selector given), uploads a file into it via setInputFiles, and
// optionally clicks a submit/upload button afterward. If no file is given,
// a throwaway 1x1 PNG is generated so the interaction can still be exercised
// end-to-end without the caller needing to supply an image.
async function attemptImageUpload(page, { uploadSelector, uploadFile, clickAfterUpload }) {
  const result = {
    attempted: false,
    selector: uploadSelector || null,
    file: uploadFile || null,
    success: false,
    clicked: false,
    error: null,
  };

  try {
    let selector = uploadSelector;
    if (!selector) {
      const hasFileInput = await page.$('input[type="file"]');
      if (!hasFileInput) {
        result.error = 'No file input found on page (pass --upload-selector to target one explicitly)';
        return result;
      }
      selector = 'input[type="file"]';
      result.selector = selector;
    }

    let filePath = uploadFile;
    if (!filePath) {
      filePath = path.join(require('os').tmpdir(), 'domap-test-upload.png');
      if (!fs.existsSync(filePath)) {
        const onePixelPng = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64'
        );
        fs.writeFileSync(filePath, onePixelPng);
      }
      result.file = filePath;
    }

    result.attempted = true;
    await page.setInputFiles(selector, filePath);
    result.success = true;

    if (clickAfterUpload) {
      await page.click(clickAfterUpload, { timeout: 5000 });
      result.clicked = true;
      // Give any resulting XHR/fetch upload request time to fire and land
      // in the network log before we close the page.
      await page.waitForTimeout(3000);
    }
  } catch (e) {
    result.error = e.message;
  }

  return result;
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

  const upload = data.upload;
  const uploadSummary = upload ? `
    <div class="meta">
      Upload attempt: ${upload.attempted ? (upload.success ? '<span class="badge">success</span>' : '<span class="badge" style="background:#8b1a1a">failed</span>') : 'not attempted'}
      ${upload.selector ? ` • selector: <code>${esc(upload.selector)}</code>` : ''}
      ${upload.file ? ` • file: <code>${esc(upload.file)}</code>` : ''}
      ${upload.clicked ? ' • clicked follow-up button' : ''}
      ${upload.error ? ` • error: ${esc(upload.error)}` : ''}
    </div>` : '';

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
  ul { list-style: none; padding-left: 18px; border-left: 1px dashed #30363d; }
  summary { cursor: pointer; padding: 2px 0; }
  details.leaf summary::-webkit-details-marker { color: #484f58; }
</style></head>
<body>
  <h1>${esc(data.url)}</h1>
  <div class="meta">Captured ${esc(data.timestamp)} • ${data.totalNodes} DOM nodes • ${data.interactive.length} interactive elements</div>
  <div class="tabs">
    <div class="tab active" onclick="show('tree')">Tree View</div>
    <div class="tab" onclick="show('interactive')">Interactive Elements</div>
  </div>
  <section id="tree" class="active"><ul>${renderNode(data.tree)}</ul></section>
  <section id="interactive">
    <table>
      <tr><th>Tag</th><th>ID</th><th>Classes</th><th>Text / Label</th><th>Href</th><th>Position (x,y w×h)</th></tr>
      ${interactiveRows}
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

async function mapUrl(browser, url, waitSelector) {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } }); // typical phone viewport
  page.setDefaultTimeout(30000);
  await page.goto(url, { waitUntil: 'networkidle' });
  if (waitSelector) {
    try { await page.waitForSelector(waitSelector, { timeout: 10000 }); } catch (e) { /* continue anyway */ }
  }
  const title = await page.title();
  const tree = await page.evaluate(extractTree);
  await page.close();
  return { title, tree };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('Missing --url');
    process.exit(1);
  }
  fs.mkdirSync(args.out, { recursive: true });

  // playwright-core throws "Unsupported platform: android" the moment it's
  // require()'d on Termux — this check runs eagerly in its registry module,
  // not just when launching a bundled browser. Termux's userland is Linux
  // underneath, and we only ever use connectOverCDP() (attaching to a
  // Chromium process we start ourselves), which never touches Android-
  // specific binary paths. So it's safe to spoof the platform just for this
  // require, letting the module load normally.
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

  // Android/Termux can't launch Playwright's bundled browser binaries, so
  // we always connect to a remote Browserless.io session instead. Browserless
  // recommends chromium.connect() (Playwright's own server protocol) over a
  // wss://.../chromium/playwright?token=... endpoint for Playwright clients
  // — connectOverCDP() expects an http(s) endpoint it can query for a CDP
  // websocket URL, and rejects a raw wss:// URL outright.
  const wsUrl = process.env.BROWSERLESS_WS_URL || process.env.CDP_URL;
  if (!wsUrl) {
    console.error('Missing BROWSERLESS_WS_URL. Set it to your Browserless endpoint, e.g.:');
    console.error('  wss://production-sfo.browserless.io/chromium/playwright?token=YOUR_TOKEN');
    process.exit(1);
  }
  let browser;
  try {
    browser = await chromium.connect(wsUrl);
  } catch (e) {
    console.error(`Could not connect to Browserless at ${wsUrl.replace(/token=[^&]+/, 'token=***')}.`);
    console.error(`Original error: ${e.message}`);
    process.exit(1);
  }
  try {
    // connect() gives us a fresh browser instance; open a new context/page directly.
    const context = await browser.newContext();
    const { title, tree } = await mapUrl(context, args.url, args.waitSelector);
    const interactive = flattenInteractive(tree);
    const data = {
      url: args.url,
      title,
      timestamp: new Date().toISOString(),
      totalNodes: countNodes(tree),
      interactive,
      tree
    };

    fs.writeFileSync(path.join(args.out, 'dom.json'), JSON.stringify(data, null, 2));
    fs.writeFileSync(path.join(args.out, 'report.html'), buildHtmlReport(data));

    console.log(`Page title: ${title}`);
    console.log(`Total DOM nodes: ${data.totalNodes}`);
    console.log(`Interactive elements: ${interactive.length}`);
    console.log(`JSON: ${path.join(args.out, 'dom.json')}`);
    console.log(`HTML: ${path.join(args.out, 'report.html')}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
