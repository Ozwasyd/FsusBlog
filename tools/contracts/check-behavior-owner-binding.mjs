#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    assertBehaviorOwnerBindings,
    formatOwnerBindingReport,
    scanBehaviorOwnerBindings
} from './behavior-owner-binding.mjs';

const json = process.argv.includes('--json');
const report = formatOwnerBindingReport(scanBehaviorOwnerBindings());
if (json)
{
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
if (report.errors.length > 0)
{
    if (!json)
    {
        console.error(`[behavior-owner-binding] ${report.errors.length} error(s):`);
        for (const error of report.errors)
        {
            console.error(`- ${error}`);
        }
    }
    process.exitCode = 1;
}
else if (!json)
{
    console.log(`[behavior-owner-binding] ok (${report.bindingCount} binding(s); catalog ${report.catalogDigest.slice(0, 12)}; worktree ${String(report.worktreeDigest).slice(0, 12)})`);
}

// Keep a direct assert export path for callers that want throw-on-fail semantics.
export { assertBehaviorOwnerBindings };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--assert'))
{
    assertBehaviorOwnerBindings();
}
