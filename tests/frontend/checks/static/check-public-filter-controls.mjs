#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const componentPath = path.join(repoRoot, 'src/frontend/src/components/public/pages/PublicFilterPageContent.vue');
const source = fs.readFileSync(componentPath, 'utf8');
const failures = [];

function requirePattern(pattern, message)
{
    if (!pattern.test(source))
    {
        failures.push(message);
    }
}

function forbidPattern(pattern, message)
{
    if (pattern.test(source))
    {
        failures.push(message);
    }
}

requirePattern(
    /<el-radio-group[\s\S]*?class="fsus-radio-group--touch"[\s\S]*?size="small"/,
    'search sorting must consume the public FsusUI 44px RadioButton modifier while retaining compact typography'
);
forbidPattern(
    /:deep\([^)]*\.el-radio-button|\.el-radio-button__(?:inner|original-radio)/,
    'consumer code must not style private FsusUI RadioButton DOM'
);
requirePattern(
    /class="sticky top-\[calc\(var\(--fsusblog-public-header-height-current,4rem\)\+1\.5rem\)\]"/,
    'desktop aside must derive its sticky offset from the current public header height'
);
forbidPattern(/\btop-52\b/, 'desktop aside must not restore the arbitrary 208px sticky offset');
requirePattern(
    /<aside[\s\S]*?<a[\s\S]*?class="[^"]*\bmin-h-8\b[^"]*\bfocus-visible:ring-2\b[^"]*\bfocus-visible:ring-inset\b[^"]*\bfocus-visible:ring-\[var\(--fsusblog-color-focus-ring\)\]/,
    'desktop aside home link must keep its 32px hit area and visible keyboard focus ring'
);
requirePattern(
    /<PublicContentState[\s\S]*?<a[\s\S]*?class="[^"]*\bmin-h-11\b[^"]*\brounded-\[var\(--fsusblog-radius-control\)\][^"]*\bborder\b[^"]*\bborder-\[var\(--fsusblog-panel-border\)\][^"]*\bpx-4\b/,
    'page empty-state action must keep the 44px bordered control geometry'
);
requirePattern(
    /<PublicContentState[\s\S]*?<a[\s\S]*?class="[^"]*\bfocus-visible:ring-2\b[^"]*\bfocus-visible:ring-inset\b[^"]*\bfocus-visible:ring-\[var\(--fsusblog-color-focus-ring\)\]/,
    'page empty-state action must expose the inset Scholarly Blue keyboard focus ring'
);
forbidPattern(
    /<PublicContentState[\s\S]*?<a[\s\S]*?class="[^"]*\bmin-h-9\b/,
    'page empty-state action must not regress to the retired 36px height'
);

if (failures.length > 0)
{
    console.error(failures.map((failure) => `[public-filter-controls] ${failure}`).join('\n'));
    process.exit(1);
}

console.log('[public-filter-controls] ok');
