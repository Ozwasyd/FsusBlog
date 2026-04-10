#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const viewsDir = join(root, 'src', 'views');
const strictMode = process.env.FSUSBLOG_STRICT_VIEWS === '1';

function walkVueFiles(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkVueFiles(full, output);
      continue;
    }
    if (full.endsWith('.vue')) {
      output.push(full);
    }
  }
  return output;
}

const vueFiles = walkVueFiles(viewsDir);
const hardViolations = [];
const softViolations = [];

for (const file of vueFiles) {
  const source = readFileSync(file, 'utf8');

  const hasDirectWindowListener = source.includes('window.addEventListener(')
    || source.includes('window.removeEventListener(');
  if (hasDirectWindowListener) {
    hardViolations.push(`${file}: direct window event listener is forbidden in view (use composable/service)`);
  }

  const hasDirectAotListener = source.includes("window.addEventListener('fsus:aot:event'")
    || source.includes('window.addEventListener("fsus:aot:event"');
  if (hasDirectAotListener) {
    hardViolations.push(`${file}: direct fsus:aot:event listener is forbidden in view`);
  }

  const abortMatches = source.match(/\bnew\s+AbortController\s*\(/g) ?? [];
  if (abortMatches.length > 1) {
    softViolations.push(`${file}: multiple AbortController allocations detected (${abortMatches.length})`);
  }
}

for (const line of hardViolations) {
  console.error(`[views-constraints] hard: ${line}`);
}
for (const line of softViolations) {
  console.warn(`[views-constraints] soft: ${line}`);
}

if (hardViolations.length > 0) {
  process.exit(1);
}

if (strictMode && softViolations.length > 0) {
  process.exit(1);
}

console.log(`[views-constraints] ok hard=${hardViolations.length} soft=${softViolations.length} strict=${strictMode ? 1 : 0}`);
