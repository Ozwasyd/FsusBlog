#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const verificationCommands = [
    ['dotnet', ['build', 'src/migration/FsusBlog.Migration.csproj', '-c', 'Release', '--no-restore']],
    ['dotnet', ['test', 'tests/migration/FsusBlog.Migration.Tests.csproj', '-c', 'Release', '--no-restore']]
];
const extractedSources = new Map([
    ['src/migration/ContentAssetCutoverBackfill.cs', ['src/backend/Infrastructure/SchemaMigration/ContentAssetCutoverBackfill.cs']],
    ['src/migration/OnlineSchemaBackfillPrimitives.cs', ['src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationCoordinator.cs']],
    ['src/migration/SchemaMigrationExecution.cs', ['src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs']],
    ['src/migration/Definitions/CommentRevisionMigrationRows.cs', [
        'src/backend/Entities/Comment.cs',
        'src/backend/Entities/CommentRevision.cs'
    ]]
]);

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function walk(directory)
{
    if (!existsSync(directory))
    {
        return [];
    }
    return readdirSync(directory, { withFileTypes: true })
        .flatMap(entry =>
        {
            const fullPath = join(directory, entry.name);
            if (entry.name === 'bin' || entry.name === 'obj')
            {
                return [];
            }
            return entry.isDirectory() ? walk(fullPath) : [fullPath];
        });
}

function declaredSymbols(source)
{
    const symbols = [];
    const pattern = /\b(?:public|internal|private|protected)?\s*(?:sealed\s+|static\s+|abstract\s+|readonly\s+)*\b(?:class|interface|enum|struct|record(?:\s+(?:class|struct))?)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    for (const match of source.matchAll(pattern))
    {
        symbols.push(match[1]);
    }
    return [...new Set(symbols)].sort();
}

function git(root, args, trim = true)
{
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return result.status === 0 ? (trim ? result.stdout.trim() : result.stdout) : null;
}

const legacyRegistryPath = 'src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs';

function resolveSourceBaseCommit(root, previousReceipt)
{
    const candidates = [
        previousReceipt?.sourceTransition?.baseCommit,
        git(root, ['rev-parse', 'HEAD^']),
        git(root, ['merge-base', 'HEAD', 'origin/master']),
        git(root, ['rev-parse', 'HEAD'])
    ].filter((value, index, values) => typeof value === 'string' && value.length > 0 && values.indexOf(value) === index);
    for (const commit of candidates)
    {
        if (readOldSource(root, commit, legacyRegistryPath) !== null)
        {
            return commit;
        }
    }
    return candidates[0] ?? 'unavailable';
}

function oldPathsFor(newPath)
{
    if (extractedSources.has(newPath))
    {
        return extractedSources.get(newPath);
    }
    if (newPath.startsWith('src/migration/Catalogs/') || newPath.startsWith('src/migration/Definitions/'))
    {
        return [newPath.replace('src/migration/', 'src/backend/Infrastructure/SchemaMigration/')];
    }
    const fileName = newPath.slice('src/migration/'.length);
    if (!fileName.includes('/') && [
        'AccountSubjectHashBackfillStep.cs',
        'DestructiveMigrationProofs.cs',
        'SchemaMigrationDdlPrimitives.cs',
        'SchemaMigrationManifest.cs',
        'SchemaMigrationPrimitives.cs',
        'SchemaMigrationRegistry.cs'
    ].includes(fileName))
    {
        return [`src/backend/Infrastructure/SchemaMigration/${fileName}`];
    }
    return [];
}

function readOldSource(root, baseCommit, path)
{
    return git(root, ['show', `${baseCommit}:${path}`], false);
}

