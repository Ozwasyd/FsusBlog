import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { verifyMutationRootTerminal } from './release-mutation-attempt-root.mjs';

function digest(value)
{
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function canonicalJson(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object')
    {
        return `{${Object.keys(value).sort().map(
            (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        ).join(',')}}`;
    }
    return JSON.stringify(value);
}

function canonicalDigest(value)
{
    return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function bytesDigest(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function semanticIdentity(mutant)
{
    return {
        sourceFile: mutant.sourceFile,
        sourceFileDigest: mutant.sourceFileDigest,
        operator: mutant.operator,
        startLine: mutant.startLine,
        startColumn: mutant.startColumn,
        endLine: mutant.endLine,
        endColumn: mutant.endColumn,
        originalDigest: mutant.originalDigest,
        replacementDigest: mutant.replacementDigest
    };
}

function semanticIdentityDigest(inventory)
{
    return canonicalDigest(inventory
        .map(semanticIdentity)
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))));
}

function validateSemanticInventory(receipt, label)
{
    const inventory = receipt?.inventory ?? receipt?.mutants;
    if (!Array.isArray(inventory) || inventory.length === 0)
    {
        throw new Error(`${label} semantic mutant inventory is missing`);
    }
    for (const mutant of inventory)
    {
        const identity = semanticIdentity(mutant);
        if (Object.values(identity).some((value) => value === undefined || value === null || value === ''))
        {
            throw new Error(`${label} mutant semantic identity is incomplete`);
        }
        if ((mutant.mutantId ?? mutant.id) !== canonicalDigest(identity))
        {
            throw new Error(`${label} mutant ID is not bound to operator, source location, and original/replacement content`);
        }
    }
    if (receipt.semanticMutantIdentityDigest !== semanticIdentityDigest(inventory))
    {
        throw new Error(`${label} semantic mutant identity digest mismatch`);
    }
    if (receipt.inventoryDigest && receipt.inventoryDigest !== canonicalDigest(inventory))
    {
        throw new Error(`${label} result inventory digest mismatch`);
    }
    return inventory;
}

function compilerIdentity(compiler)
{
    return compiler && {
        configuration: compiler.configuration,
        project: compiler.project,
        sourceConfigDigest: compiler.sourceConfigDigest,
        releaseConfigDigest: compiler.releaseConfigDigest,
        buildRoot: compiler.buildRoot,
        properties: compiler.properties
    };
}

function validateCompilerIdentity(compiler, expectedConfiguration)
{
    const identity = compilerIdentity(compiler);
    if (!compiler?.optionsDigest || compiler.optionsDigest !== digest(identity))
    {
        throw new Error(`${expectedConfiguration} compiler option identity is missing or invalid`);
    }
    const symbols = String(compiler.properties?.DefineConstants ?? '').split(';');
    const expectedOptimize = expectedConfiguration === 'Release' ? 'true' : 'false';
    const expectedSymbol = expectedConfiguration.toUpperCase();
    const forbiddenSymbol = expectedConfiguration === 'Release' ? 'DEBUG' : 'RELEASE';
    if (compiler.configuration !== expectedConfiguration
        || compiler.project !== 'src/core/FsusBlog.Core.csproj'
        || compiler.properties?.AssemblyName !== 'FsusBlog.Core'
        || compiler.properties?.Configuration !== expectedConfiguration
        || compiler.properties?.Optimize !== expectedOptimize
        || !symbols.includes(expectedSymbol)
        || symbols.includes(forbiddenSymbol))
    {
        throw new Error(`${expectedConfiguration} compiler symbols/options are not production ${expectedConfiguration}`);
    }
    return identity;
}

export function releaseArtifactDigest(directory)
{
    const files = [];
    const visit = (current) =>
    {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }))
        {
            const file = path.join(current, entry.name);
            if (entry.isSymbolicLink())
            {
                throw new Error('release artifact closure contains a filesystem alias');
            }
            if (entry.isDirectory())
            {
                visit(file);
            }
            else if (entry.isFile() && entry.name !== 'release-parity-receipt.json')
            {
                files.push(path.relative(directory, file).replaceAll(path.sep, '/'));
            }
            else if (!entry.isDirectory() && !entry.isFile())
            {
                throw new Error('release artifact closure contains a nonregular filesystem entry');
            }
        }
    };
    visit(directory);
    return bytesDigest(files.sort().map(
        (file) => `${file}:${bytesDigest(fs.readFileSync(path.join(directory, file)))}`
    ).join('\n'));
}

