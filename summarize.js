#!/usr/bin/env node
// summarize.js - prints a quick terminal summary of a dom.json report
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node summarize.js <dom.json>');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(file, 'utf8'));

console.log(`\nURL:        ${data.url}`);
console.log(`Title:      ${data.title}`);
console.log(`Captured:   ${data.timestamp}`);
console.log(`DOM nodes:  ${data.totalNodes}`);
console.log(`Interactive elements: ${data.interactive.length}\n`);

const byTag = {};
for (const el of data.interactive) {
  byTag[el.tag] = (byTag[el.tag] || 0) + 1;
}
console.log('Interactive elements by tag:');
Object.entries(byTag).sort((a, b) => b[1] - a[1]).forEach(([tag, n]) => {
  console.log(`  ${tag.padEnd(10)} ${n}`);
});

console.log('\nFirst 15 interactive elements:');
data.interactive.slice(0, 15).forEach((el, i) => {
  const label = el.text || el.ariaLabel || el.href || '(no label)';
  console.log(`  ${String(i + 1).padStart(2)}. <${el.tag}${el.id ? '#' + el.id : ''}> ${label}`);
});
console.log('');