function transitionInventory(root, baseCommit, files, fallback = null)
{
    const fallbackByPath = new Map((fallback?.files ?? []).map(item => [item.newPath, item]));
    const transitions = files
        .filter(file => file.path.endsWith('.cs'))
        .map(file =>
        {
            const configuredOldPaths = oldPathsFor(file.path);
            const fallbackTransition = fallbackByPath.get(file.path);
            let historyAvailable = configuredOldPaths.length === 0;
            const oldFiles = configuredOldPaths.map(path =>
            {
                const source = readOldSource(root, baseCommit, path);
                if (source !== null)
                {
                    historyAvailable = true;
                    return { path, sha256: sha256(source), symbols: declaredSymbols(source) };
                }
                return fallbackTransition?.oldFiles?.find(item => item.path === path) ?? null;
            }).filter(Boolean);
            const oldSymbols = new Set(oldFiles.flatMap(item => item.symbols));
            return {
                newPath: file.path,
                newSha256: file.sha256,
                oldFiles,
                movedSymbols: file.symbols.filter(symbol => oldSymbols.has(symbol)),
                newSymbols: file.symbols.filter(symbol => !oldSymbols.has(symbol)),
                oldPathsDeleted: historyAvailable
                    ? oldFiles.filter(item => !existsSync(join(root, item.path))).map(item => item.path)
                    : (fallbackTransition?.oldPathsDeleted ?? [])
            };
        })
        .sort((left, right) => left.newPath.localeCompare(right.newPath));

    const oldFiles = transitions.flatMap(item => item.oldFiles)
        .filter((item, index, values) => values.findIndex(candidate => candidate.path === item.path) === index)
        .sort((left, right) => left.path.localeCompare(right.path));
    return {
        baseCommit,
        files: transitions,
        oldContentDigest: sha256(oldFiles.map(file => `${file.path}\0${file.sha256}`).join('\n')),
        deletedOldPaths: transitions.flatMap(item => item.oldPathsDeleted).sort()
    };
}

function validationResults(inputDigest, results = [])
{
    const byCommand = new Map(results.map(result => [result.command, result]));
    return verificationCommands.map(([command, args]) =>
    {
        const text = [command, ...args].join(' ');
        const existing = byCommand.get(text);
        return {
            command: text,
            status: existing?.status ?? 'not-run',
            exitCode: Number.isInteger(existing?.exitCode) ? existing.exitCode : null,
            inputDigest: existing?.inputDigest ?? inputDigest,
            summary: typeof existing?.summary === 'string' ? existing.summary : ''
        };
    });
}

export function buildReceipt(root = defaultRoot, options = {})
{
    const sourceRoot = join(root, 'src/migration');
    const files = walk(sourceRoot)
        .filter(file => file.endsWith('.cs') || file.endsWith('.csproj'))
        .map(file =>
        {
            const content = readFileSync(file);
            const path = relative(root, file).replaceAll('\\', '/');
            return {
                path,
                sha256: sha256(content),
                symbols: file.endsWith('.cs') ? declaredSymbols(content.toString('utf8')) : []
            };
        })
        .sort((left, right) => left.path.localeCompare(right.path));
    const contentDigest = sha256(files.map(file => `${file.path}\0${file.sha256}`).join('\n'));
    const testFiles = walk(join(root, 'tests/migration'))
        .filter(file => file.endsWith('.cs') || file.endsWith('.csproj') || file.endsWith('.json'))
        .map(file =>
        {
            const content = readFileSync(file);
            return {
                path: relative(root, file).replaceAll('\\', '/'),
                sha256: sha256(content)
            };
        })
        .sort((left, right) => left.path.localeCompare(right.path));
    const testContentDigest = sha256(testFiles.map(file => `${file.path}\0${file.sha256}`).join('\n'));
    const verificationInputDigest = sha256(`${contentDigest}\0${testContentDigest}`);
    const baseCommit = options.baseCommit
    ?? options.previousReceipt?.sourceTransition?.baseCommit
    ?? git(root, ['rev-parse', 'HEAD'])
    ?? 'unavailable';

    return {
        schema: 'fsusblog.migration-assembly-receipt.v2',
        identity: {
            oldProject: 'src/backend/FsusBlog.Server.csproj',
            oldAssembly: 'FsusBlog.Server',
            oldNamespace: 'FsusBlog.Server.Infrastructure.SchemaMigration',
            newProject: 'src/migration/FsusBlog.Migration.csproj',
            newAssembly: 'FsusBlog.Migration',
            newNamespace: 'FsusBlog.Migration',
            targetFramework: 'net10.0'
        },
        dependencies: {
            projectReferences: ['src/shared/FsusBlog.Shared.csproj'],
            providerPackages: ['SqlSugarCoreNoDrive']
        },
        files,
        sourceTransition: transitionInventory(root, baseCommit, files, options.previousReceipt?.sourceTransition),
        contentDigest,
        testFiles,
        testContentDigest,
        verificationInputDigest,
        verificationResults: validationResults(verificationInputDigest, options.verificationResults)
    };
}

