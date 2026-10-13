import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { createMutationAttemptRoot, writeMutationRootTerminal } =
    await import(new URL('../../../tools/test/release-mutation-attempt-root.mjs', import.meta.url));
const { releaseArtifactDigest, resolveReleaseMutationSubset } =
    await import(new URL('../../../tools/test/mutation-release-parity.mjs', import.meta.url));

const bytesDigest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonical = value => Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
        ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value);
const identityDigest = value => createHash('sha256').update(canonical(value)).digest('hex');

// Controlled verifier inputs only. These never serve as a real mutation run receipt.
export async function controlledMutationParityFixture({
    repositoryRoot, runId, invocationId, sourceState, buildReceiptPath, buildReceiptDigest, policy, context
})
{
    const outputRoot = `${repositoryRoot}-mutation-fixture-${randomUUID()}`;
    context.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
    const owner = await createMutationAttemptRoot({
        repositoryRoot, outputRoot, runId, invocationId, attemptId: `${invocationId}.attempt-1`,
        sourceState, buildReceiptPath, buildReceiptDigest
    });
    const identities = policy.subset.map((rule, index) => ({
        sourceFile: rule.sourceRegion, sourceFileDigest: bytesDigest('controlled source'), operator: rule.operator,
        startLine: index + 1, startColumn: 1, endLine: index + 1, endColumn: 2,
        originalDigest: bytesDigest(`original-${index}`), replacementDigest: bytesDigest(`replacement-${index}`)
    }));
    const inventory = identities.map(identity => ({ ...identity, mutantId: identityDigest(identity), status: 'Killed' }));
    const source = {
        evidenceClass: 'source-level', config: { sha256: bytesDigest('controlled Debug config') }, inventory,
        inventoryDigest: identityDigest(inventory),
        semanticMutantIdentityDigest: identityDigest([...identities].sort((left, right) => canonical(left).localeCompare(canonical(right))))
    };
    const subset = resolveReleaseMutationSubset(source, policy);
    const killedMutantIds = subset.subset.map(entry => entry.mutantId).sort();
    const reportPath = path.join(owner.paths.physical, 'controlled-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({ fixture: 'controlled, not runtime evidence', inventory }));
    const assembly = path.join(owner.paths.build, 'FsusBlog.Core.dll');
    fs.writeFileSync(assembly, 'controlled assembly fixture, not executable runtime evidence');
    const assemblyDigest = bytesDigest(fs.readFileSync(assembly));
    const trxPath = path.join(owner.paths.smoke, 'controlled.trx');
    fs.writeFileSync(trxPath, '<TestRun><ResultSummary outcome="Completed"><Counters passed="1" failed="0"/></ResultSummary><UnitTest name="AedsEncoderTests"/></TestRun>');
    const trxDigest = bytesDigest(fs.readFileSync(trxPath));
    const smokePath = path.join(owner.paths.smoke, 'controlled-smoke.json');
    fs.writeFileSync(smokePath, JSON.stringify({
        fixture: 'controlled, not runtime evidence', exitCode: 0,
        loadedAssemblyPath: assembly, loadedAssemblyDigest: assemblyDigest,
        trxPath, trxDigest, canonicalAffectedTestsPassed: true, aedsEncodeDecodeContractPassed: true, killedMutantIds
    }));
    const compiler = configuration =>
    {
        const identity = {
            configuration, project: 'src/core/FsusBlog.Core.csproj', sourceConfigDigest: source.config.sha256,
            releaseConfigDigest: bytesDigest('controlled Release config'), buildRoot: owner.paths.build,
            properties: { AssemblyName: 'FsusBlog.Core', Configuration: configuration,
                Optimize: configuration === 'Release' ? 'true' : 'false', DefineConstants: `TRACE;${configuration.toUpperCase()}` }
        };
        return { ...identity, optionsDigest: bytesDigest(JSON.stringify(identity)) };
    };
    const debugCompiler = compiler('Debug');
    const releaseCompiler = compiler('Release');
    const terminal = writeMutationRootTerminal(owner, {
        runId, invocationId, attemptId: owner.attemptId, sourceState, buildReceiptDigest
    }, { phase: 'controlled-fixture-complete', producerSpawned: true, producerOutcome: { exitCode: 0, signal: null },
        authoritativeEvidence: { path: reportPath, fileDigest: bytesDigest(fs.readFileSync(reportPath)) } });
    const parity = {
        schema: 'fsusblog.release-mutation-parity-receipt.v1', evidenceClass: 'release-artifact',
        runId, invocationId, attemptId: owner.attemptId, sourceState, attemptRoot: owner,
        terminal: { path: terminal.path, fileDigest: terminal.fileDigest },
        sourceAuthority: { inventoryDigest: source.inventoryDigest, configDigest: source.config.sha256 },
        inventory, semanticMutantIdentityDigest: source.semanticMutantIdentityDigest,
        resultInventoryDigest: source.inventoryDigest,
        resolvedSubset: subset.subset, resolvedSubsetDigest: subset.resolvedSubsetDigest,
        debugCompiler, compiler: releaseCompiler,
        configurationComparison: {
            debugArtifactDigest: bytesDigest('controlled Debug assembly'), releaseArtifactDigest: assemblyDigest,
            debugCompilerOptionsDigest: debugCompiler.optionsDigest, releaseCompilerOptionsDigest: releaseCompiler.optionsDigest,
            ilClassification: 'configuration-different-assembly-bytes', sourceBranchClassification: 'same-source-branch'
        },
        artifact: { root: owner.root, buildRoot: owner.paths.build, digest: releaseArtifactDigest(owner.root),
            assembly: { name: 'FsusBlog.Core.dll', path: assembly, digest: assemblyDigest },
            smoke: { evidencePath: smokePath, evidenceDigest: bytesDigest(fs.readFileSync(smokePath)), trxPath, trxDigest, killedMutantIds } }
    };
    return { source, parity, owner };
}
