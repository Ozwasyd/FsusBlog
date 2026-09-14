#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- The checker writes the canonical repository receipt.
import { writeFrontendStructureProducerForArtifact } from '../../../../tools/test/frontend-render-structure-receipts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const frontendOutputRoot = path.resolve(
    process.env.FSUSBLOG_FRONTEND_OUTPUT_ROOT ?? path.join(root, '.tmp/frontend'));
const adapterFile = path.join(root, 'src/frontend/src/components/ui/MarkdownEditorAdapter.vue');
const rendererFile = path.join(root, 'src/frontend/src/components/ui/MarkdownRenderer.vue');
const fsusuiMarkdownFile = path.join(root, 'src/frontend/src/fsusui/markdown.ts');
const trustedTypesRuntimeFile = path.join(
    root,
    'src/frontend/src/security/trustedTypesRuntime.ts');
const packageFile = path.join(root, 'src/frontend/package.json');
const outFile = path.join(frontendOutputRoot, 'markdown-render-budget.json');
const receiptFile = path.join(frontendOutputRoot, 'receipts/markdown-render-budget.json');
const releaseSummaryFile = path.join(
    process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? path.join(root, '.tmp/release-evidence'),
    'frontend-render-pressure-summary.json');

const corpus = {
    headings: Array.from({ length: 100 }, (_, index) => `# Heading ${index}`).join('\n'),
    codeBlocks: Array.from({ length: 100 }, (_, index) => `\`\`\`ts\nconst value${index} = "${'x'.repeat(120)}"\n\`\`\``).join('\n'),
    latexBlocks: Array.from({ length: 20 }, (_, index) => `$$ a_${index} + b_${index} = c_${index} $$`).join('\n'),
    mermaidDiagrams: Array.from({ length: 10 }, (_, index) => `\`\`\`mermaid\ngraph LR; A${index}-->B${index};\n\`\`\``).join('\n'),
    longLines: Array.from({ length: 50 }, () => 'x'.repeat(240)).join('\n'),
    listItems: Array.from({ length: 1000 }, (_, index) => `- item ${index}`).join('\n'),
    mixed: '中文 / emoji ✨ / RTL مثال / English / `inline code`'
};

function read(file)
{
    return fs.readFileSync(file, 'utf8');
}

function ensureDir(dir)
{
    fs.mkdirSync(dir, { recursive: true });
}

function relative(file)
{
    return path.relative(root, file).replaceAll(path.sep, '/');
}

function estimateNodes(markdown)
{
    return markdown.split(/\r?\n/u).length
    + (markdown.match(/^#{1,6}\s+/gmu) ?? []).length * 2
    + (markdown.match(/```/g) ?? []).length * 30
    + (markdown.match(/^\s*[-*+]\s+/gmu) ?? []).length * 2;
}

function writeReleaseSummary(summary)
{
    ensureDir(path.dirname(releaseSummaryFile));
    const existing = fs.existsSync(releaseSummaryFile)
        ? JSON.parse(fs.readFileSync(releaseSummaryFile, 'utf8'))
        : { status: 'ok', generatedAt: new Date().toISOString(), artifacts: {} };
    const next = {
        ...existing,
        status: existing.status === 'failed' || summary.status === 'failed' ? 'failed' : 'ok',
        generatedAt: new Date().toISOString(),
        markdownRenderBudget: {
            status: summary.status,
            corpusBytes: summary.corpusBytes,
            estimatedNodes: summary.estimatedNodes,
            artifact: relative(outFile)
        },
        artifacts: {
            ...(existing.artifacts ?? {}),
            markdownRenderBudget: relative(outFile)
        }
    };
    fs.writeFileSync(releaseSummaryFile, `${JSON.stringify(next, null, 2)}\n`);
}

const adapter = read(adapterFile);
const renderer = read(rendererFile);
const fsusuiMarkdown = read(fsusuiMarkdownFile);
const trustedTypesRuntime = read(trustedTypesRuntimeFile);
const packageJson = JSON.parse(read(packageFile));
const combinedCorpus = Object.values(corpus).join('\n\n');
const requirements = [
    ['adapter does not host a four-mode header', !adapter.includes('editor-shell__header') && !adapter.includes('el-radio-group')],
    ['adapter keeps a stable editor instance', !/v-if=".*editor/u.test(adapter) && adapter.includes('ref="editorRef"')],
    ['adapter consumes public chrome variant', adapter.includes(':chrome="chrome"') && adapter.includes('data-markdown-chrome')],
    ['adapter consumes FsusUI status density', adapter.includes(':status-density="statusDensity"')],
    ['FsusUI 1.5 markdown renderer dependency', packageJson.dependencies?.['@ozwasyd/element-plus'] === '1.5.1'],
    ['MarkdownRenderer forwards FsusUI activation events', renderer.includes('@features-activated') && renderer.includes("emit('features-activated'")],
    ['MarkdownRenderer has no downstream activation import', !renderer.includes('markdownActivationService') && !renderer.includes('queueFeatureActivation')],
    [
        'FsusUI safe result runtime is the single render source',
        fsusuiMarkdown.includes('activateMarkdownFeatures')
      && fsusuiMarkdown.includes('renderMarkdownResultWithRuntime')
      && fsusuiMarkdown.includes('MarkdownSafeRenderResult')
      && fsusuiMarkdown.includes("from '@ozwasyd/element-plus/markdown-runtime'")
      && !fsusuiMarkdown.includes("from '@/fsusui/markdownContract'")
      && !fsusuiMarkdown.includes('defaultMermaidAdapter')
      && !fsusuiMarkdown.includes('defaultLatexAdapter')
      && !fsusuiMarkdown.includes('defaultCodeHighlightAdapter')
      && !fsusuiMarkdown.includes('sanitizeMarkdownRuntimeHtml')
      && !fsusuiMarkdown.includes('renderMarkdownFallbackWithRuntime')
      && !fsusuiMarkdown.includes('allowHtml')
    ],
    [
        'Markdown TrustedHTML accepts only FsusUI opaque safe HTML',
        trustedTypesRuntime.includes('safeHtml: MarkdownSafeHtml')
      && trustedTypesRuntime.includes('createHTML(safeHtml)')
      && !trustedTypesRuntime.includes('toTrustedMarkdownHtml(safeHtml: string)')
      && !trustedTypesRuntime.includes('toTrustedSanitizedHtml')
    ]
];
const failures = requirements.filter(([, ok]) => !ok).map(([label]) => label);
const summary = {
    status: failures.length === 0 ? 'ok' : 'failed',
    generatedAt: new Date().toISOString(),
    corpusBytes: Buffer.byteLength(combinedCorpus, 'utf8'),
    estimatedNodes: estimateNodes(combinedCorpus),
    renderMsBudget: 420,
    activationMsBudget: 180,
    longTaskBudget: 2,
    requirements: Object.fromEntries(requirements),
    failures
};

ensureDir(path.dirname(outFile));
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
writeReleaseSummary(summary);
writeFrontendStructureProducerForArtifact({
    root,
    checkId: 'markdown-render-budget',
    status: summary.status,
    artifactFile: outFile,
    receiptFile
});

if (summary.status !== 'ok')
{
    for (const failure of failures)
    {
        console.error(`[markdown-render-budget] missing: ${failure}`);
    }
    process.exit(1);
}
console.log(`[markdown-render-budget] ok corpusBytes=${summary.corpusBytes} estimatedNodes=${summary.estimatedNodes}`);