export function receiptPath(root = defaultRoot)
{
    return join(root, 'artifacts/schema-migration/migration-assembly-receipt.json');
}

export function bindingPath(root = defaultRoot)
{
    return join(root, 'artifacts/schema-migration/migration-assembly-binding.json');
}

export function buildBinding(receipt)
{
    const receiptContent = serialized(receipt);
    return {
        schema: 'fsusblog.migration-assembly-binding.v1',
        receipt: 'artifacts/schema-migration/migration-assembly-receipt.json',
        receiptSha256: sha256(receiptContent),
        sourceContentDigest: receipt.contentDigest,
        testContentDigest: receipt.testContentDigest,
        verificationInputDigest: receipt.verificationInputDigest,
        sourceBaseCommit: receipt.sourceTransition.baseCommit,
        movedFileCount: receipt.sourceTransition.files.filter(item => item.oldFiles.length > 0).length,
        deletedOldPathCount: receipt.sourceTransition.deletedOldPaths.length,
        verificationDigest: sha256(receipt.verificationResults.map(result =>
            `${result.command}\0${result.status}\0${result.exitCode}\0${result.inputDigest}`).join('\n'))
    };
}

function serialized(value)
{
    return `${JSON.stringify(value, null, 2)}\n`;
}

function summarize(output, root)
{
    return output.replaceAll(root, '<repo>')
        .split(/\r?\n/u).map(line => line.trim()).filter(Boolean).slice(-3).join(' | ').slice(0, 1000);
}

function executeVerification(root, inputDigest, env, directory)
{
    return verificationCommands.map(([command, args], index) =>
    {
        const result = spawnSync(command, args, {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            env: { ...env, PublishClientAssets: 'false' }
        });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        process.stdout.write(output);
        for (const [stream, content] of [['stdout', result.stdout ?? ''], ['stderr', result.stderr ?? '']])
        {
            writeFileSync(join(directory, `${index}.${stream}`), content, { flag: 'wx', mode: 0o600 });
        }
        return {
            command: [command, ...args].join(' '),
            status: result.status === 0 ? 'passed' : 'failed',
            exitCode: result.status,
            inputDigest,
            summary: summarize(output, root)
        };
    });
}

const pendingSchema = 'fsusblog.migration-assembly-pending.v1';
const pendingNames = ['0.stderr', '0.stdout', '1.stderr', '1.stdout', 'pending.json'];

