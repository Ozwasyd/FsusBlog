import path from 'node:path';

import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: path.resolve(import.meta.dirname, '../../tests/frontend/browser'),
    testMatch: 'authoringWorkspaceSnapshot.browser.spec.ts',
    outputDir: '../../.tmp/workspace-browser/results',
    reporter: [['list'], ['json', { outputFile: '../../.tmp/workspace-browser/report.json' }]],
    workers: 1,
    retries: 0,
    use: { headless: true, trace: 'retain-on-failure' }
});
