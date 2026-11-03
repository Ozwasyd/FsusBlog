import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { digestCanonical } = await import(new URL('../../../tools/test/attempt-provenance.mjs', import.meta.url));
const { staticAtomicDeclarations } = await import(new URL('../../../tools/test/static-atomic/declarations.mjs', import.meta.url));
const { runStaticAtomicProducer } = await import(new URL('../../../tools/test/static-atomic/producer.mjs', import.meta.url));
const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

/** Synthetic external owners and commands for controls; never current-run qualification evidence. */
export function staticAtomicFixture(t, failures = [], { resultSidecars = true } = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-static-atomic-control-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (relative, text, mode = 0o644) =>
    {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text, { mode });
    };
    for (const relative of ['src/frontend/package.json', 'tests/fixtures/evidence-projection/cross-stack-assertion-ownership.json'])
    {
        write(relative, fs.readFileSync(path.join(repositoryRoot, relative), 'utf8'));
    }
    const declarations = staticAtomicDeclarations(root);
    const resultCode = resultSidecars ? `
const key = process.argv.at(-1).split('/').at(-1);
const executedTestIds = JSON.parse(process.env.CONTROL_TEST_IDS)[key] ?? [];
require('node:fs').writeFileSync(process.env.FSUSBLOG_ATTEMPT_RESULT_PATH, JSON.stringify({
    schema: 'fsusblog.test-attempt-result.v1', failureClass: null, failureKind: null,
    executedTestIds, failedTestIds: [], artifactPaths: []
}));
` : '';
    write('bin/npm', `#!${process.execPath}\n${resultCode}\nprocess.exit(process.env.CONTROL_FAIL_SCRIPTS.split(',').includes(process.argv.at(-1)) ? 17 : 0);\n`, 0o755);
    const fail = id => failures.includes(id) ? 17 : 0;
    for (const [id, relative] of [
        ['security-network-baseline', 'tools/security/check-production-network-baseline.sh'],
        ['security-supply-chain-audit', 'tools/security/check-supply-chain-audit.sh'],
        ['security-sbom', 'tools/security/generate-sbom.sh'],
        ['security-zap-warning-policy', 'tools/security/check-zap-warn-policy.mjs']
    ])
    {
        const code = relative.endsWith('.mjs') ? `import fs from 'node:fs';\n${resultCode.replace("require('node:fs')", 'fs')}` : resultCode;
        write(relative, `#!${process.execPath}\n${code}\nprocess.exit(${fail(id)});\n`, 0o755);
    }
    const moduleResultCode = resultCode.replace("require('node:fs')", 'fs');
    write('tools/security/check-security-domain-layout.mjs', `import fs from 'node:fs';\n${moduleResultCode}\nprocess.exit(${fail('security-domain-layout')});\n`);
    write('tests/frontend/checks/runtime/auth-state-coherence.mjs', `import fs from 'node:fs';\n${moduleResultCode}\nprocess.exit(${fail('cross-stack-auth-state-coherence')});\n`);
    const failScripts = declarations.producers.filter(entry => failures.includes(entry.id))
        .map(entry => entry.packageScript).filter(Boolean);
    const env = { PATH: `${path.join(root, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        CONTROL_FAIL_SCRIPTS: failScripts.join(','),
        CONTROL_TEST_IDS: JSON.stringify(Object.fromEntries(declarations.producers.map(entry => [
            entry.command.at(-1).split('/').at(-1), entry.assertionBindings.map(assertion => assertion.sourceTestId)
        ]))) };
    const identity = {
        sourceCommit: '1'.repeat(40),
        worktreeFingerprint: `sha256:${'2'.repeat(64)}`,
        schedulerRunId: 'synthetic-static-controls'
    };
    const evidenceRoot = path.join(root, 'evidence');
    const admitted = new Map();
    const inputClosureDigest = digestCanonical({ synthetic: true, failures });
    const references = id => ['execution-envelope', 'replay-plan', 'temporal-context'].map(kind => ({
        kind,
        artifactPath: `synthetic/${id}/${kind}.json`,
        artifactDigest: digestCanonical({ id, kind, synthetic: true }),
        verificationReceiptPath: `synthetic/${id}/${kind}.verification.json`,
        verificationReceiptDigest: digestCanonical({ id, kind, verification: 'synthetic' })
    }));
    const admit = (producer, override = {}) =>
    {
        const binding = {
            declarationDigest: declarations.contentDigest,
            inputClosureDigest,
            commandDigest: digestCanonical(producer.command),
            environmentDigest: digestCanonical(env),
            resourceContractDigest: digestCanonical(producer.resources),
            prerequisiteSetDigest: digestCanonical(producer.prerequisites),
            cwd: path.resolve(root, producer.cwd)
        };
        for (const reference of references(producer.id))
        {
            admitted.set(reference.artifactDigest, {
                verified: true,
                authorityDigest: reference.artifactDigest,
                verificationReceiptDigest: reference.verificationReceiptDigest,
                identity: { ...identity, producerId: producer.id },
                staticAtomic: {
                    ...binding,
                    network: producer.network,
                    networkEnforced: true,
                    networkPolicyDigest: digestCanonical('synthetic-network-policy'),
                    ...override
                }
            });
        }
    };
    const verifyAuthority = reference => admitted.get(reference.artifactDigest);
    const run = async (producer, override = {}) =>
    {
        admit(producer, override);
        const result = await runStaticAtomicProducer({
            repositoryRoot: root,
            producerId: producer.id,
            inputClosureDigest,
            context: { ...identity, env, evidenceRoot, authorityReferences: references(producer.id), verifyAuthority }
        });
        const attemptPath = path.relative(evidenceRoot, path.join(result.producerRoot, 'attempt-1/receipt.json'));
        return {
            producerId: producer.id,
            attemptPath,
            attemptDigest: result.attempts[0].contentDigest,
            binding: result.binding
        };
    };
    return { root, env, identity, evidenceRoot, declarations, inputClosureDigest,
        references, admit, verifyAuthority, run };
}