function exact(value, keys)
{
    return value && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

/** Only registered Migration producers can select their fixed run-private directory. */
export function migrationAssemblyPendingPaths(context)
{
    if (!exact(context, ['root', 'runId', 'namespace', 'producer', 'sourceState', 'attemptId'])
        || !['backend-tests', 'backend-unit'].includes(context.producer)
        || context.attemptId !== (context.producer === 'backend-tests' ? 'attempt-0001' : null)
        || typeof context.root !== 'string' || fs.realpathSync(context.root) !== context.root
        || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(context.runId ?? '')
        || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(context.namespace ?? '')
        || !exact(context.sourceState, ['commit', 'worktreeFingerprint'])
        || !/^[a-f0-9]{40}$/u.test(context.sourceState.commit)
        || !/^[a-f0-9]{64}$/u.test(context.sourceState.worktreeFingerprint))
    {
        throw new Error('Migration assembly pending requires a closed current-run source context');
    }
    const runRoot = join(context.root, '.tmp/test-runs', context.runId);
    const directory = context.producer === 'backend-tests'
        ? join(runRoot, 'outputs/attempts', context.attemptId, 'artifacts/migration-assembly')
        : join(runRoot, 'migration-assembly', context.producer);
    return { directory, file: join(directory, 'pending.json'),
        publication: join(runRoot, 'migration-assembly-publication', `${context.producer}.json`) };
}

function requireOwnedDirectory(root, directory, create = false, privateDirectory = true)
{
    let cursor = root;
    for (const part of relative(root, directory).split('/'))
    {
        cursor = join(cursor, part);
        if (!fs.lstatSync(cursor, { throwIfNoEntry: false }) && create)
        {
            mkdirSync(cursor, { mode: 0o700 });
        }
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()
            || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
        {
            throw new Error('Migration assembly pending requires real task-owned parent directories');
        }
    }
    const stat = fs.statSync(directory);
    if (privateDirectory && (stat.mode & 0o077) !== 0)
    {
        throw new Error('Migration assembly pending directory must be private');
    }
    return { device: stat.dev, inode: stat.ino };
}

function readOwnedFile(file, { privateFile = false } = {})
{
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || before.size > 64 * 1024 * 1024
        || (privateFile && (before.mode & 0o077) !== 0)
        || (typeof process.getuid === 'function' && before.uid !== process.getuid()))
    {
        throw new Error('Migration assembly file must be bounded, single-link, owned regular data');
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        const opened = fs.fstatSync(fd);
        const bytes = fs.readFileSync(fd);
        const after = fs.lstatSync(file);
        if (before.dev !== opened.dev || before.ino !== opened.ino
            || before.dev !== after.dev || before.ino !== after.ino
            || before.size !== bytes.length || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        {
            throw new Error('Migration assembly file changed during its owned read');
        }
        return bytes;
    }
    finally
    {
        fs.closeSync(fd);
    }
}

function captureOwnedFile(file, options = {})
{
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat)
    {
        return { file, options, bytes: null, identity: null };
    }
    const bytes = readOwnedFile(file, options);
    return { file, options, bytes,
        identity: { device: stat.dev, inode: stat.ino, size: stat.size,
            mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } };
}

function requireUnchangedOwnedFiles(observations)
{
    for (const observation of observations)
    {
        const current = captureOwnedFile(observation.file, observation.options);
        if (!isDeepStrictEqual(current.identity, observation.identity)
            || (observation.bytes !== null && (current.bytes === null || !observation.bytes.equals(current.bytes))))
        {
            throw new Error('Migration assembly pending or tracked file identity changed during its source read window');
        }
    }
}

function previousOutputs(root)
{
    return [receiptPath(root), bindingPath(root)].map(file => ({
        path: relative(root, file), sha256: existsSync(file) ? sha256(readOwnedFile(file)) : null
    }));
}

async function observeCurrentSource(root)
{
    const { snapshotSourceState } = await import('../test-matrix/scheduler.mjs');
    return snapshotSourceState(root);
}

async function requireCurrentSource(context, observeSource)
{
    if (!isDeepStrictEqual(await observeSource(context.root), context.sourceState))
    {
        throw new Error('Migration assembly current source drifted');
    }
}

async function originalBuildContext(context, { finalized = false } = {})
{
    const { resolveProductionBuildLayout, requireFinalizedProductionBuildResources } =
        await import('../test-matrix/production-build-layout.mjs');
    const layout = resolveProductionBuildLayout(context);
    if (!finalized)
    {
        const { readMigrationBuildReady } = await import('../test/migration-build-binding.mjs');
        await readMigrationBuildReady(context);
    }
    const manifest = finalized ? requireFinalizedProductionBuildResources(layout).manifest
        : JSON.parse(readOwnedFile(layout.manifestFile).toString('utf8'));
    if (manifest.owner?.namespace !== context.namespace || manifest.runId !== context.runId
        || !isDeepStrictEqual(manifest.sourceState, context.sourceState)
        || (!finalized && (manifest.status !== 'active' || manifest.owner?.state !== 'building')))
    {
        throw new Error('Migration assembly requires the original current source/build owner');
    }
    return { ownerIdentity: manifest.owner.ownerIdentity, createdAt: manifest.owner.createdAt,
        runRoot: layout.runRoot };
}

