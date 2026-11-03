import fs from 'node:fs';
import path from 'node:path';

const { validateCrossStackOwnershipRegistry } = await import(new URL('../../test-matrix/cross-stack-receipts.mjs', import.meta.url));
const { digestCanonical, sealContentDigest } = await import(new URL('../attempt-provenance.mjs', import.meta.url));

export const staticAtomicDeclarationSchema = 'fsusblog.static-atomic-declarations.v1';
export const staticAtomicOwnershipPath = 'tests/fixtures/evidence-projection/cross-stack-assertion-ownership.json';

function producer(id, lane, command, cwd, inputs, options = {})
{
    return {
        id,
        lane,
        phase: 'static',
        kind: 'correctness',
        command,
        cwd,
        consumedInputs: inputs,
        ownedOutputs: options.ownedOutputs ?? [],
        dependsOn: options.dependsOn ?? [],
        prerequisites: options.prerequisites ?? ['node-toolchain'],
        network: options.network ?? 'denied',
        resources: {
            cpuWeight: 1,
            memoryWeight: options.memoryWeight ?? 0.25,
            minCpuUnits: 1,
            exclusiveResources: options.exclusiveResources ?? []
        },
        retryPolicyId: 'correctness-first-attempt',
        allowedRetries: 0,
        attemptAdapter: 'tools/test/attempt-runner.mjs#runProducerAttempts',
        legacyPhysicalTestIds: [lane === 'cross-stack-static' ? 'command:cross-stack' : 'command:security-static'],
        assertionBindings: [],
        ...options
    };
}

