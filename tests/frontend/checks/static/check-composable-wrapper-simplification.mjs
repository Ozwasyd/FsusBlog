#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const failures = [];
const expectAbsent = (label, source, pattern) =>
{
    if (pattern.test(source))
    {
        failures.push(label);
    }
};
const expectPresent = (label, source, pattern) =>
{
    if (!pattern.test(source))
    {
        failures.push(label);
    }
};

const adminArticleWrite = read('src/frontend/src/composables/useAdminArticleWrite.ts');
expectAbsent('useAdminArticleWrite should not define or call cloneArticleRightsForm', adminArticleWrite, /\bcloneArticleRightsForm\b/);

const publicSpaNavigationMode = read('src/frontend/src/composables/usePublicSpaNavigationMode.ts');
expectAbsent('usePublicSpaNavigationMode should be a module-level computed ref, not a wrapper function', publicSpaNavigationMode, /export\s+function\s+usePublicSpaNavigationMode\b/);
expectPresent('usePublicSpaNavigationMode should export a module-level computed ref', publicSpaNavigationMode, /export\s+const\s+usePublicSpaNavigationMode\s*=\s*computed\(/);

const adminSensitiveProof = read('src/frontend/src/composables/useAdminSensitiveProof.ts');
expectAbsent('useAdminSensitiveProof wrapper composable should be removed', adminSensitiveProof, /export\s+function\s+useAdminSensitiveProof\b/);
expectAbsent('useAdminSensitiveProof should not return ensureAdminSensitiveProof from a wrapper', adminSensitiveProof, /return\s*{\s*ensureAdminSensitiveProof\s*}/s);
expectPresent('ensureAdminSensitiveProof should be exported directly', adminSensitiveProof, /export\s+async\s+function\s+ensureAdminSensitiveProof\s*\(/);

const articleDetailView = read('src/frontend/src/composables/useArticleDetailView.ts');
expectAbsent('useArticleDetailView should not define a commentChallengeClient forwarding wrapper', articleDetailView, /const\s+commentChallengeClient\s*:/);
expectPresent('useArticleDetailView should import and use the risk challenge command', articleDetailView, /import\s*{\s*useRiskChallengeCommand\s*}\s*from/);

const homeView = read('src/frontend/src/composables/useHomeView.ts');
expectAbsent('useHomeView should not expose the loadFeaturedArticles alias', homeView, /\bloadFeaturedArticles\b/);

if (failures.length > 0)
{
    console.error('Composable wrapper simplification check failed:');
    for (const failure of failures)
    {
        console.error(`- ${failure}`);
    }
    process.exit(1);
}