async function originalMySqlAdmission(context, env, phase)
{
    const { readMySqlFixtureAdmissionForRun } = await import('../test/mysql-fixture-admission.mjs');
    const { readRetainedMySqlFixtureLifecycle } = await import('../test-fixtures/services/mysql.mjs');
    const admission = readMySqlFixtureAdmissionForRun({
        root: context.root, runId: context.runId, namespace: context.namespace,
        bundleId: context.producer === 'backend-tests' ? 'backend-tests' : 'matrix:backend-unit',
        stepId: 'migration-services', sourceState: context.sourceState
    }, { file: env.FSUSBLOG_MYSQL_FIXTURE_ADMISSION_FILE, phase: phase === 'live' ? 'live' : 'live-or-cleaned' });
    if (phase === 'cleaned' && readRetainedMySqlFixtureLifecycle(
        admission.record.context, admission.record.bindingDigest).state.phase !== 'cleaned')
    {
        throw new Error('Migration assembly publication requires actual original MySQL cleanup');
    }
    return admission;
}

/** Run the original unfiltered two commands under the original admitted build/service owner; never publish here. */
export async function prepareMigrationAssemblyPending(context, {
    env = process.env, observeSource = observeCurrentSource, requireBuild = originalBuildContext,
    readAdmission = originalMySqlAdmission, execute = executeVerification
} = {})
{
    const paths = migrationAssemblyPendingPaths(context);
    await requireCurrentSource(context, observeSource);
    const buildOwner = await requireBuild(context);
    const admission = await readAdmission(context, env, 'live');
    requireOwnedDirectory(context.root, dirname(paths.directory), true, false);
    mkdirSync(paths.directory, { mode: 0o700 });
    const directoryIdentity = requireOwnedDirectory(context.root, paths.directory);
    const outputs = previousOutputs(context.root);
    const previousReceipt = outputs[0].sha256 ? JSON.parse(readOwnedFile(receiptPath(context.root))) : null;
    const initial = buildReceipt(context.root, { previousReceipt });
    const results = await execute(context.root, initial.verificationInputDigest,
        { ...env, ...admission.executionEnvironment, FSUSBLOG_PRODUCTION_BUILD_ROOT: buildOwner.runRoot }, paths.directory);
    if (!isDeepStrictEqual(results, validationResults(initial.verificationInputDigest, results))
        || results.some(result => result.status !== 'passed' || result.exitCode !== 0
            || result.inputDigest !== initial.verificationInputDigest))
    {
        throw new Error('Migration assembly independent unfiltered build/test verification failed; no pending publication');
    }
    await requireCurrentSource(context, observeSource);
    if (!isDeepStrictEqual(buildOwner, await requireBuild(context))
        || admission.contentDigest !== (await readAdmission(context, env, 'live')).contentDigest
        || !isDeepStrictEqual(outputs, previousOutputs(context.root)))
    {
        throw new Error('Migration assembly source/build/service/publication owner drifted during verification');
    }
    await requireCurrentSource(context, observeSource);
    const receipt = buildReceipt(context.root, {
        baseCommit: resolveSourceBaseCommit(context.root, previousReceipt), previousReceipt,
        verificationResults: results
    });
    if (receipt.verificationInputDigest !== initial.verificationInputDigest)
    {
        throw new Error('Migration assembly independent verification inputs drifted');
    }
    const files = pendingNames.filter(name => name !== 'pending.json').map(name => ({
        name, sha256: sha256(readOwnedFile(join(paths.directory, name), { privateFile: true }))
    }));
    if (!isDeepStrictEqual(requireOwnedDirectory(context.root, paths.directory), directoryIdentity)
        || !isDeepStrictEqual(readdirSync(paths.directory).sort(), files.map(file => file.name)))
    {
        throw new Error('Migration assembly pending output roster or directory changed');
    }
    const pending = { schema: pendingSchema, context, buildOwner, admissionDigest: admission.contentDigest,
        previousOutputs: outputs, receipt, binding: buildBinding(receipt), files };
    writeFileSync(paths.file, serialized(pending), { flag: 'wx', mode: 0o600 });
    return { ...paths, pendingSha256: sha256(readOwnedFile(paths.file, { privateFile: true })) };
}

