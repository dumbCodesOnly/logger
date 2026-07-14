#!/usr/bin/env node
/**
 * map.js
 * Renders a URL in headless Chromium, walks the live DOM after JS execution,
 * and dumps a structured tree (tag, id, classes, text, role, bounding box,
 * a stable CSS selector, interactive-ness) to JSON plus a human-browsable
 * HTML report.
 *
 * Usage:
 *   node map.js --url https://example.com --depth 0 --wait-selector "#app" --out ./reports/example
 *
 * Every interactive element gets a saved CSS selector, so you can plan and
 * run click/fill/upload actions against this exact map LATER, in a fresh
 * browser session, with interact.js:
 *   node interact.js --report ./reports/example
 * That two-phase split exists on purpose: planning what to click/type/
 * upload takes as long as you need with no browser connected (so there's no
 * idle-timeout risk), and the actual browser session only opens once you're
 * ready to run, staying alive just long enough to replay the queue.
 *
 * Non-interactive scripted upload (for one-shot automation/CI, no prompts):
 *   node map.js --url https://example.com --upload-selector "#avatar" \
 *     --upload-file ./test.jpg --click-after-upload "#submit" --out ./reports/example
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
const {
  extractTree,
  flattenInteractive,
  countNodes,
  attachNetworkLogging,
  placeholderImagePath,
  performUpload,
  connectBrowserless,
  buildHtmlReport,
} = require('./lib');

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

// Finds a file input (by selector, or the first <input type="file"> on the
// page if no selector given), uploads a file into it, and optionally clicks
// a submit/upload button afterward. If no file is given, a throwaway 1x1
// PNG is generated so the interaction can still be exercised end-to-end.
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

    const filePath = uploadFile || placeholderImagePath();
    result.file = filePath;
    result.attempted = true;
    result.method = await performUpload(page, selector, filePath);
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

async function mapUrl(browser, url, waitSelector, interactionOpts = {}) {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } }); // typical phone viewport
  page.setDefaultTimeout(30000);

  // Attach BEFORE goto so the initial page load's requests are captured too.
  const network = attachNetworkLogging(page);

  await page.goto(url, { waitUntil: 'networkidle' });
  if (waitSelector) {
    try { await page.waitForSelector(waitSelector, { timeout: 10000 }); } catch (e) { /* continue anyway */ }
  }

  const title = await page.title();
  let tree = await page.evaluate(extractTree);
  const actions = [];

  const { uploadSelector, uploadFile, clickAfterUpload } = interactionOpts;
  if (uploadSelector || uploadFile || clickAfterUpload) {
    const uploadResult = await attemptImageUpload(page, { uploadSelector, uploadFile, clickAfterUpload });
    actions.push({
      timestamp: new Date().toISOString(),
      selector: uploadResult.selector,
      action: 'upload',
      label: '',
      file: uploadResult.file,
      success: uploadResult.success,
      error: uploadResult.error,
      clicked: uploadResult.clicked,
    });
    tree = await page.evaluate(extractTree); // re-extract so the report reflects any resulting DOM change
  }

  await page.close().catch(() => {});
  return { title, tree, network, actions };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('Missing --url');
    process.exit(1);
  }
  fs.mkdirSync(args.out, { recursive: true });

  let browser;
  try {
    browser = await connectBrowserless();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  try {
    const context = await browser.newContext();
    const { title, tree, network, actions } = await mapUrl(context, args.url, args.waitSelector, {
      uploadSelector: args.uploadSelector,
      uploadFile: args.uploadFile,
      clickAfterUpload: args.clickAfterUpload,
    });
    const interactive = flattenInteractive(tree);
    const data = {
      url: args.url,
      title,
      timestamp: new Date().toISOString(),
      totalNodes: countNodes(tree),
      interactive,
      network,
      actions,
      tree
    };

    fs.writeFileSync(path.join(args.out, 'dom.json'), JSON.stringify(data, null, 2));
    fs.writeFileSync(path.join(args.out, 'network.json'), JSON.stringify(network, null, 2));
    fs.writeFileSync(path.join(args.out, 'report.html'), buildHtmlReport(data));

    console.log(`\nPage title: ${title}`);
    console.log(`Total DOM nodes: ${data.totalNodes}`);
    console.log(`Interactive elements: ${interactive.length}`);
    console.log(`Network requests logged: ${network.length}`);
    if (actions.length) {
      console.log(`Actions performed: ${actions.length} (${actions.filter(a => a.success).length} succeeded)`);
    }
    console.log(`JSON: ${path.join(args.out, 'dom.json')}`);
    console.log(`Network: ${path.join(args.out, 'network.json')}`);
    console.log(`HTML: ${path.join(args.out, 'report.html')}`);
    console.log(`\nTo click/fill/upload into elements on this page later (in a fresh session), run:`);
    console.log(`  node interact.js --report ${args.out}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
