import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectAccountAuthFixtureRepository, printAccountAuthFixtureSourceReport } from './account-auth-fixture-source-scan.mjs';

export function checkAuthTruthGovernance(root)
{
    return inspectAccountAuthFixtureRepository('auth-truth', root);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    printAccountAuthFixtureSourceReport('auth-truth');
}