export async function verifyReleaseArtifactBinding(releaseParityResult, repositoryRoot = process.cwd())
{
    const owner = releaseParityResult.attemptRoot;
    if (!owner || owner.forbiddenRoots?.[0] !== fs.realpathSync(repositoryRoot)
        || releaseParityResult.artifact.root !== owner.root
        || releaseParityResult.artifact.buildRoot !== owner.paths.build)
    {
        throw new Error('release artifact has no exact current-attempt root owner');
    }
    await verifyMutationRootTerminal(owner, {
        runId: releaseParityResult.runId, invocationId: releaseParityResult.invocationId,
        attemptId: releaseParityResult.attemptId, sourceState: releaseParityResult.sourceState,
        buildReceiptDigest: owner.immutableBuild.contentDigest
    }, releaseParityResult.terminal);
    const root = path.resolve(repositoryRoot, releaseParityResult.artifact.root);
    const assembly = path.resolve(repositoryRoot, releaseParityResult.artifact.assembly.path);
    const smokeEvidence = path.resolve(repositoryRoot, releaseParityResult.artifact.smoke.evidencePath);
    const smokeTrx = path.resolve(repositoryRoot, releaseParityResult.artifact.smoke.trxPath);
    if (!assembly.startsWith(`${root}${path.sep}`) || !fs.existsSync(assembly)
        || !smokeEvidence.startsWith(`${root}${path.sep}`) || !fs.existsSync(smokeEvidence)
        || !smokeTrx.startsWith(`${root}${path.sep}`) || !fs.existsSync(smokeTrx))
    {
        throw new Error('release artifact or executed smoke evidence is missing or escapes the run root');
    }
    if (releaseParityResult.artifact.digest !== releaseArtifactDigest(root)
        || releaseParityResult.artifact.assembly.digest !== bytesDigest(fs.readFileSync(assembly))
        || releaseParityResult.artifact.smoke.evidenceDigest !== bytesDigest(fs.readFileSync(smokeEvidence))
        || releaseParityResult.artifact.smoke.trxDigest !== bytesDigest(fs.readFileSync(smokeTrx)))
    {
        throw new Error('release artifact digest binding mismatch');
    }
    const evidence = JSON.parse(fs.readFileSync(smokeEvidence, 'utf8'));
    const trx = fs.readFileSync(smokeTrx, 'utf8');
    if (evidence.exitCode !== 0
        || evidence.loadedAssemblyPath !== releaseParityResult.artifact.assembly.path
        || evidence.loadedAssemblyDigest !== releaseParityResult.artifact.assembly.digest
        || evidence.trxPath !== releaseParityResult.artifact.smoke.trxPath
        || evidence.trxDigest !== releaseParityResult.artifact.smoke.trxDigest
        || evidence.canonicalAffectedTestsPassed !== true
        || evidence.aedsEncodeDecodeContractPassed !== true
        || !/<ResultSummary outcome="Completed">/u.test(trx)
        || !/<Counters [^>]*failed="0"/u.test(trx)
        || !/<Counters [^>]*passed="[1-9][0-9]*"/u.test(trx)
        || !/AedsEncoderTests/u.test(trx)
        || JSON.stringify(evidence.killedMutantIds) !== JSON.stringify(
            releaseParityResult.artifact.smoke.killedMutantIds
        ))
    {
        throw new Error('release artifact smoke did not execute the bound production assembly and prove selected mutants killed');
    }
    return true;
}

