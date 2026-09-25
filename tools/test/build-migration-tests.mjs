#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { publishMigrationBuildReady, requireMigrationUnitBuildContext } = await import(new URL('./migration-build-binding.mjs', import.meta.url));
const { executeMigrationDotnet } = await import(new URL('./run-migration-tests.mjs', import.meta.url));
const { resolveDotnetBuildParallelism } = await import(new URL('./resolve-dotnet-build-parallelism.mjs', import.meta.url));

/**
 * Build only the two independent Migration consumers for matrix backend-unit.
 * The caller holds the existing Release writer lock; no production-bundle
 * receipt is reused and failed first attempts cannot be silently rebuilt.
 */
export async function buildMigrationUnitTests(options, { env = process.env, execute = executeMigrationDotnet } = {})
{
    const { layout, artifacts } = await requireMigrationUnitBuildContext(options, env);
    const readyFile = path.join(options.root, '.tmp/test-runs', options.runId, 'migration-tests-ready.json');
    if (fs.existsSync(readyFile))
    {
        throw new Error('Migration unit build cannot replace an existing producer marker');
    }
    const directory = path.join(layout.runRoot, 'migration-unit-build');
    fs.mkdirSync(directory);
    const cpuUnits = resolveDotnetBuildParallelism({ env });
    const buildArguments = ['-c', 'Release', '--no-restore', '-warnaserror', '-v', 'minimal',
        `/m:${cpuUnits}`, '/p:UseSharedCompilation=true', '/p:NuGetAudit=false'];
    const commands = [
        ['restore', artifacts.migrationTests.projectFile, '--locked-mode', '-v', 'minimal', '/p:NuGetAudit=false'],
        ['restore', artifacts.xunitAdapter.projectFile, '--locked-mode', '-v', 'minimal', '/p:NuGetAudit=false'],
        ['build', artifacts.migrationTests.projectFile, ...buildArguments],
        ['build', artifacts.xunitAdapter.projectFile, ...buildArguments, '--no-dependencies']
    ];
    const results = [];
    for (const [index, args] of commands.entries())
    {
        const stdoutFile = path.join(directory, `${index}.stdout`);
        const stderrFile = path.join(directory, `${index}.stderr`);
        const result = await execute(args, {
            root: options.root,
            env,
            stdoutFile,
            stderrFile
        });
        for (const file of [stdoutFile, stderrFile])
        {
            if (!fs.lstatSync(file).isFile())
            {
                throw new Error('Migration unit build requires regular captured command logs');
            }
        }
        results.push({ executable: 'dotnet', args, code: result.code, signal: result.signal });
        fs.writeFileSync(path.join(directory, 'commands.json'), `${JSON.stringify(results, null, 2)}\n`);
        if (result.code !== 0 || result.signal !== null)
        {
            throw new Error(`Migration unit build command failed: ${args[0]} ${args[1]}; logs: ${directory}`);
        }
    }
    await requireMigrationUnitBuildContext(options, env);
    return publishMigrationBuildReady(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        if (process.argv.length !== 2)
        {
            throw new Error('Migration unit build accepts only its matrix scheduler environment');
        }
        const result = await buildMigrationUnitTests({
            producer: 'backend-unit',
            root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
            runId: process.env.FSUSBLOG_TEST_RUN_ID,
            namespace: process.env.FSUSBLOG_TEST_NAMESPACE,
            sourceState: {
                commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
                worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
            }
        });
        console.log(`Migration unit build ready: ${result.file}`);
    }
    catch (error)
    {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