/** Validate bytes from the fixed pending roster against actual current inputs, without a success-JSON capability. */
export function verifyMigrationAssemblyPending(context, pending)
{
    const paths = migrationAssemblyPendingPaths(context);
    if (fs.lstatSync(paths.publication, { throwIfNoEntry: false }))
    {
        throw new Error('Migration assembly pending publication cannot be repeated');
    }
    requireOwnedDirectory(context.root, paths.directory);
    if (!exact(pending, ['schema', 'context', 'buildOwner', 'admissionDigest', 'previousOutputs', 'receipt', 'binding', 'files'])
        || pending.schema !== pendingSchema || !isDeepStrictEqual(pending.context, context)
        || !exact(pending.buildOwner, ['ownerIdentity', 'createdAt', 'runRoot'])
        || !/^sha256:[a-f0-9]{64}$/u.test(pending.admissionDigest ?? '')
        || !Array.isArray(pending.files)
        || !isDeepStrictEqual(readdirSync(paths.directory).sort(), pendingNames)
        || !isDeepStrictEqual(pending.previousOutputs, previousOutputs(context.root))
        || !isDeepStrictEqual(pending.files?.map(file => file.name), pendingNames.filter(name => name !== 'pending.json'))
        || pending.files.some(file => !exact(file, ['name', 'sha256'])
            || file.sha256 !== sha256(readOwnedFile(join(paths.directory, file.name), { privateFile: true }))))
    {
        throw new Error('Migration assembly pending owner, bytes or closed output roster differs');
    }
    const receipt = pending.receipt;
    if (!Array.isArray(receipt?.verificationResults) || receipt.verificationResults.length !== 2
        || receipt.verificationResults.some(result => result.status !== 'passed' || result.exitCode !== 0
            || result.inputDigest !== receipt.verificationInputDigest)
        || !isDeepStrictEqual(receipt, buildReceipt(context.root, {
            previousReceipt: receipt, verificationResults: receipt.verificationResults
        })) || !isDeepStrictEqual(pending.binding, buildBinding(receipt)))
    {
        throw new Error('Migration assembly pending verification or source inventory is stale');
    }
    return paths;
}

async function readFinalizedPending(context, {
    env = process.env, observeSource = observeCurrentSource, requireBuild = originalBuildContext,
    readAdmission = originalMySqlAdmission
} = {})
{
    const paths = migrationAssemblyPendingPaths(context);
    requireOwnedDirectory(context.root, paths.directory);
    const observations = [captureOwnedFile(paths.file, { privateFile: true }),
        ...[receiptPath(context.root), bindingPath(context.root)].map(file => captureOwnedFile(file))];
    const bytes = observations[0].bytes;
    const pending = JSON.parse(bytes);
    verifyMigrationAssemblyPending(context, pending);
    await requireCurrentSource(context, observeSource);
    if (!isDeepStrictEqual(pending.buildOwner, await requireBuild(context, { finalized: true }))
        || pending.admissionDigest !== (await readAdmission(context, env, 'cleaned')).contentDigest)
    {
        throw new Error('Migration assembly publication crosses its original finalized build/service owner');
    }
    await requireCurrentSource(context, observeSource);
    requireUnchangedOwnedFiles(observations);
    verifyMigrationAssemblyPending(context, pending);
    return { paths, pending, bytes, observations };
}

/** A fresh final candidate consumes its real two-command pending result without rewriting time-dependent tracked summaries. */
export async function verifyCurrentMigrationAssembly(context, adapters = {})
{
    const { pending, bytes, observations } = await readFinalizedPending(context, adapters);
    const receipt = JSON.parse(observations[1].bytes);
    const binding = JSON.parse(observations[2].bytes);
    if (!isDeepStrictEqual(receipt, buildReceipt(context.root, {
        previousReceipt: receipt, verificationResults: receipt.verificationResults
    })) || !isDeepStrictEqual(binding, buildBinding(receipt))
        || receipt.verificationInputDigest !== pending.receipt.verificationInputDigest
        || !Array.isArray(receipt.verificationResults) || receipt.verificationResults.length !== 2
        || receipt.verificationResults.some(result => result.status !== 'passed' || result.exitCode !== 0
            || result.inputDigest !== receipt.verificationInputDigest))
    {
        throw new Error('Migration assembly fresh current-run evidence differs from the tracked source/binding');
    }
    await requireCurrentSource(context, adapters.observeSource ?? observeCurrentSource);
    requireUnchangedOwnedFiles(observations);
    verifyMigrationAssemblyPending(context, pending);
    return { status: 'verified-current-run', pendingSha256: sha256(bytes), sourceState: context.sourceState,
        qualificationEligible: false, reason: 'assembly producer verified; full native/domain/CI independent acceptance is separate' };
}

