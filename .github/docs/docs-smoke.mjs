#!/usr/bin/env node
/**
 * Fail-closed smoke test for the VitePress artifact.
 *
 * VitePress can exit successfully after an SSR/template exception and leave a
 * shell of the site behind. Pages is immutable once uploaded, so validate the
 * artifact before publishing it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : resolve(process.cwd(), 'docs/.vitepress/dist');
const errors = [];
if (!existsSync(root)) {
  errors.push('output directory does not exist: ' + root);
} else {
  const htmlFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.html')) htmlFiles.push(path);
    }
  };
  walk(root);
  if (htmlFiles.length === 0) errors.push('output contains no HTML pages');
  for (const path of htmlFiles) {
    const html = readFileSync(path, 'utf8');
    // #513's symptom is an SSR exception that leaves the layout shell but an
    // empty <main>. Home/404/redirect pages legitimately render no <main>, so
    // only flag a <main> that is present yet empty — an emptied content page.
    if (/<main\b[^>]*>/i.test(html) && !/<main\b[^>]*>[\s\S]*?\S[\s\S]*?<\/main>/i.test(html)) {
      errors.push('page has an empty <main>: ' + relative(root, path));
    }
  }
  const rules = join(root, 'guide/rules.html');
  if (!existsSync(rules)) {
    errors.push('guide/rules.html is missing');
  } else {
    const html = readFileSync(rules, 'utf8');
    // VitePress appends a header-anchor <a> inside every heading, so match the
    // heading text at the start of the <h1> rather than as its whole content.
    if (!/<h1\b[^>]*>\s*The rules\b/i.test(html)) {
      errors.push('guide/rules.html has no rendered “The rules” heading');
    }
    if (!html.includes('ci-tampering')) {
      errors.push('guide/rules.html is missing the ci-tampering rule');
    }
  }
}
if (errors.length) {
  console.error('docs smoke test failed:');
  for (const error of errors) console.error('- ' + error);
  process.exit(1);
}
console.log('docs smoke test passed (' + root + ')');
