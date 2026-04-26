#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const srcDir = join(root, 'src');
const viewsDir = join(srcDir, 'views');
const componentsDir = join(srcDir, 'components');
const componentFacingDirs = [
  componentsDir,
  join(srcDir, 'ui-tokens'),
  join(srcDir, 'ui-contracts'),
  join(srcDir, 'view-contracts')
];
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

const vueFiles = walkVueFiles(srcDir);
function walkSourceFiles(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSourceFiles(full, output);
      continue;
    }
    if (/\.(vue|ts)$/.test(full)) {
      output.push(full);
    }
  }
  return output;
}

const componentFacingFiles = Array.from(new Set(componentFacingDirs.flatMap((dir) => walkSourceFiles(dir))));
const hardViolations = [];
const softViolations = [];

const legacyComponentApiPatterns = [
  { pattern: /:contract\s*=/, label: 'legacy :contract component API' },
  { pattern: /\bextra-class\s*=/, label: 'legacy extra-class prop' },
  { pattern: /\bextraClass\b/, label: 'legacy extraClass prop' },
  { pattern: /\b(ButtonContract|TagContract|EmptyStateContract)\b/, label: 'legacy UI contract type' }
];

const forbiddenDesignPatterns = [
  { pattern: /\b(?:text|bg|border|hover:text|hover:bg|focus:ring|focus-visible:ring)-blue-\d+\b/, label: 'Tailwind blue token outside design.md palette' },
  { pattern: /\bprose-zinc\b/, label: 'prose-zinc bypasses Ink/Paper typography' },
  { pattern: /\bshadow-2xl\b/, label: 'shadow-2xl is too heavy for component surfaces' },
  { pattern: /\btracking-(?:widest|wider|wide|\[[^\]]+\])\b/, label: 'over-wide letter spacing' }
];

function relative(file) {
  return file.replace(`${root}/`, '');
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function collectClassTokens(source) {
  const tokens = [];
  const classAttrRegex = /\bclass\s*=\s*(["'`])([\s\S]*?)\1/g;
  let match;
  while ((match = classAttrRegex.exec(source)) !== null) {
    const body = match[2] ?? '';
    const baseLine = lineNumber(source, match.index);
    for (const token of body.split(/\s+/).map((value) => value.trim()).filter(Boolean)) {
      tokens.push({ token, line: baseLine });
    }
  }
  return tokens;
}

function tokenHasBreakpoint(token) {
  return /^(xs|sm|md|lg|xl|2xl|3xl):/.test(token);
}

function parseArbitrarySize(token, prefix) {
  const escapedPrefix = prefix.replace('-', '\\-');
  const match = token.match(new RegExp(`(?:^|:)${escapedPrefix}-\\[([0-9.]+)(px|rem)\\]`));
  if (!match) {
    return null;
  }
  return { value: Number(match[1]), unit: match[2] };
}

function checkComponentFacingSource(source, fileLabel) {
  for (const { pattern, label } of legacyComponentApiPatterns) {
    const match = source.match(pattern);
    if (match?.index !== undefined) {
      hardViolations.push(`${fileLabel}:${lineNumber(source, match.index)}: ${label} is forbidden in component-facing files`);
    }
  }

  for (const { pattern, label } of forbiddenDesignPatterns) {
    const match = source.match(pattern);
    if (match?.index !== undefined) {
      hardViolations.push(`${fileLabel}:${lineNumber(source, match.index)}: ${label}`);
    }
  }
}

for (const file of vueFiles) {
  const source = readFileSync(file, 'utf8');
  const fileLabel = relative(file);
  const isViewFile = file.startsWith(viewsDir);
  const isComponentFile = file.startsWith(componentsDir);

  if (isViewFile) {
    const hasDirectWindowListener = source.includes('window.addEventListener(')
      || source.includes('window.removeEventListener(');
    if (hasDirectWindowListener) {
      hardViolations.push(`${fileLabel}: direct window event listener is forbidden in view (use composable/service)`);
    }

    const hasDirectAotListener = source.includes("window.addEventListener('fsus:aot:event'")
      || source.includes('window.addEventListener("fsus:aot:event"');
    if (hasDirectAotListener) {
      hardViolations.push(`${fileLabel}: direct fsus:aot:event listener is forbidden in view`);
    }

    const abortMatches = source.match(/\bnew\s+AbortController\s*\(/g) ?? [];
    if (abortMatches.length > 1) {
      softViolations.push(`${fileLabel}: multiple AbortController allocations detected (${abortMatches.length})`);
    }
  }

  if (isComponentFile) {
    checkComponentFacingSource(source, fileLabel);
  }

  for (const { token, line } of collectClassTokens(source)) {
    const minWidth = parseArbitrarySize(token, 'min-w');
    if (minWidth && !tokenHasBreakpoint(token)) {
      const tooWide = minWidth.unit === 'rem' ? minWidth.value >= 18 : minWidth.value >= 320;
      if (tooWide) {
        hardViolations.push(`${fileLabel}:${line}: unguarded ${token} can force mobile horizontal overflow`);
      }
    }

    const fixedWidth = parseArbitrarySize(token, 'w');
    if (fixedWidth && !tokenHasBreakpoint(token)) {
      const tooWide = fixedWidth.unit === 'rem' ? fixedWidth.value >= 22.5 : fixedWidth.value >= 360;
      if (tooWide) {
        hardViolations.push(`${fileLabel}:${line}: unguarded ${token} can exceed narrow mobile viewport`);
      }
    }

    if (/^(gap-2[04]|space-y-20|px-1[24]|py-32|text-[89]xl|tracking-tighter)$/.test(token)) {
      softViolations.push(`${fileLabel}:${line}: ${token} should be responsive or replaced by shared layout tokens`);
    }
  }
}

for (const file of componentFacingFiles) {
  if (vueFiles.includes(file)) {
    continue;
  }
  checkComponentFacingSource(readFileSync(file, 'utf8'), relative(file));
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

console.log(`[views-constraints] ok vue=${vueFiles.length} components=${vueFiles.filter((file) => file.startsWith(componentsDir)).length} componentFacing=${componentFacingFiles.length} hard=${hardViolations.length} soft=${softViolations.length} strict=${strictMode ? 1 : 0}`);
