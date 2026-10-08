import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectAccountAuthFixtureRepository, printAccountAuthFixtureSourceReport } from './account-auth-fixture-source-scan.mjs';

export function checkAuthFixtureGovernance(root)
{
    return inspectAccountAuthFixtureRepository('auth-fixture', root);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    printAccountAuthFixtureSourceReport('auth-fixture');
}