/** Domain source declarations only; attachment to the shared compiler belongs to its owner. */
export function staticAtomicDeclarations(repositoryRoot)
{
    const packageFile = path.join(repositoryRoot, 'src/frontend/package.json');
    const packageScripts = JSON.parse(fs.readFileSync(packageFile, 'utf8')).scripts;
    const registry = validateCrossStackOwnershipRegistry(JSON.parse(fs.readFileSync(
        path.join(repositoryRoot, staticAtomicOwnershipPath), 'utf8'
    )));
    const coherenceInputs = [
        'tests/frontend/fixtures/cross-stack-contract-matrix.json',
        'tests/frontend/checks/support/crossStackMatrix.mjs',
        'tests/frontend/checks'
    ];
    const crossStack = (id, script) => producer(id, 'cross-stack-static', ['npm', 'run', script],
        'src/frontend', ['src/frontend/package.json', ...coherenceInputs], {
            packageScript: script,
            prerequisites: ['node-toolchain', 'npm-toolchain']
        });
    const entries = [
        crossStack('cross-stack-distribution-coherence', 'check:coherence:distribution-full'),
        crossStack('cross-stack-notification-stream-events', 'check:coherence:notification-stream-events'),
        crossStack('cross-stack-upload-complete', 'check:coherence:upload-complete'),
        producer('cross-stack-auth-state-coherence', 'cross-stack-static',
            ['node', '../../tests/frontend/checks/runtime/auth-state-coherence.mjs'], 'src/frontend', coherenceInputs),
        crossStack('cross-stack-service-worker-cache', 'check:coherence:sw-cache'),
        crossStack('cross-stack-performance-coherence', 'check:coherence:perf'),
        producer('security-network-baseline', 'security-static',
            ['tools/security/check-production-network-baseline.sh'], '.', [
                'tools/security', 'tests/tools/production-network-baseline.test.mjs',
                'ops/docker', 'ops/gateway', 'config/examples'
            ], { prerequisites: ['bash-toolchain', 'node-toolchain', 'production-exposure-toolchain'] }),
        producer('security-supply-chain-audit', 'security-static',
            ['tools/security/check-supply-chain-audit.sh'], '.', ['tools/security', 'tools/governance',
                'README.md', 'Directory.Packages.props', 'Directory.Build.props', 'src', 'tests', 'benchmarks'], {
                network: 'policy-bound',
                prerequisites: ['bash-toolchain', 'node-toolchain', 'npm-toolchain', 'dotnet-toolchain',
                    'dependency-locks', 'nuget-restore', 'supply-chain-network-policy'],
                ownedOutputs: ['.tmp/security/supply-chain'],
                exclusiveResources: ['security-supply-chain-output'],
                memoryWeight: 1
            }),
        producer('security-domain-layout', 'security-static',
            ['node', 'tools/security/check-security-domain-layout.mjs'], '.', [
                'tools/security/check-security-domain-layout.mjs', 'tools/operations/evidence-classification.mjs',
                'security', 'src', 'tests', 'ops', 'docs'
            ]),
        producer('security-matrices', 'security-static', ['npm', '--prefix', 'src/frontend', 'run',
            'check:security:matrices'], '.', ['src/frontend/package.json', 'tools/test', 'tools/security',
            'tools/yaml', 'security/matrices', 'config/testing'], {
            packageScript: 'check:security:matrices',
            prerequisites: ['node-toolchain', 'npm-toolchain', 'physical-execution-envelope'],
            canonicalExecutionOwner: 'frontend-static-governance/security-matrices',
            ownedOutputs: ['.tmp/physical-execution-projections', '.tmp/test-execution-envelope'],
            exclusiveResources: ['security-matrices-physical-evidence']
        }),
        producer('security-pow-parity', 'security-static', ['npm', 'run', 'check:contract:pow-parity'],
            'src/frontend', ['src/frontend/package.json', 'tests/frontend/checks/static/check-frontend-backend-pow-parity.mjs',
                'tests/frontend/checks/support/crossStackMatrix.mjs', 'src/frontend/src/api',
                'src/frontend/src/generated', 'src/shared/Contracts/Validation', '.tmp/contracts/openapi'], {
                packageScript: 'check:contract:pow-parity',
                prerequisites: ['node-toolchain', 'npm-toolchain', 'openapi-input-selection']
            }),
        producer('security-zap-warning-policy', 'security-static',
            ['tools/security/check-zap-warn-policy.mjs'], '.', [
                'tools/security/check-zap-warn-policy.mjs', 'tools/security/zap-baseline.conf',
                'tools/yaml', 'security/policies/zap-warn-policy.yml'
            ]),
        producer('security-sbom', 'security-static', ['tools/security/generate-sbom.sh'], '.',
            ['tools/security/generate-sbom.sh', 'src', 'tests', 'benchmarks', 'tools'], {
                prerequisites: ['bash-toolchain', 'node-toolchain', 'dependency-locks', 'image-metadata'],
                ownedOutputs: ['.tmp/security/sbom'],
                exclusiveResources: ['security-sbom-output']
            })
    ];
    for (const entry of entries)
    {
        if (entry.packageScript)
        {
            if (typeof packageScripts[entry.packageScript] !== 'string')
            {
                throw new Error(`missing original package script: ${entry.packageScript}`);
            }
            entry.packageScriptDigest = digestCanonical(packageScripts[entry.packageScript]);
        }
        const legacyCommand = entry.packageScript ?? (entry.id === 'cross-stack-auth-state-coherence'
            ? 'auth-state-coherence.mjs' : null);
        entry.assertionBindings = registry.assertions.filter(assertion => assertion.canonicalOwner === entry.lane
            && assertion.legacyCommand === legacyCommand);
    }
    const summaries = ['cross-stack-static', 'security-static'].map(lane => ({
        id: `${lane}-summary`,
        lane,
        phase: 'static',
        kind: 'settled-projection',
        dependsOn: [],
        settledDependsOn: entries.filter(entry => entry.lane === lane).map(entry => entry.id),
        command: null,
        projectionAdapter: 'tools/test/static-atomic/summary.mjs#projectStaticAtomicSummary'
    }));
    return sealContentDigest({
        schema: staticAtomicDeclarationSchema,
        ownershipDigest: digestCanonical(registry),
        membershipStatus: 'owner-confirmation-required',
        producers: entries,
        summaries
    });
}

export function staticAtomicProducer(declarations, producerId)
{
    const unsigned = { ...declarations };
    delete unsigned.contentDigest;
    if (declarations?.schema !== staticAtomicDeclarationSchema
        || declarations.contentDigest !== digestCanonical(unsigned))
    {
        throw new Error('static atomic declaration identity/digest mismatch');
    }
    const entry = declarations.producers.find(candidate => candidate.id === producerId);
    if (!entry || entry.phase !== 'static')
    {
        throw new Error(`unknown static atomic producer: ${producerId}`);
    }
    return structuredClone(entry);
}