export function resolveReleaseMutationSubset(sourceMutationResult, selectionPolicy)
{
    if (!Array.isArray(selectionPolicy?.subset) || selectionPolicy.subset.length === 0)
    {
        throw new Error('release parity requires a fixed non-empty subset');
    }
    if (selectionPolicy.subset.some((entry) => !entry.operator || !entry.sourceRegion))
    {
        throw new Error('release subset must bind operator and source region');
    }
    if (selectionPolicy.subsetDigest !== digest(selectionPolicy.subset))
    {
        throw new Error('release subset digest is invalid');
    }
    if (!Array.isArray(selectionPolicy.requiredOperators)
        || !Array.isArray(selectionPolicy.requiredSourceRegions)
        || selectionPolicy.requiredOperators.length === 0
        || selectionPolicy.requiredSourceRegions.length === 0)
    {
        throw new Error('release subset policy must declare required operators and source regions');
    }
    const actualOperators = [...new Set(selectionPolicy.subset.map(({ operator }) => operator))].sort();
    const actualRegions = [...new Set(selectionPolicy.subset.map(({ sourceRegion }) => sourceRegion))].sort();
    const requiredOperators = [...new Set(selectionPolicy.requiredOperators)].sort();
    const requiredRegions = [...new Set(selectionPolicy.requiredSourceRegions)].sort();
    if (JSON.stringify(actualOperators) !== JSON.stringify(requiredOperators)
        || JSON.stringify(actualRegions) !== JSON.stringify(requiredRegions))
    {
        throw new Error('release subset does not cover every required operator and source region');
    }
    const inventory = sourceMutationResult?.inventory ?? sourceMutationResult?.mutants;
    if (!Array.isArray(inventory))
    {
        throw new Error('source mutation authority inventory is missing');
    }
    const selected = selectionPolicy.subset.map((rule) =>
    {
        const candidates = inventory.filter((mutant) => ['Killed', 'Survived', 'Timeout'].includes(mutant.status)
            && mutant.operator === rule.operator
            && mutant.sourceFile === rule.sourceRegion)
            .sort((left, right) => String(left.mutantId ?? left.id).localeCompare(String(right.mutantId ?? right.id)));
        if (candidates.length === 0)
        {
            throw new Error(`release subset has no executable same-authority mutant for ${rule.operator} ${rule.sourceRegion}`);
        }
        const mutant = candidates[0];
        return { ...rule, mutantId: mutant.mutantId ?? mutant.id };
    });
    if (new Set(selected.map((entry) => entry.mutantId)).size !== selected.length)
    {
        throw new Error('release subset rules resolve to duplicate mutants');
    }
    return { subset: selected, resolvedSubsetDigest: digest(selected) };
}

