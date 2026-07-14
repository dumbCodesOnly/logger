#!/usr/bin/env node
/**
 * map-static.js
 * Lightweight alternative to map.js: fetches raw HTML (no browser, no JS
 * execution) and walks the static DOM with cheerio. Much faster and avoids
 * the ~1GB Chromium install, but WON'T see content that only appears after
 * client-side JS runs (common on React/Next.js apps for interactive widgets).
 *
 * Usage:
 *   node map-static.js --url https://example.com --out ./reports/example
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { out: './out' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

const MAX_TEXT = 80;

// Tags that are inherently interactive regardless of attributes.
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'label', 'form', 'details', 'summary', 'option', 'dialog']);

// ARIA roles that imply an interactive widget (from WAI-ARIA widget roles).
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'textbox', 'searchbox',
  'combobox', 'listbox', 'slider', 'spinbutton', 'treeitem'
]);

// Native HTML event-handler attributes commonly used for click/interaction.
const EVENT_ATTRS = ['onclick', 'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onmousedown', 'onmouseup', 'ontouchstart', 'ontouchend', 'onpointerdown'];

// Framework/library conventions that mark an element as a bound interactive
// target even before hydration (React/Vue/Alpine/htmx attributes commonly
// left in server-rendered markup).
const FRAMEWORK_HINT_PREFIXES = ['data-action', 'data-click', 'data-toggle', 'data-target', 'data-testid', '@click', 'v-on:click', 'x-on:click', 'hx-post', 'hx-get', 'hx-trigger'];

function hasFrameworkHint($el) {
  const attribs = $el.get(0)?.attribs || {};
  return Object.keys(attribs).some(a => FRAMEWORK_HINT_PREFIXES.some(p => a === p || a.startsWith(p)));
}

function shortText($el) {
  const t = ($el.text() || $el.attr('value') || $el.attr('placeholder') || '').trim().replace(/\s+/g, ' ');
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '…' : t;
}

function walk($, el) {
  const tag = el.tagName;
  if (!tag || ['script', 'style', 'noscript', 'link', 'meta'].includes(tag)) return null;
  const $el = $(el);

  const classAttr = $el.attr('class');
  const role = $el.attr('role');
  const tabindex = $el.attr('tabindex');
  const contentEditable = $el.attr('contenteditable');

  const interactiveReasons = [];
  if (INTERACTIVE_TAGS.has(tag)) interactiveReasons.push('tag');
  if (role && INTERACTIVE_ROLES.has(role)) interactiveReasons.push('role');
  if (tabindex !== undefined && tabindex !== '-1') interactiveReasons.push('tabindex');
  if (contentEditable === '' || contentEditable === 'true') interactiveReasons.push('contenteditable');
  if (EVENT_ATTRS.some(a => $el.attr(a) !== undefined)) interactiveReasons.push('event-handler');
  if (hasFrameworkHint($el)) interactiveReasons.push('framework-hint');

  const interactive = interactiveReasons.length > 0;

  const node = {
    tag,
    id: $el.attr('id') || undefined,
    classes: classAttr ? classAttr.trim().split(/\s+/).filter(Boolean) : undefined,
    role: role || undefined,
    ariaLabel: $el.attr('aria-label') || undefined,
    name: $el.attr('name') || undefined,
    type: $el.attr('type') || undefined,
    href: tag === 'a' ? $el.attr('href') || undefined : undefined,
    text: shortText($el) || undefined,
    interactive,
    interactiveReasons: interactive ? interactiveReasons : undefined,
    // Note: no `visible` or `bbox` — those require actual layout/rendering,
    // which a static HTML fetch can't provide.
    children: []
  };

  $el.children().each((_, child) => {
    const c = walk($, child);
    if (c) node.children.push(c);
  });
  return node;
}

function flattenInteractive(node, list = []) {
  if (!node) return list;
  if (node.interactive) {
    list.push({
      tag: node.tag, id: node.id, classes: node.classes, role: node.role,
      ariaLabel: node.ariaLabel, name: node.name, type: node.type,
      href: node.href, text: node.text, interactiveReasons: node.interactiveReasons
    });
  }
  (node.children || []).forEach(c => flattenInteractive(c, list));
  return list;
}

function countNodes(node) {
  if (!node) return 0;
  return 1 + (node.children || []).reduce((sum, c) => sum + countNodes(c), 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('Missing --url');
    process.exit(1);
  }
  fs.mkdirSync(args.out, { recursive: true });

  const cheerio = require('cheerio');

  const res = await fetch(args.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DOMapStatic/1.0)' }
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim();
  const bodyEl = $('body').get(0);
  const tree = bodyEl ? walk($, bodyEl) : null;
  const interactive = flattenInteractive(tree);

  const data = {
    url: args.url,
    title,
    mode: 'static (no JS execution)',
    timestamp: new Date().toISOString(),
    totalNodes: countNodes(tree),
    interactive,
    tree
  };

  fs.writeFileSync(path.join(args.out, 'dom-static.json'), JSON.stringify(data, null, 2));

  console.log(`Mode: static fetch (no browser, no JS execution)`);
  console.log(`Page title: ${title}`);
  console.log(`Total DOM nodes: ${data.totalNodes}`);
  console.log(`Interactive elements found: ${interactive.length}`);
  console.log(`JSON: ${path.join(args.out, 'dom-static.json')}`);
  if (interactive.length === 0) {
    console.log(`\nNo interactive elements found in raw HTML — this page likely renders its UI client-side via JS. You'll need map.js (browser-based) for that content.`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
