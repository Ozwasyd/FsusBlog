#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { cwd } from 'node:process';
import { readFileSync } from 'node:fs';

const root = cwd();

function findMatches(args) {
  try {
    return execFileSync('rg', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    if (error?.status === 1) {
      return '';
    }

    const stderr = error?.stderr?.toString?.().trim();
    if (stderr) {
      console.error(stderr);
    }
    process.exit(typeof error?.status === 'number' ? error.status : 1);
  }
}

const forbiddenPatterns = [
  'MarkdownIt',
  'markdown-it-katex',
  'createHighlighter(',
  'createSharedMarkdownRenderer',
  'renderMarkdownHtml('
];

const forbiddenOutput = findMatches([
  '-n',
  '-F',
  '--glob',
  '!**/node_modules/**',
  '--glob',
  '!**/dist/**',
  '--glob',
  '!**/public/wasm/**',
  ...forbiddenPatterns.flatMap((pattern) => ['-e', pattern]),
  'src'
]);

if (forbiddenOutput) {
  console.error('[markdown-no-js-path] forbidden markdown JS path still referenced:');
  console.error(forbiddenOutput);
  process.exit(1);
}

const directEditorImports = findMatches([
  '-n',
  '-F',
  '--glob',
  '!**/node_modules/**',
  '--glob',
  '!**/dist/**',
  '--glob',
  '!src/components/ui/AsyncMdEditor.ts',
  '-e',
  "from 'md-editor-v3'",
  '-e',
  'from "md-editor-v3"',
  'src'
]);

if (directEditorImports) {
  console.error('[markdown-no-js-path] md-editor-v3 must be wrapped by AsyncMdEditor only:');
  console.error(directEditorImports);
  process.exit(1);
}

const editorVueFiles = findMatches([
  '-l',
  '-i',
  '--glob',
  '*.vue',
  '<md-editor',
  'src'
])
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean);

for (const relativePath of editorVueFiles) {
  const absolutePath = `${root}/${relativePath}`;
  const source = readFileSync(absolutePath, 'utf8');
  const hasPreviewSlot = /<template\s+#preview\b/.test(source);
  const usesPreviewOnly = /(?:[:@]|[\s<])previewOnly\b|preview-only\b/.test(source);
  const optsIntoPreview = /[:\s]preview\s*=/.test(source);

  if (usesPreviewOnly) {
    console.error(`[markdown-no-js-path] md-editor-v3 previewOnly path is forbidden: ${relativePath}`);
    process.exit(1);
  }

  if (optsIntoPreview && !hasPreviewSlot) {
    console.error(`[markdown-no-js-path] md-editor-v3 preview must be overridden via #preview slot: ${relativePath}`);
    process.exit(1);
  }

  if (!hasPreviewSlot) {
    console.error(`[markdown-no-js-path] md-editor-v3 default preview path is forbidden without a #preview slot: ${relativePath}`);
    process.exit(1);
  }
}

console.log('[markdown-no-js-path] ok');