export function validateMutationReleaseParity({ sourceMutationResult, releaseParityResult, selectionPolicy })
{
    if (sourceMutationResult?.evidenceClass !== 'source-level')
    {
        throw new Error('source mutation receipt must be source-level');
    }
    if (releaseParityResult?.evidenceClass !== 'release-artifact')
    {
        throw new Error('release parity receipt must be release-artifact');
    }
    const sourceInventory = validateSemanticInventory(sourceMutationResult, 'source mutation');
    const releaseInventory = validateSemanticInventory(releaseParityResult, 'release mutation');
    if (!sourceMutationResult.config?.sha256
        || releaseParityResult.sourceAuthority?.configDigest !== sourceMutationResult.config.sha256
        || !releaseParityResult.sourceAuthority?.inventoryDigest
        || releaseParityResult.sourceAuthority.inventoryDigest !== sourceMutationResult.inventoryDigest)
    {
        throw new Error('release parity source authority config or inventory digest mismatch');
    }
    if (!releaseParityResult.resultInventoryDigest
        || releaseParityResult.resultInventoryDigest !== canonicalDigest(releaseInventory))
    {
        throw new Error('release parity result inventory digest mismatch');
    }
    const resolved = resolveReleaseMutationSubset(sourceMutationResult, selectionPolicy);
    if (releaseParityResult.resolvedSubsetDigest !== resolved.resolvedSubsetDigest)
    {
        throw new Error('release parity resolved subset identity mismatch');
    }
    if (sourceMutationResult.semanticMutantIdentityDigest
        !== releaseParityResult.semanticMutantIdentityDigest)
    {
        throw new Error('release parity semantic mutant identity inventory digest mismatch');
    }
    const artifactRoot = String(releaseParityResult.artifact?.root ?? '');
    const buildRoot = String(releaseParityResult.artifact?.buildRoot ?? artifactRoot);
    if (!releaseParityResult.artifact?.digest
        || releaseParityResult.artifact?.assembly?.name !== 'FsusBlog.Core.dll'
        || !releaseParityResult.artifact?.assembly?.digest
        || !releaseParityResult.artifact?.smoke?.evidenceDigest
        || !releaseParityResult.artifact?.smoke?.trxDigest
        || !Array.isArray(releaseParityResult.artifact?.smoke?.killedMutantIds)
        || !path.isAbsolute(artifactRoot)
        || !releaseParityResult.attemptRoot
        || releaseParityResult.attemptRoot.schema !== 'fsusblog.release-mutation-attempt-root.v1'
        || releaseParityResult.attemptRoot.root !== artifactRoot
        || releaseParityResult.attemptRoot.paths?.build !== buildRoot
        || buildRoot !== path.join(artifactRoot, 'build')
        || releaseParityResult.attemptRoot.runId !== releaseParityResult.runId
        || releaseParityResult.attemptRoot.invocationId !== releaseParityResult.invocationId
        || releaseParityResult.attemptRoot.attemptId !== releaseParityResult.attemptId
        || JSON.stringify(releaseParityResult.attemptRoot.sourceState) !== JSON.stringify(releaseParityResult.sourceState)
        || !releaseParityResult.terminal?.fileDigest
        || releaseParityResult.terminal.path !== path.join(artifactRoot, 'root-terminal.json')
        || /(^|\/)(bin|obj)\/(Debug|Release)(\/|$)/u.test(artifactRoot))
    {
        throw new Error('release parity must bind isolated artifact smoke and run-bound build root');
    }
    const compiler = releaseParityResult.compiler;
    validateCompilerIdentity(compiler, 'Release');
    const debugCompiler = releaseParityResult.debugCompiler;
    validateCompilerIdentity(debugCompiler, 'Debug');
    if (debugCompiler.sourceConfigDigest !== compiler.sourceConfigDigest
        || debugCompiler.releaseConfigDigest !== compiler.releaseConfigDigest
        || debugCompiler.buildRoot !== compiler.buildRoot)
    {
        throw new Error('Debug and Release compiler identities are not bound to the same configs and build root');
    }
    const comparison = releaseParityResult.configurationComparison;
    if (!comparison?.debugArtifactDigest
        || !comparison.releaseArtifactDigest
        || comparison.releaseArtifactDigest !== releaseParityResult.artifact.assembly.digest
        || !['same-assembly-bytes', 'configuration-different-assembly-bytes'].includes(comparison.ilClassification)
        || !['same-source-branch', 'conditional-source-branch-different'].includes(comparison.sourceBranchClassification)
        || comparison.debugCompilerOptionsDigest !== debugCompiler.optionsDigest
        || comparison.releaseCompilerOptionsDigest !== compiler.optionsDigest)
    {
        throw new Error('Debug/Release source-branch and assembly-bytecode comparison is missing');
    }
    const source = new Map(sourceInventory.map((mutant) => [mutant.id ?? mutant.mutantId, mutant.status]));
    const release = new Map(releaseInventory.map((mutant) => [mutant.id ?? mutant.mutantId, mutant.status]));
    for (const [mutantId, sourceStatus] of source)
    {
        if (!release.has(mutantId))
        {
            throw new Error(`release parity missing authority mutant ${mutantId}`);
        }
        if (release.get(mutantId) !== sourceStatus)
        {
            throw new Error(`debug/release parity status differs for ${mutantId}`);
        }
    }
    for (const entry of resolved.subset)
    {
        if (!source.has(entry.mutantId) || !release.has(entry.mutantId))
        {
            throw new Error(`release parity missing selected mutant ${entry.mutantId}`);
        }
        if (source.get(entry.mutantId) !== 'Killed' || release.get(entry.mutantId) !== 'Killed')
        {
            throw new Error(`debug/release parity failed for ${entry.mutantId}`);
        }
    }
    const selectedIds = resolved.subset.map(({ mutantId }) => mutantId).sort();
    const smokeKilledIds = [...releaseParityResult.artifact.smoke.killedMutantIds].sort();
    if (JSON.stringify(smokeKilledIds) !== JSON.stringify(selectedIds))
    {
        throw new Error('release artifact smoke is not bound to every selected killed mutant');
    }
    return true;
}
