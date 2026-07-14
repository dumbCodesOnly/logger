#!/usr/bin/env node
/**
 * interact.js
 * Takes a dom.json previously produced by map.js (which stores a stable CSS
 * selector for every interactive element) and lets you plan a queue of
 * actions against it completely OFFLINE — no browser connected, so there's
 * no idle-timeout risk while you're reading menus and typing. Once you type
 * "run", it opens ONE fresh Browserless session, navigates to the page, and
 * replays the whole queue back-to-back as fast as possible, logging network
 * traffic throughout, then merges the results into the same report
 * directory (dom.json, network.json, report.html all get updated in place).
 *
 * This is deliberately a separate script/session from map.js: mapping a
 * slow or heavy page shouldn't be able to burn through the idle window you
 * need for deciding what to click, and vice versa.
 *
 * Usage:
 *   node interact.js --report ./reports/example_20260714_120000
 *   node interact.js --dom ./reports/example_20260714_120000/dom.json --url https://example.com
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  extractTree,
  flattenInteractive,
  attachNetworkLogging,
  placeholderImagePath,
  performUpload,
  categorize,
  elementLabel,
  printElementMenu,
  connectBrowserless,
  buildHtmlReport,
} = require('./lib');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report') args.report = argv[++i];
    else if (a === '--dom') args.dom = argv[++i];
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--wait-selector') args.waitSelector = argv[++i] || '';
  }
  return args;
}

// Offline planning loop: no page/browser involved at all here, so there's
// no session to time out no matter how long you spend deciding.
async function planQueue(interactive) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  const queue = [];

  console.log('\n=== Planning actions (offline \u2014 no browser connected yet) ===');
  console.log('Pick elements from the last map. We\'ll connect once you type "run".\n');

  while (true) {
    printElementMenu(interactive);
    if (queue.length) {
      console.log(`Queued so far: ${queue.map(q => `[${q.idx}] ${q.action}`).join(', ')}\n`);
    }

    const answer = (await ask('Enter a number to queue an action, "run" to execute the queue, or "cancel": ')).trim();
    if (answer === 'cancel') { rl.close(); return null; }
    if (answer === 'run') {
      if (!queue.length) { console.log('Queue is empty \u2014 add at least one action first.\n'); continue; }
      break;
    }

    const idx = parseInt(answer, 10);
    if (Number.isNaN(idx) || !interactive[idx]) {
      console.log('Invalid selection.\n');
      continue;
    }

    const el = interactive[idx];
    const category = categorize(el);
    const defaultAction = category === 'upload' ? 'upload' : category === 'text' ? 'type' : 'click';
    const actionAns = (await ask(`Action for [${idx}] ${elementLabel(el)} (upload/type/click) [${defaultAction}]: `)).trim() || defaultAction;

    const item = { idx, selector: el.sel, tag: el.tag, label: elementLabel(el), action: actionAns };
    if (actionAns === 'upload') {
      item.file = (await ask('Path to file (blank = generate throwaway 1x1 PNG): ')).trim() || null;
    } else if (actionAns === 'type') {
      item.value = await ask('Text to type: ');
    }

    queue.push(item);
    console.log(`Queued [${idx}] ${actionAns}.\n`);
  }

  rl.close();
  return queue;
}

// Replays the planned queue against a live page as fast as possible.
async function runQueue(page, queue) {
  const results = [];
  for (const item of queue) {
    const entry = {
      timestamp: new Date().toISOString(),
      selector: item.selector,
      tag: item.tag,
      label: item.label,
      action: item.action,
      success: false,
      error: null,
    };

    try {
      if (item.action === 'upload') {
        const filePath = item.file || placeholderImagePath();
        entry.file = filePath;
        entry.method = await performUpload(page, item.selector, filePath);
        entry.success = true;
      } else if (item.action === 'type') {
        entry.value = item.value;
        await page.fill(item.selector, item.value);
        entry.success = true;
      } else if (item.action === 'click') {
        await page.click(item.selector, { timeout: 5000 });
        entry.success = true;
      } else {
        entry.error = `Unknown action "${item.action}"`;
      }
      // Give any request the action triggers a moment to fire and land in
      // the network log before moving to the next queued item.
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    } catch (e) {
      entry.error = e.message;
    }

    console.log(entry.success
      ? `\u2705 ${item.action} on [${item.idx}] ${item.label} done.`
      : `\u274c ${item.action} on [${item.idx}] ${item.label} failed: ${entry.error}`);

    results.push(entry);
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const domPath = args.dom || (args.report ? path.join(args.report, 'dom.json') : null);
  if (!domPath) {
    console.error('Pass --report <dir> (from a previous map.js run) or --dom <path to dom.json>');
    process.exit(1);
  }
  if (!fs.existsSync(domPath)) {
    console.error(`No such file: ${domPath}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(domPath, 'utf8'));
  const outDir = args.report || path.dirname(domPath);
  const url = args.url || data.url;
  if (!url) {
    console.error('No URL found in dom.json and none given via --url');
    process.exit(1);
  }

  const interactive = data.interactive && data.interactive.length ? data.interactive : flattenInteractive(data.tree);
  if (!interactive.length) {
    console.log('No interactive elements found in the saved map.');
    return;
  }

  const queue = await planQueue(interactive);
  if (!queue) {
    console.log('Cancelled \u2014 nothing was run, nothing was changed.');
    return;
  }

  let browser;
  try {
    browser = await connectBrowserless();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  try {
    const context = await browser.newContext();
    const page = await context.newPage({ viewport: { width: 412, height: 915 } });
    page.setDefaultTimeout(30000);
    const network = attachNetworkLogging(page);

    console.log(`\nConnected. Navigating to ${url} and replaying ${queue.length} queued action(s)...\n`);
    await page.goto(url, { waitUntil: 'networkidle' });
    if (args.waitSelector) {
      try { await page.waitForSelector(args.waitSelector, { timeout: 10000 }); } catch (e) { /* continue anyway */ }
    }

    const newActions = await runQueue(page, queue);
    const tree = await page.evaluate(extractTree).catch(() => data.tree);
    await page.close().catch(() => {});

    const merged = {
      ...data,
      timestamp: new Date().toISOString(),
      tree,
      interactive: flattenInteractive(tree),
      network: [...(data.network || []), ...network],
      actions: [...(data.actions || []), ...newActions],
    };

    fs.writeFileSync(path.join(outDir, 'dom.json'), JSON.stringify(merged, null, 2));
    fs.writeFileSync(path.join(outDir, 'network.json'), JSON.stringify(merged.network, null, 2));
    fs.writeFileSync(path.join(outDir, 'report.html'), buildHtmlReport(merged));

    console.log(`\nThis run: ${newActions.length} action(s), ${newActions.filter(a => a.success).length} succeeded.`);
    console.log(`Total in report so far: ${merged.actions.length} actions, ${merged.network.length} network requests.`);
    console.log(`Report updated: ${path.join(outDir, 'report.html')}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
