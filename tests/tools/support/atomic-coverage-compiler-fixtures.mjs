import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';

const { createCoveragePlan } = await import(new URL('../../../tools/coverage/atomic-coverage-plan.mjs', import.meta.url));
const { createCoverageAtomicAttachment, createCoverageExecutionRequests, writeCoverageExecutionRequests } = await import(new URL('../../../tools/coverage/atomic-coverage-compiler-bridge.mjs', import.meta.url));
const { canonicalTestId, planExactShards, sealReplayPlan } = await import(new URL('../../../tools/test/execution-replay-contract.mjs', import.meta.url));
const { digestCanonical, sealContentDigest, sha256 } = await import(new URL('../../../tools/test/attempt-provenance.mjs', import.meta.url));

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const ref = (item) => ({ id: item.id, contentDigest: item.contentDigest });

/** Real fixture processes under the canonical compiler/attempt runner; synthetic collectors are never native evidence. */
export function coverageCompilerFixture(t, { failedDomain = null, environment = {}, backendCoverage = 100, nativePlanWithoutReceipt = false } = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-compiled-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.cpSync(path.join(repositoryRoot, 'tools'), path.join(root, 'tools'), { recursive: true, filter: (source) =>
        !source.includes(`${path.sep}node_modules`) || source.startsWith(path.join(repositoryRoot, 'tools/test-matrix/schema-validator/node_modules')) });
    fs.mkdirSync(path.join(root, 'config/testing'), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, 'config/testing/retry-policy-registry.json'), path.join(root, 'config/testing/retry-policy-registry.json'));
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, 'tests/coverage-policy.yml'), path.join(root, 'tests/coverage-policy.yml'));
    fs.mkdirSync(path.join(root, 'src/frontend'), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, 'src/frontend/package.json'), path.join(root, 'src/frontend/package.json'));
    for (const domain of ['backend', 'frontend'])
    {
        const script = `#!/usr/bin/env bash\nset -euo pipefail\nnode --input-type=module - <<'NODE'\n` +
            `import fs from 'node:fs';\nimport path from 'node:path';\n` +
            `await new Promise(resolve => setTimeout(resolve, ${domain === 'frontend' ? 100 : 10}));\n` +
            `const domain = ${JSON.stringify(domain)}; const base = process.env.FSUSBLOG_COVERAGE_ROOT;\n` +
            `const dir = domain === 'backend' ? base + '/backend-merged' : base + '/frontend';\n` +
            `const put = (file,value) => {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value)+'\\n');};\n` +
            `put(base + '/' + domain + '-completed.json',{synthetic:true});\n` +
            `if (domain === ${JSON.stringify(failedDomain)}) process.exit(1);\n` +
            `const coverage = domain === 'backend' ? ${backendCoverage} : 100;\n` +
            `put(dir + '/Summary.json',{summary:{linecoverage:coverage,branchcoverage:coverage,methodcoverage:coverage},` +
            `totals:{lines:{covered:coverage,total:100},branches:{covered:coverage,total:100},methods:{covered:coverage,total:100}},` +
            `producer:{runId:process.env.FSUSBLOG_TEST_RUN_ID,sourceCommit:process.env.FSUSBLOG_TEST_SOURCE_COMMIT,sourceFingerprint:process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT},` +
            `source:domain==='backend'?'backend-coverlet-json-authoritative-merge':'frontend-vitest',` +
            `authoritativeRaw:base+'/backend-merged/coverage.json',exchangeFormats:[base+'/backend-merged/coverage.cobertura.xml']});\n` +
            `if(domain==='backend'){put(dir+'/coverage.json',{synthetic:true});put(dir+'/coverage.cobertura.xml',{synthetic:true});put(base+'/backend/universe.json',{synthetic:true});}\n` +
            `else put('src/frontend/coverage/unit/coverage-summary.json',{synthetic:true});\nNODE\n`;
        fs.writeFileSync(path.join(root, `tools/coverage/collect-${domain}-coverage.sh`), script);
    }
    const identity = { runId: 'coverage-compiled-run', sourceCommit: '1'.repeat(40), sourceFingerprint: `sha256:${'2'.repeat(64)}` };
    const plan = createCoveragePlan({ root, identity, environment });
    const verifierPath = 'tools/coverage/fixture-authority.mjs';
    fs.writeFileSync(path.join(root, verifierPath), `import fs from 'node:fs';\nimport path from 'node:path';\nimport {createHash} from 'node:crypto';\n` +
        `const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');\n` +
        `export function verifyCoverageAuthority(reference,{root}){\n` +
        `const bytes=fs.readFileSync(path.resolve(root,reference.verificationReceiptPath));\n` +
        `if(hash(bytes)!==reference.verificationReceiptDigest||hash(fs.readFileSync(path.resolve(root,reference.artifactPath)))!==reference.artifactDigest)return null;\n` +
        `return {...JSON.parse(bytes),verificationReceiptDigest:reference.verificationReceiptDigest};}\n`);
    const authorityVerifier = { path: verifierPath, exportName: 'verifyCoverageAuthority', contentDigest: sha256(fs.readFileSync(path.join(root, verifierPath))) };
    const replayPlanPaths = Object.fromEntries(plan.producers.map((producer) => [producer.id, `.tmp/replays/${producer.id}.json`]));
    const requests = createCoverageExecutionRequests({ root, plan, evidenceRoot: '.tmp/attempts', requestRoot: '.tmp/requests', replayPlanPaths, authorityVerifier });
    writeCoverageExecutionRequests(root, requests);
    const authorities = { commandSources: [], inputClosures: [], fixtureProfiles: [], resourceContracts: [], replayPlans: [], physicalOwnership: [], stateAccess: [], finalizerOperations: [] };
    const fixture = sealContentDigest({ id: 'coverage-synthetic-fixture', fixtureKind: 'test-only' });
    const resource = sealContentDigest({ id: 'coverage-isolated-resource', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } });
    authorities.fixtureProfiles.push(fixture);
    authorities.resourceContracts.push(resource);
    const contexts = {};
    const write = (relative, document) =>
    {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const bytes = `${JSON.stringify(document, null, 4)}\n`;
        fs.writeFileSync(file, bytes);
        return { path: relative, digest: sha256(bytes) };
    };
    const nodes = requests.map((item) =>
    {
        const producer = plan.producers.find((candidate) => candidate.id === item.request.producerId);
        const id = producer.id;
        const parent = ['coverage-backend', 'coverage-frontend', 'coverage-merge'].includes(id) ? 'coverage-gate' : 'coverage-threshold';
        const closure = sealContentDigest({ id: `${id}-inputs`, commandSourceId: `${id}-command`, commandDigest: digestCanonical(item.command), unresolvedDynamicReads: [],
            coverageBinding: { planDigest: plan.contentDigest, requestPath: item.request.requestPath, requestDigest: sha256(item.bytes), sourceDigests: item.request.sourceDigests, authorityVerifier } });
        const source = sealContentDigest({ id: `${id}-command`, command: item.command, executableAuthorityCount: 1, inputClosureRef: ref(closure) });
        authorities.inputClosures.push(closure);
        authorities.commandSources.push(source);
        const testIds = nativePlanWithoutReceipt && ['coverage-backend', 'coverage-frontend'].includes(id)
            ? [canonicalTestId({ framework: 'node-test', source: 'tests/tools/atomic-coverage-execution.test.mjs', name: ['unavailable-native-selection', id] })] : [];
        const replay = sealReplayPlan({
            schema: 'fsusblog.test-execution-replay-plan.v1', source: { commit: identity.sourceCommit, worktreeFingerprint: identity.sourceFingerprint },
            producer: { id, framework: 'node-test' }, run: { id: identity.runId, mode: nativePlanWithoutReceipt ? 'qualification' : 'diagnostic' },
            rootSeed: `seed256:${'ab'.repeat(32)}`, entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }], randomStreams: [],
            ...planExactShards({ testIds, allowEmptyShards: true }), workers: { ids: ['fixture-worker'], assignmentPolicy: 'framework-owned-after-seal' },
            frameworkModes: [{ name: 'retry', value: 'disabled' }], schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false }, schedulerShuffleSeed: 'fixture-seed',
            command: { executable: item.command[0], args: item.command.slice(1), environmentDigest: digestCanonical({ PATH: process.env.PATH }) }
        });
        const replayRef = write(replayPlanPaths[id], replay);
        const replayMaterial = { id: `${id}-replay`, replayOwner: 'coverage-fixture-replay', fixtureProfileDigest: fixture.contentDigest,
            artifactPath: replayRef.path, bytes: fs.readFileSync(path.join(root, replayRef.path), 'utf8'), plan: replay };
        authorities.replayPlans.push(replayMaterial);
        const references = ['execution-envelope', 'replay-plan', 'temporal-context'].map((kind) =>
        {
            const actual = kind === 'replay-plan' ? replayRef : write(`.tmp/authorities/${id}/${kind}.json`, { synthetic: true, producerId: id, kind });
            const verification = write(`.tmp/authorities/${id}/${kind}.verification.json`, { verified: true, authorityDigest: actual.digest,
                identity: { producerId: id, schedulerRunId: identity.runId, sourceCommit: identity.sourceCommit, worktreeFingerprint: identity.sourceFingerprint } });
            return { kind, artifactPath: actual.path, artifactDigest: actual.digest,
                verificationReceiptPath: verification.path, verificationReceiptDigest: verification.digest };
        });
        contexts[id] = { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 10000, authorityReferences: references,
            verifyAuthority: (reference) =>
            {
                const bytes = fs.readFileSync(path.join(root, reference.verificationReceiptPath));
                assertDigest(bytes, reference.verificationReceiptDigest);
                assertDigest(fs.readFileSync(path.join(root, reference.artifactPath)), reference.artifactDigest);
                return { ...JSON.parse(bytes), verificationReceiptDigest: reference.verificationReceiptDigest };
            } };
        const node = { kind: 'atomic-producer', producerId: id, logicalParentId: parent, owner: 'coverage-fixture-owner', projectionOwner: 'coverage-fixture-projection',
            dependsOn: [...producer.dependsOn].sort(), settledDependsOn: [], commandSourceRef: ref(source), executionClass: 'static', evidenceClass: 'correctness',
            attemptPolicyId: 'correctness-first-attempt', fixtureProfile: ref(fixture), stateAccessRef: null, resourceContractRef: ref(resource), serviceDependencies: [],
            artifacts: producer.outputs.map((output) => `${id}-${output.role}`).sort(), evidence: [`${id}-attempt-receipt`],
            replayOwner: 'coverage-fixture-replay', replayPlanRef: { id: replayMaterial.id, contentDigest: replayRef.digest, planDigest: replay.planDigest } };
        authorities.physicalOwnership.push({ producerId: id, logicalParentId: parent, owner: node.owner, commandSourceRef: node.commandSourceRef });
        return node;
    });
    const matrix = createCoverageAtomicAttachment(plan, Object.fromEntries(nodes.map((node) => [node.producerId,
        Object.fromEntries(['owner', 'commandSourceRef', 'executionClass', 'fixtureProfile', 'stateAccessRef', 'resourceContractRef',
            'serviceDependencies', 'replayOwner', 'replayPlanRef', 'dependsOn'].map((key) => [key, node[key]]))])), 'coverage-fixture-projection');
    authorities.matrixDigest = digestCanonical(matrix);
    const executionOptions = { context: { evidenceRoot: path.resolve(root, '.tmp/attempts'), schedulerRunId: identity.runId, sourceCommit: identity.sourceCommit, worktreeFingerprint: identity.sourceFingerprint },
        capacity: { maxParallel: 2, cpuUnits: 2, memoryGiB: 2 }, producerContexts: contexts };
    return { root, plan, requests, matrix, authorities, executionOptions };
}

function assertDigest(bytes, expected)
{
    if (sha256(bytes) !== expected)
    {
        throw new Error('fixture authority bytes changed');
    }
}
