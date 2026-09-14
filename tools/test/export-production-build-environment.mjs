import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const {productionBuildEnvironmentAssignments, productionBuildEnvironmentKeys, validateProductionRunId} = await import(new URL('../test-matrix/production-build-layout.mjs', import.meta.url));
function usage()
{
    throw new Error('usage: export-production-build-environment.mjs --root <absolute-root> --run-id <run-id>');
}

export function parseProductionBuildEnvironmentAssignment(value, { allowedKeys = productionBuildEnvironmentKeys, seen = new Set() } = {})
{
    const assignment = String(value ?? '');
    const separator = assignment.indexOf('=');
    if (separator < 1 || assignment.includes('\0'))
    {
        throw new Error('production build environment assignment is malformed');
    }
    const key = assignment.slice(0, separator);
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || !allowedKeys.includes(key))
    {
        throw new Error('production build environment assignment key is not allowed');
    }
    if (seen.has(key))
    {
        throw new Error('production build environment assignment key is duplicated');
    }
    if (!assignment.slice(separator + 1))
    {
        throw new Error(`production build environment assignment value is missing: ${key}`);
    }
    seen.add(key);
    return [key, assignment.slice(separator + 1)];
}

export function writeProductionBuildEnvironment({ root, runId, output = process.stdout, env = process.env })
{
    if (!root || !String(root).startsWith('/'))
    {
        usage();
    }
    const normalizedRunId = validateProductionRunId(runId);
    const seen = new Set();
    for (const [key, value] of productionBuildEnvironmentAssignments({ root, runId: normalizedRunId, env }))
    {
        parseProductionBuildEnvironmentAssignment(`${key}=${value}`, { seen });
        output.write(`${key}=${value}\0`);
    }
}

function cli(argv)
{
    if (argv.length !== 4 || argv[0] !== '--root' || argv[2] !== '--run-id')
    {
        usage();
    }
    writeProductionBuildEnvironment({ root: argv[1], runId: argv[3] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        cli(process.argv.slice(2));
    }
    catch (error)
    {
        process.stderr.write(`[production-build-environment] ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
