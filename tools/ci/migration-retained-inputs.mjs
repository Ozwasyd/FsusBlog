import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    computeConsumedInputDigests,
    digestPath,
    digestValue,
    resolveDotnetProjectSourceClosure,
    sealSourceIdentity
} from '../fact-extractors/identity.mjs';
import { collectProductionInputTree, verifyProductionBuildReceipt } from './production-build-artifacts.mjs';

const project = 'src/migration/FsusBlog.Migration.csproj';
const snapshotName = 'migration-retained-inputs.json';
export const migrationRetainedInputsSchema = 'fsusblog.migration-retained-inputs.v1';

// Measurement belongs to the original production build owner. This is neither a
// build receipt nor a JSON approval: the lane captures before execution, compares
// after execution, and the original production receipt seals the actual DLL tree.
export function captureMigrationRetainedInputs({ root, sdkRoot })
{
    const actualSdk = path.resolve(sdkRoot);
    const executable = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
    const resolvedHost = String(process.env.PATH ?? '').split(path.delimiter)
        .filter(Boolean).map(directory => path.resolve(directory, executable))
        .find(file =>
        {
            try
            {
                fs.accessSync(file, fs.constants.X_OK);
                return fs.statSync(file).isFile();
            }
            catch
            {
                return false;
            }
        });
    if (!resolvedHost || fs.realpathSync(resolvedHost) !== path.join(actualSdk, executable))
    {
        throw new Error('migration retained SDK does not own the actual PATH-selected dotnet host');
    }
    const sourceIdentity = sealSourceIdentity(root);
    const sourceDigests = computeConsumedInputDigests(root, resolveDotnetProjectSourceClosure(root, [project]));
    const configurationPaths = ['Directory.Build.props', 'Directory.Packages.props', project,
        'tools/build-with-data-env.sh', 'tools/test/lanes/production-build-artifacts.sh',
        'tools/ci/migration-retained-inputs.mjs', 'tools/ci/production-build-artifacts.mjs'];
    for (const file of ['Directory.Build.targets', 'global.json', 'NuGet.Config', 'NuGet.config', 'nuget.config'])
    {
        if (fs.existsSync(path.join(root, file))) configurationPaths.push(file);
    }
    const configurationDigests = computeConsumedInputDigests(root, configurationPaths);
    const sdkFiles = collectProductionInputTree(sdkRoot);
    const after = sealSourceIdentity(root);
    if (JSON.stringify(sourceIdentity) !== JSON.stringify(after))
    {
        throw new Error('migration retained source changed during capture');
    }
    return { schema: migrationRetainedInputsSchema, sourceIdentity, sourceDigests, configurationDigests, sdkFiles };
}

export function validateMigrationRetainedInputs(saved, actual)
{
    if (JSON.stringify(saved) !== JSON.stringify(actual) || actual.schema !== migrationRetainedInputsSchema)
    {
        throw new Error('migration retained source, SDK or configuration inputs changed');
    }
    return {
        SourceRevision: actual.sourceIdentity.sourceCommit,
        WorktreeDigest: actual.sourceIdentity.worktreeFingerprint,
        ToolchainDigest: digestValue(actual.sdkFiles),
        ConfigurationDigest: digestValue({ project, configuration: 'Release', targetFramework: 'net10.0',
            configurationDigests: actual.configurationDigests })
    };
}

export function readProductionRetainedMigrationTool({ root, artifactRoot, sdkRoot })
{
    const actual = captureMigrationRetainedInputs({ root, sdkRoot });
    const { receipt } = verifyProductionBuildReceipt({ artifactRoot, expectedSourceState: {
        commit: actual.sourceIdentity.sourceCommit, worktreeFingerprint: actual.sourceIdentity.worktreeFingerprint
    }, expectedInputRoot: root, repairReadOnlySeal: false });
    if (receipt.build.command !== 'tools/test/lanes/production-build-artifacts.sh')
    {
        throw new Error('migration retention requires the original production build entry');
    }
    const domain = receipt.domains.find(value => value.name === 'migration-runtime');
    if (!domain || domain.consumerMode !== 'read-only' || domain.path !== 'payload/migration-runtime')
    {
        throw new Error('migration retained production domain missing');
    }
    const snapshotPath = `${domain.path}/${snapshotName}`;
    const assemblyPath = `${domain.path}/FsusBlog.Migration.dll`;
    const snapshot = receipt.artifacts.find(value => value.path === snapshotPath);
    const assembly = receipt.artifacts.find(value => value.path === assemblyPath);
    if (!snapshot || !assembly)
    {
        throw new Error('migration retained original snapshot or assembly missing');
    }
    const identity = validateMigrationRetainedInputs(
        JSON.parse(fs.readFileSync(path.join(artifactRoot, snapshotPath), 'utf8')), actual);
    return { Identity: identity, AssemblyPath: path.resolve(artifactRoot, assemblyPath),
        AssemblySha256: assembly.sha256.replace(/^sha256:/u, ''),
        ReceiptPath: path.resolve(artifactRoot, 'receipt.json'),
        ReceiptSha256: digestPath(artifactRoot, 'receipt.json') };
}

function writeNew(file, value)
{
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const [operation, root, artifactRoot, sdkRoot] = process.argv.slice(2);
    if (!root || !artifactRoot || !sdkRoot || process.argv.length !== 6)
    {
        throw new Error('retained migration inputs require operation, root, artifact root and physical SDK root');
    }
    const beforeFile = path.join(artifactRoot, 'migration-inputs-before.json');
    if (operation === 'begin')
    {
        writeNew(beforeFile, captureMigrationRetainedInputs({ root, sdkRoot }));
    }
    else if (operation === 'finish')
    {
        const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
        const actual = captureMigrationRetainedInputs({ root, sdkRoot });
        validateMigrationRetainedInputs(before, actual);
        writeNew(path.join(artifactRoot, 'payload/migration-runtime', snapshotName), actual);
        // Retain the exact original before bytes inside the original receipt's
        // sealed domain. An unclaimed sidecar at the artifact root is forbidden.
        fs.linkSync(beforeFile, path.join(artifactRoot, 'payload/migration-runtime/migration-inputs-before.json'));
        fs.unlinkSync(beforeFile);
    }
    else if (operation === 'read')
    {
        process.stdout.write(`${JSON.stringify(readProductionRetainedMigrationTool({ root, artifactRoot, sdkRoot }))}\n`);
    }
    else
    {
        throw new Error('unknown retained migration input operation');
    }
}