/** Publish only the original validated pending pair after its actual owner cleanup/finalization; the new candidate needs a fresh run. */
export async function publishMigrationAssemblyPending(context, adapters = {})
{
    const { paths, pending, bytes, observations } = await readFinalizedPending(context, adapters);
    const { observeSource = observeCurrentSource, rename = fs.renameSync } = adapters;
    const targets = [receiptPath(context.root), bindingPath(context.root)];
    const original = targets.map(file => existsSync(file) ? readOwnedFile(file) : null);
    const staged = ['receipt', 'binding'].map(name => join(dirname(paths.publication), `${context.producer}.${name}.pending`));
    const contents = [serialized(pending.receipt), serialized(pending.binding)];
    const owned = [];
    let published = 0;
    let publicationError = null;
    const cleanupErrors = [];
    try
    {
        requireOwnedDirectory(context.root, dirname(paths.publication), true);
        if (readdirSync(dirname(paths.publication)).length !== 0)
        {
            throw new Error('Migration assembly publication refuses unknown retained staging');
        }
        for (const file of targets)
        {
            requireOwnedDirectory(context.root, dirname(file), true, false);
        }
        for (const [index, file] of staged.entries())
        {
            writeFileSync(file, contents[index], { flag: 'wx', mode: 0o600 });
            const stat = fs.lstatSync(file);
            owned.push({ file, device: stat.dev, inode: stat.ino, sha256: sha256(contents[index]) });
        }
        await requireCurrentSource(context, observeSource);
        requireUnchangedOwnedFiles(observations);
        verifyMigrationAssemblyPending(context, pending);
        for (const entry of owned)
        {
            const stat = fs.lstatSync(entry.file);
            if (stat.dev !== entry.device || stat.ino !== entry.inode
                || sha256(readOwnedFile(entry.file, { privateFile: true })) !== entry.sha256)
            {
                throw new Error('Migration assembly staged publication identity changed');
            }
        }
        for (const [index, file] of staged.entries())
        {
            rename(file, targets[index]);
            published++;
        }
        for (const [index, file] of targets.entries())
        {
            if (!readOwnedFile(file).equals(Buffer.from(contents[index])))
            {
                throw new Error('Migration assembly published bytes differ from their original pending owner');
            }
        }
        requireOwnedDirectory(context.root, dirname(paths.publication), true);
        writeFileSync(paths.publication, serialized({
            schema: 'fsusblog.migration-assembly-publication.v1', pendingSha256: sha256(bytes),
            sourceState: context.sourceState, outputs: previousOutputs(context.root),
            qualificationEligible: false, reason: 'tracked publication changes candidate; fresh final-candidate execution required'
        }), { flag: 'wx', mode: 0o600 });
    }
    catch (error)
    {
        publicationError = error;
        for (let index = published - 1; index >= 0; index--)
        {
            try
            {
                if (!readOwnedFile(targets[index]).equals(Buffer.from(contents[index])))
                {
                    throw new Error('Migration assembly publication rollback refused foreign tracked bytes');
                }
                if (original[index] === null)
                {
                    fs.unlinkSync(targets[index]);
                }
                else
                {
                    const fd = fs.openSync(targets[index], fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
                    try
                    {
                        const stat = fs.fstatSync(fd);
                        const named = fs.lstatSync(targets[index]);
                        if (stat.dev !== named.dev || stat.ino !== named.ino || stat.nlink !== 1)
                        {
                            throw new Error('Migration assembly publication rollback target identity changed');
                        }
                        fs.ftruncateSync(fd, 0);
                        fs.writeFileSync(fd, original[index]);
                        fs.fsyncSync(fd);
                    }
                    finally
                    {
                        fs.closeSync(fd);
                    }
                }
            }
            catch (cleanupError)
            {
                cleanupErrors.push(cleanupError);
            }
        }
    }
    finally
    {
        for (const entry of owned)
        {
            try
            {
                const stat = fs.lstatSync(entry.file, { throwIfNoEntry: false });
                if (stat)
                {
                    if (stat.isSymbolicLink() || stat.dev !== entry.device || stat.ino !== entry.inode
                        || sha256(readOwnedFile(entry.file, { privateFile: true })) !== entry.sha256)
                    {
                        throw new Error('Migration assembly failed-publication cleanup refused a foreign staged file');
                    }
                    fs.unlinkSync(entry.file);
                }
            }
            catch (cleanupError)
            {
                cleanupErrors.push(cleanupError);
            }
        }
    }
    if (cleanupErrors.length)
    {
        throw new AggregateError([...(publicationError ? [publicationError] : []), ...cleanupErrors],
            `Migration assembly publication cleanup incomplete: ${publicationError?.message ?? cleanupErrors[0].message}`,
            { cause: publicationError ?? cleanupErrors[0] });
    }
    if (publicationError)
    {
        throw publicationError;
    }
    return { receipt: targets[0], binding: targets[1], qualificationEligible: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    try
    {
        const args = process.argv.slice(2);
        let root = defaultRoot;
        let operation = 'check';
        let producer = 'backend-tests';
        const seen = new Set();
        for (let index = 0; index < args.length; index++)
        {
            const argument = args[index];
            if (seen.has(argument))
            {
                throw new Error('Migration assembly producer rejects duplicate options');
            }
            seen.add(argument);
            if (argument === '--root' && args[index + 1] && !args[index + 1].startsWith('--'))
            {
                root = resolve(args[++index]);
            }
            else if (argument === '--backend-unit')
            {
                producer = 'backend-unit';
            }
            else if (['--write', '--publish-current-run', '--verify-current-run'].includes(argument) && operation === 'check')
            {
                operation = argument === '--write' ? 'prepare' : argument === '--publish-current-run' ? 'publish' : 'verify';
            }
            else
            {
                throw new Error('Migration assembly producer accepts only --root, --backend-unit and one canonical operation');
            }
        }
        if (operation === 'check')
        {
            if (producer !== 'backend-tests')
            {
                throw new Error('Migration assembly check has no execution producer override');
            }
            const previousReceipt = existsSync(receiptPath(root)) ? JSON.parse(readFileSync(receiptPath(root), 'utf8')) : null;
            const expectedReceipt = serialized(buildReceipt(root, {
                previousReceipt, verificationResults: previousReceipt?.verificationResults ?? []
            }));
            const expectedBinding = previousReceipt ? serialized(buildBinding(JSON.parse(expectedReceipt))) : '';
            if (!existsSync(receiptPath(root)) || readFileSync(receiptPath(root), 'utf8') !== expectedReceipt
                || !existsSync(bindingPath(root)) || readFileSync(bindingPath(root), 'utf8') !== expectedBinding)
            {
                throw new Error('receipt or binding is missing/stale; use the admitted current-run --write producer');
            }
            console.log('[migration-assembly-receipt] ok');
        }
        else
        {
            const context = {
                root, producer, runId: process.env.FSUSBLOG_TEST_RUN_ID,
                namespace: process.env.FSUSBLOG_TEST_NAMESPACE,
                attemptId: producer === 'backend-tests' ? process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID : null,
                sourceState: {
                    commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
                    worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
                }
            };
            const result = operation === 'prepare'
                ? await prepareMigrationAssemblyPending(context) : operation === 'publish'
                    ? await publishMigrationAssemblyPending(context) : await verifyCurrentMigrationAssembly(context);
            console.log(`[migration-assembly-receipt] ${operation}: ${JSON.stringify(result)}`);
        }
    }
    catch (error)
    {
        console.error(`[migration-assembly-receipt] ${error.message}`);
        process.exitCode = 1;
    }
}
