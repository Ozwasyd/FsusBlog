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

function collectWithDefaultsDefinePropsBlocks(source) {
  const blocks = [];
  const needle = 'withDefaults';
  let searchIndex = 0;
  while (searchIndex < source.length) {
    const start = source.indexOf(needle, searchIndex);
    if (start === -1) {
      break;
    }

    const openParen = source.indexOf('(', start + needle.length);
    if (openParen === -1) {
      break;
    }

    const prefix = source.slice(start, openParen);
    if (!/withDefaults\s*$/.test(prefix)) {
      searchIndex = start + needle.length;
      continue;
    }

    let depth = 0;
    let end = -1;
    for (let index = openParen; index < source.length; index += 1) {
      const char = source[index];
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }

    if (end === -1) {
      break;
    }

    const block = source.slice(start, end);
    if (/withDefaults\s*\(\s*defineProps/.test(block)) {
      blocks.push({ block, index: start });
    }
    searchIndex = end;
  }

  return blocks;
}

function checkScriptSetupHoistSafety(source, fileLabel) {
  if (!source.includes('<script setup')) {
    return;
  }

  for (const { block, index } of collectWithDefaultsDefinePropsBlocks(source)) {
    if (/\b(?:copy|[A-Za-z_$][\w$]*Copy)\s*\./.test(block)) {
      hardViolations.push(`${fileLabel}:${lineNumber(source, index)}: withDefaults(defineProps(...)) cannot reference local copy aliases in <script setup> defaults`);
    }
  }
}

for (const file of vueFiles) {
  const source = readFileSync(file, 'utf8');
  const fileLabel = relative(file);
  const isViewFile = file.startsWith(viewsDir);
  const isComponentFile = file.startsWith(componentsDir);

  checkScriptSetupHoistSafety(source, fileLabel);

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

const accountLayoutPath = join(srcDir, 'layouts', 'AccountLayout.vue');
const accountLayoutSource = readFileSync(accountLayoutPath, 'utf8');
if (!accountLayoutSource.includes('activeMobileGroupKey')) {
  hardViolations.push('src/layouts/AccountLayout.vue: mobile account navigation must separate active route group from open group');
}
if (!accountLayoutSource.includes('openMobileGroupKey')) {
  hardViolations.push('src/layouts/AccountLayout.vue: mobile account navigation must keep an explicit open group state');
}
if (accountLayoutSource.includes("'account-mobile-tab-link-active': openMobileGroupKey === group.key")) {
  hardViolations.push('src/layouts/AccountLayout.vue: mobile account group active state must not be driven by openMobileGroupKey');
}
if (!/if\s*\(\s*key\s*!==\s*currentNavGroupKey\.value\s*\)[\s\S]*?router\.push\(target\)/.test(accountLayoutSource)) {
  hardViolations.push('src/layouts/AccountLayout.vue: mobile account group changes must navigate to the selected group entry, not leave route and open group mismatched');
}
if (!/to:\s*group\.items\[0\]\?\.to/.test(accountLayoutSource)) {
  hardViolations.push('src/layouts/AccountLayout.vue: mobile account group segments must expose each group entry route for router-link navigation semantics');
}
if (!accountLayoutSource.includes('selection-mode="link"')) {
  hardViolations.push('src/layouts/AccountLayout.vue: mobile account group segments must use link mode instead of radio-only selection semantics');
}
if (!accountLayoutSource.includes('FsusUiSegmentedControl')) {
  hardViolations.push('src/layouts/AccountLayout.vue: mobile account group navigation must use the FsusUI segmented-control adapter');
}
if (accountLayoutSource.includes('class="account-mobile-tab-link"')) {
  hardViolations.push('src/layouts/AccountLayout.vue: mobile account group navigation must not regress to the legacy hand-rolled tab buttons');
}
if (!accountLayoutSource.includes('accountViewRecord')) {
  hardViolations.push('src/layouts/AccountLayout.vue: account route view key must be based on the direct AccountLayout child record');
}
if (/const\s+routeName\s*=\s*typeof\s+route\.name\s*===\s*'string'\s*\?\s*route\.name\s*:\s*route\.path/.test(accountLayoutSource)) {
  hardViolations.push('src/layouts/AccountLayout.vue: account route view key must not use the deepest route.name because nested admin tabs would remount their parent layout');
}
if (!/route\.matched\.findIndex\(\(record\)\s*=>\s*record\.path\s*===\s*'\/user'\)/.test(accountLayoutSource)) {
  hardViolations.push('src/layouts/AccountLayout.vue: account route view key must locate the /user root before choosing the direct child record');
}

const accountNavPath = join(srcDir, 'layouts', 'accountNav.ts');
const accountNavSource = readFileSync(accountNavPath, 'utf8');
if (!/label:\s*'身份中心'[\s\S]*?match:\s*\(\)\s*=>\s*false/.test(accountNavSource)) {
  hardViolations.push('src/layouts/accountNav.ts: top-level 身份中心 shortcut must not participate in active route matching');
}
if (!/label:\s*'身份总览'[\s\S]*?match:\s*\(path\)\s*=>\s*path\s*===\s*'\/user\/identity'/.test(accountNavSource)) {
  hardViolations.push('src/layouts/accountNav.ts: 身份总览 must use exact /user/identity matching to avoid double-active subroutes');
}

const routerPath = join(srcDir, 'router', 'index.ts');
const routerSource = readFileSync(routerPath, 'utf8');
if (!routerSource.includes('isSameAccountShellChildSwitch')) {
  hardViolations.push('src/router/index.ts: route progress must skip nested account shell tab switches');
}
if (!/router\.beforeEach\(async\s*\(\s*to\s*,\s*from\s*\)/.test(routerSource)) {
  hardViolations.push('src/router/index.ts: route progress guard must inspect both to and from routes');
}
if (!routerSource.includes('!isSameAccountShellChildSwitch(to, from)')) {
  hardViolations.push('src/router/index.ts: nested admin tabs must not start global nprogress');
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
