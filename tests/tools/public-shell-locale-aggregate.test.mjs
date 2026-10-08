import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {createProductionBuildReceipt, verifyProductionBuildReceipt} = await import(new URL('../../tools/ci/production-build-artifacts.mjs', import.meta.url));
const {aggregatePublicShellLocale} = await import(new URL('../../tools/test-matrix/aggregate-public-shell-locale.mjs', import.meta.url));
const {gateDigest, loadPublicShellLocaleGate, publicShellLocaleSubResultSchema, verifyPublicShellLocaleBuild} = await import(new URL('../../tools/test-matrix/public-shell-locale-gate.mjs', import.meta.url));
const {createPublicShellLocaleQualification, derivePublicShellLocaleRootIdentity, publicShellLocaleIdentity, publicShellLocaleStageApplicability, validatePublicShellLocaleSubResults} = await import(new URL('../../tools/test-matrix/public-shell-locale-evidence.mjs', import.meta.url));
const {readPublicShellLocaleCallerRoot, requirePublicShellLocaleCausalVerification, verifyPublicShellLocaleQualification, verifyPublicShellLocaleRawRefs} = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
const {createPublicShellLocaleMatrix} = await import(new URL('../../tests/browser-contract/public-shell-locale-matrix.mjs', import.meta.url));
const root = path.resolve(new URL('../../', import.meta.url).pathname);
const matrix = await createPublicShellLocaleMatrix(root);
const { readPublicShellLocaleSceneOriginalArtifact, validatePublicShellLocaleSceneOriginalDocuments } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
const { originalCaptureLimits } = await import(new URL('../browser-contract/public-shell-locale-lifecycle-evidence.mjs', import.meta.url));
const { projectBrowserContractLocaleTopology } = await import(new URL('../../tools/release/browser-contract-receipt-contract.mjs', import.meta.url));

// #2083 writer-shaped Node models, not a JS recorder or browser qualification.
function originalFirstResponseHttpModel()
{
    const value = originalWriterStageModel(2083);
    const document = value.documents[0];
    delete document.evidence.browser;
    delete document.evidence.driverObservations;
    const response = document.privateOriginals.originals[1];
    response.headersArray.push({ name: 'Content-Language', value: document.scene.document.language },
        { name: 'Cache-Control', value: 'no-store' });
    const binding = value.caller.binding;
    const firstResponse = {
        schema: 'fsusblog.public-shell-locale-first-response.v1', evidenceKind: 'diagnostic-probe', qualificationEligible: false,
        identity: { sourceCommit: binding.sourceState.commit, worktreeFingerprint: binding.sourceState.worktreeFingerprint,
            matrixDigest: binding.matrixDigest, buildDigest: binding.buildDigest, runtimeId: binding.runtimeId, namespace: binding.identity.namespace },
        response: { status: 200, contentType: 'text/html', contentLanguage: document.scene.document.language,
            cacheControlDigest: createHash('sha256').update('no-store').digest('hex'),
            bodyDigest: response.byteSha256.slice('sha256:'.length), bodyBytes: response.byteLength },
        observed: { locale: document.scene.locale, route: document.scene.route, authActionContext: document.scene.authActionContext }
    };
    document.evidence.driverObservations = [{ stage: 'first-response', firstResponse,
        publishedArtifactRef: { path: `.tmp/browser-contract/runs/${binding.identity.namespace}/bindings/${binding.preparation.id}/published-artifacts/scene-${encodeURIComponent(document.scene.id)}/published-artifact-11111111-1111-1111-1111-111111111111.json`, digest: `sha256:${'a'.repeat(64)}` },
        evidence: structuredClone(document.evidence) }];
    value.runtime.publishedRoutes = new Map([[document.scene.id, { path: '/', routeKey: 'home' }]]);
    return value;
}

test('scene original #2083 HTTP first-response actual writer shape admits no fake JS recorder (Node model)', async () =>
{
    const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    const value = originalFirstResponseHttpModel();
    const document = value.documents[0];
    const options = { kind: 'scene', matrix: value.matrix, caller: value.caller, runtime: value.runtime };
    const normal = parse(Buffer.from(JSON.stringify(document)), options);
    const tail = structuredClone(normal);
    tail.evidence = { identity: normal.evidence.identity, sceneId: normal.scene.id, captureCut: normal.evidence.captureCut,
        phase: 'observer-disposal', driverObservations: normal.evidence.driverObservations };
    assert.deepEqual(parse(Buffer.from(JSON.stringify(tail)), options), tail);
    assert.deepEqual(validatePublicShellLocaleSceneOriginalDocuments({ ...value, documents: [normal, tail] }), { documentCount: 2, sceneCount: 1 });
    assert.equal(Object.hasOwn(normal.evidence, 'browser'), false);
    assert.equal(normal.evidence.driverObservations[0].firstResponse.qualificationEligible, false);
    assert.throws(() => requirePublicShellLocaleCausalVerification(), error => error.code === 'native-causal-not-observed');
});

for (const [name, mutate] of [
    ['diagnostic schema', value => value.documents[0].evidence.driverObservations[0].firstResponse.schema = 'fake'],
    ['diagnostic kind', value => value.documents[0].evidence.driverObservations[0].firstResponse.evidenceKind = 'qualified'],
    ['qualification true', value => value.documents[0].evidence.driverObservations[0].firstResponse.qualificationEligible = true],
    ['qualification null', value => value.documents[0].evidence.driverObservations[0].firstResponse.qualificationEligible = null],
    ['missing diagnostic flag', value => delete value.documents[0].evidence.driverObservations[0].firstResponse.qualificationEligible],
    ['foreign diagnostic run', value => value.documents[0].evidence.driverObservations[0].firstResponse.identity.runtimeId = 'foreign-run'],
    ['foreign diagnostic source', value => value.documents[0].evidence.driverObservations[0].firstResponse.identity.sourceCommit = 'a'.repeat(40)],
    ['foreign diagnostic build', value => value.documents[0].evidence.driverObservations[0].firstResponse.identity.buildDigest = 'a'.repeat(64)],
    ['foreign diagnostic locale', value => value.documents[0].evidence.driverObservations[0].firstResponse.observed.locale = 'not-the-scene'],
    ['foreign diagnostic route', value => value.documents[0].evidence.driverObservations[0].firstResponse.observed.route = 'not-the-scene'],
    ['foreign diagnostic role', value => value.documents[0].evidence.driverObservations[0].firstResponse.observed.authActionContext = 'admin'],
    ['summary body digest', value => value.documents[0].evidence.driverObservations[0].firstResponse.response.bodyDigest = 'a'.repeat(64)],
    ['summary body size', value => value.documents[0].evidence.driverObservations[0].firstResponse.response.bodyBytes++],
    ['summary cache header', value => value.documents[0].evidence.driverObservations[0].firstResponse.response.cacheControlDigest = 'a'.repeat(64)],
    ['ambiguous full header', value => value.documents[0].privateOriginals.originals[1].headersArray.push({ name: 'content-language', value: value.documents[0].scene.document.language })],
    ['nested metadata method', value => value.documents[0].evidence.driverObservations[0].evidence.requests[0].method = 'POST'],
    ['nested metadata URL', value => value.documents[0].evidence.driverObservations[0].evidence.responses[0].url = 'http://127.0.0.1:3001/other'],
    ['missing nested metadata', value => value.documents[0].evidence.driverObservations[0].evidence.requests = []],
    ['nested cut exceeds normal', value => value.documents[0].evidence.driverObservations[0].evidence.captureCut++],
    ['nested capture scene', value => value.documents[0].evidence.driverObservations[0].evidence.sceneId = 'foreign-scene'],
    ['missing first-response stage', value => value.documents[0].evidence.driverObservations = []],
    ['missing independent route', value => value.runtime.publishedRoutes.clear()],
    ['independent route mismatch', value => value.runtime.publishedRoutes.set(value.documents[0].scene.id, { path: '/other', routeKey: 'other' })],
    ['duplicate first-response stage', value => value.documents[0].evidence.driverObservations.push(structuredClone(value.documents[0].evidence.driverObservations[0]))],
    ['ref path type', value => value.documents[0].evidence.driverObservations[0].publishedArtifactRef.path = 1],
    ['ref digest type', value => value.documents[0].evidence.driverObservations[0].publishedArtifactRef.digest = null],
    ['ref digest syntax', value => value.documents[0].evidence.driverObservations[0].publishedArtifactRef.digest = 'not-a-digest'],
    ['ref path alias', value => value.documents[0].evidence.driverObservations[0].publishedArtifactRef.path = value.documents[0].evidence.driverObservations[0].publishedArtifactRef.path.replace('/published-artifact-', '/../published-artifact-')],
    ['ref foreign run', value => value.documents[0].evidence.driverObservations[0].publishedArtifactRef.path = '.tmp/browser-contract/runs/foreign/published-artifact-11111111-1111-1111-1111-111111111111.json'],
    ['ref ordinary filename', value => value.documents[0].evidence.driverObservations[0].publishedArtifactRef.path = `.tmp/browser-contract/runs/${value.caller.binding.identity.namespace}/observed-response.json`],
    ['ref legacy run top', value => value.documents[0].evidence.driverObservations[0].publishedArtifactRef.path = `.tmp/browser-contract/runs/${value.caller.binding.identity.namespace}/published-artifact-11111111-1111-1111-1111-111111111111.json`],
    ['ref foreign preparation', value => value.documents[0].evidence.driverObservations[0].publishedArtifactRef.path = value.documents[0].evidence.driverObservations[0].publishedArtifactRef.path.replace(`/bindings/${value.caller.binding.preparation.id}/`, '/bindings/99999999-9999-9999-9999-999999999999/')],
    ['ref foreign scene', value => value.documents[0].evidence.driverObservations[0].publishedArtifactRef.path = value.documents[0].evidence.driverObservations[0].publishedArtifactRef.path.replace(`/scene-${encodeURIComponent(value.documents[0].scene.id)}/`, '/scene-foreign/')],
    ['ref raw hex digest', value => value.documents[0].evidence.driverObservations[0].publishedArtifactRef.digest = 'a'.repeat(64)]
])
{
    test(`scene original #2083 HTTP integrity rejects ${name} (Node model)`, () =>
    {
        const value = originalFirstResponseHttpModel();
        mutate(value);
        assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(value));
    });
}

for (const [name, mutate] of [
    ['unknown driver field', document => document.evidence.driverObservations[0].checked = true],
    ['unknown diagnostic field', document => document.evidence.driverObservations[0].firstResponse.checked = true],
    ['unknown diagnostic graph', document => document.evidence.driverObservations[0].firstResponse.response.extra = [[], []]],
    ['nested bodybatch', document => document.evidence.driverObservations[0].evidence.privateOriginals = document.privateOriginals],
    ['nested driver recursion', document => document.evidence.driverObservations[0].evidence.driverObservations = [[]]],
    ['ref extra field', document => document.evidence.driverObservations[0].publishedArtifactRef.checked = true],
    ['ref graph instead of path', document => document.evidence.driverObservations[0].publishedArtifactRef.path = [[], []]],
    ['ref graph instead of digest', document => document.evidence.driverObservations[0].publishedArtifactRef.digest = { value: [[]] }],
    ['ref raw hex digest', document => document.evidence.driverObservations[0].publishedArtifactRef.digest = 'a'.repeat(64)],
    ['diagnostic raw body', document => document.evidence.driverObservations[0].firstResponse.response.bodyBase64 = 'eA=='],
    ['HTTP capture fake recorder', document => document.evidence.driverObservations[0].evidence.browser = originalReaderModel().documents[0].evidence.browser],
    ['diagnostic promotion', document => document.evidence.driverObservations[0].firstResponse.qualificationEligible = true]
])
{
    test(`scene original #2083 HTTP preflight rejects ${name} before whole parse (Node model)`, async t =>
    {
        const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
        const value = originalFirstResponseHttpModel();
        mutate(value.documents[0]);
        const input = Buffer.from(JSON.stringify(value.documents[0]));
        const originalParse = JSON.parse;
        let fullParses = 0;
        t.mock.method(JSON, 'parse', (text, ...args) =>
        {
            if (text.trimStart().startsWith('{') || text.trimStart().startsWith('['))
            {
                fullParses++;
            }
            return originalParse(text, ...args);
        });
        assert.throws(() => parse(input, { kind: 'scene', matrix: value.matrix, caller: value.caller, runtime: value.runtime }));
        assert.equal(fullParses, 0);
    });
}

for (const issue of [2084, 2085, 2086])
{
    test(`scene original #2083 HTTP exception cannot exempt ${issue} recorder (Node model)`, () =>
    {
        const value = originalWriterStageModel(issue);
        delete value.documents[0].evidence.browser;
        assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(value), /HTTP-only capture/u);
        const nested = originalWriterStageModel(issue);
        delete nested.documents[0].evidence.driverObservations[0].evidence.browser;
        assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(nested), /browser recorder/u);
        const foreign = originalWriterStageModel(issue);
        foreign.documents[0].evidence.driverObservations = originalFirstResponseHttpModel().documents[0].evidence.driverObservations;
        assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(foreign), /canonical scene/u);
    });
}

test('scene original #2083 HTTP published ref reopens actual private bytes and rejects digest or inode tamper (Node file I/O)', t =>
{
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'locale-published-node-model-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const prefix = '.tmp/browser-contract/runs/published-node-model/bindings/cb10d681-ef3b-4b55-8e7d-6043f1ec1c24/published-artifacts/scene-node-model/';
    const name = 'published-artifact-11111111-1111-1111-1111-111111111111.json';
    const file = path.join(directory, prefix, name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from('published fixture bytes: Node private I/O, not browser authority');
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const digest = createHash('sha256').update(bytes).digest('hex');
    const input = { root: directory, prefix, ref: { path: `${prefix}${name}`, digest: `sha256:${digest}` },
        remainingBytes: originalCaptureLimits.totalBytes };
    const before = readPublicShellLocaleSceneOriginalArtifact(input);
    assert.deepEqual(before.bytes, bytes);
    assert.throws(() => readPublicShellLocaleSceneOriginalArtifact({ ...input,
        ref: { ...input.ref, digest: `sha256:${'0'.repeat(64)}` } }), /digest/u);
    fs.renameSync(file, `${file}.previous`);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const after = readPublicShellLocaleSceneOriginalArtifact(input);
    assert.equal(after.bytes.equals(before.bytes), true);
    assert.notEqual(after.stat.ino, before.stat.ino, 'same bytes cannot conceal an exclusive private inode replacement');
    assert.throws(() => requirePublicShellLocaleCausalVerification(), error => error.code === 'native-causal-not-observed');
});

test('scene original #2083 HTTP diagnostic and ref cannot change between normal and tail cuts (Node model)', () =>
{
    const value = originalFirstResponseHttpModel();
    const tail = structuredClone(value.documents[0]);
    tail.evidence = { identity: tail.evidence.identity, sceneId: tail.scene.id,
        captureCut: tail.evidence.captureCut, phase: 'observer-disposal', driverObservations: tail.evidence.driverObservations };
    tail.evidence.driverObservations[0].publishedArtifactRef.digest = `sha256:${'b'.repeat(64)}`;
    assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments({ ...value, documents: [...value.documents, tail] }), /changed between/u);
});

test('scene original #2083 HTTP immutable ref read retains exclusive private mode and symlink guards (Node file I/O)', t =>
{
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'locale-published-private-model-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const prefix = '.tmp/browser-contract/runs/published-node-model/bindings/cb10d681-ef3b-4b55-8e7d-6043f1ec1c24/published-artifacts/scene-node-model/';
    const name = 'published-artifact-11111111-1111-1111-1111-111111111111.json';
    const file = path.join(directory, prefix, name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from('private published Node bytes');
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const input = { root: directory, prefix, remainingBytes: originalCaptureLimits.totalBytes,
        ref: { path: `${prefix}${name}`, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` } };
    fs.chmodSync(file, 0o644);
    assert.throws(() => readPublicShellLocaleSceneOriginalArtifact(input), /private/u);
    fs.chmodSync(file, 0o600);
    fs.renameSync(file, `${file}.original`);
    fs.symlinkSync(`${file}.original`, file);
    assert.throws(() => readPublicShellLocaleSceneOriginalArtifact(input), /symbolic|symlink/u);
});

// Plain Node models and private file I/O only; these inputs never admit a browser caller.
function originalReaderModel()
{
    const binding = rootBindingModel();
    binding.buildDigest = `sha256:${binding.buildDigest}`;
    const scene = structuredClone(matrix.scenes.find(item => item.authActionContext === 'anonymous'));
    // Preserve the matrix producer's bare digest; only the receipt boundary tags it.
    const focusedMatrix = { ...matrix, scenes: [scene] };
    binding.matrixDigest = focusedMatrix.contentDigest;
    const callerOwner = { identity: binding.identity, preparation: binding.preparation, sourceState: binding.sourceState,
        buildDigest: binding.buildDigest, fixtureRoot: binding.resources.fixtureRoot, resources: binding.resources };
    const callerRootRef = { artifact: `.tmp/browser-contract/runs/${binding.identity.namespace}/bindings/${binding.preparation.id}/root-binding.json`,
        digest: `sha256:${'b'.repeat(64)}` };
    const roles = ['provider-state', 'fixture-manifest', 'prepare-state', 'fixture-receipt', 'cookie-source'];
    const paths = ['provider-state.json', 'contract-fixture.json', 'prepare-state.json', 'fixture-receipt.json',
        'src/backend/Infrastructure/PublicAot/LocalePreferenceCookieService.cs'];
    binding.refs = roles.map((role, index) => ({ role, path: paths[index], digest: `sha256:${'c'.repeat(64)}` }));
    const negotiation = matrix.negotiationCases.find(item => item.id === scene.negotiationId);
    const runtime = { runtime: { frontendUrl: 'http://127.0.0.1:3001', backendUrl: 'http://127.0.0.1:5001' },
        preferenceUrl: 'http://127.0.0.1:3001/api/preference', resources: [], cookieName: 'unit-model-cookie' };
    const authority = { matrixDigest: binding.matrixDigest, runtimeRunId: binding.runtimeId,
        fixtureReceiptDigest: binding.fixtureReceiptDigest, runtime: runtime.runtime,
        inputs: { viewport: scene.viewport, javaScriptEnabled: scene.issue !== 2083,
            acceptLanguage: negotiation.header, cookie: negotiation.cookie, cookieName: runtime.cookieName },
        rawRefs: binding.refs.map(ref => ({ path: ref.path, digest: ref.digest })) };
    const lease = { sceneId: scene.id, leaseId: '11111111-1111-1111-1111-111111111111',
        actorId: '22222222-2222-2222-2222-222222222222', contextId: '33333333-3333-3333-3333-333333333333',
        role: 'anonymous', owner: callerOwner, authority, status: 'finished', entered: 1, ended: 1, firstFailure: null, events: [] };
    const bindings = { schema: 'fsusblog.browser-contract-public-shell-scene-bindings.v1',
        owner: callerOwner, closing: true, leases: [lease], blocked: [] };
    const identity = { matrixDigest: binding.matrixDigest, sourceState: binding.sourceState, buildDigest: binding.buildDigest,
        namespace: binding.identity.namespace, preparationId: binding.preparation.id };
    const url = 'http://127.0.0.1:3001/';
    const bytes = Buffer.from('<html>Node model, not a browser response</html>');
    const headersArray = [{ name: 'content-type', value: 'text/html' },
        { name: 'set-cookie', value: 'one=model' }, { name: 'set-cookie', value: 'two=model' }];
    const document = { scene, lease: { leaseId: lease.leaseId, actorId: lease.actorId, contextId: lease.contextId,
        sceneId: lease.sceneId, role: lease.role, owner: callerOwner, authority, status: 'prepared' }, rootBinding: callerRootRef,
    failure: null, evidence: { identity, sceneId: scene.id, captureCut: 2,
        requests: [{ requestOrdinal: 0, captureSequence: 1, url, urlDigest: `sha256:${createHash('sha256').update(url).digest('hex')}`, method: 'GET', resourceType: 'document' }],
        responses: [{ requestOrdinal: 0, captureSequence: 2, url, urlDigest: `sha256:${createHash('sha256').update(url).digest('hex')}`,
            method: 'GET', resourceType: 'document', fromServiceWorker: false, status: 200 }], issues: [],
        browser: { recordOverflow: false, performance: [], preloads: [],
            recorder: { frames: [], marks: [], events: [], errors: [], overflow: false } } },
    privateOriginals: { binding: { identity, sceneId: scene.id }, limits: { ...originalCaptureLimits },
        captureCut: 2, failures: [], overflow: false, originals: [
            { kind: 'request', source: 'browser', sequence: 1, requestOrdinal: 0, method: 'GET', url,
                representation: 'request-post-data', captureState: 'observed', headersArray: [], bodyApplicable: false },
            { kind: 'response', source: 'browser', sequence: 2, requestOrdinal: 0, parentRequestOrdinal: null,
                invocationOrdinal: null, method: 'GET', url, status: 200, representation: 'playwright-response-body',
                captureState: 'observed', headersArray, bodyEncoding: 'base64', byteLength: bytes.length,
                byteSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bodyBase64: bytes.toString('base64') }
        ] } };
    const value = { matrix: focusedMatrix, caller: { binding, callerOwner, callerRootRef }, parent: {}, bindings,
        documents: [document], runtime };
    refreshOriginalReaderLedger(value);
    return value;
}

function refreshOriginalReaderLedger(value)
{
    delete value.bindings.contentDigest;
    value.bindings.contentDigest = createHash('sha256').update(JSON.stringify(value.bindings)).digest('hex');
    value.parent = { publicShellLocaleRootBinding: value.caller.callerRootRef,
        topology: { publicShellLocale: projectBrowserContractLocaleTopology({ matrix: value.matrix,
            bindings: value.bindings, expectedOwner: value.caller.callerOwner }) } };
}

test('scene original reader pure joins preserve headers and prepared transport without qualification (Node model)', () =>
{
    const value = originalReaderModel();
    const before = structuredClone(value);
    assert.deepEqual(validatePublicShellLocaleSceneOriginalDocuments(value), { documentCount: 1, sceneCount: 1 });
    assert.deepEqual(value, before);
    assert.equal(value.documents[0].lease.status, 'prepared');
    assert.equal(value.bindings.leases[0].status, 'finished');
    assert.equal(value.documents[0].privateOriginals.originals[1].headersArray.filter(header => header.name === 'set-cookie').length, 2);
    assert.throws(() => requirePublicShellLocaleCausalVerification(), error => error.code === 'native-causal-not-observed');
});

test('scene original reader projects the canonical matrix digest only at the receipt boundary (Node model)', () =>
{
    const value = originalReaderModel();
    assert.match(matrix.contentDigest, /^[a-f0-9]{64}$/u);
    assert.equal(value.matrix.contentDigest, matrix.contentDigest);
    assert.equal(value.parent.topology.publicShellLocale.matrixDigest, `sha256:${matrix.contentDigest}`);
    assert.equal(value.bindings.leases[0].authority.matrixDigest, matrix.contentDigest);
    assert.deepEqual(validatePublicShellLocaleSceneOriginalDocuments(value), { documentCount: 1, sceneCount: 1 });
    value.matrix.contentDigest = `sha256:${matrix.contentDigest}`;
    assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(value), /matrix or current owner identity is invalid/u);
});

for (const [name, mutate] of [
    ['wrong Root ref', value => value.documents[0].rootBinding.digest = `sha256:${'d'.repeat(64)}`],
    ['extra envelope field', value => value.documents[0].qualified = true],
    ['wrong scene', value => value.documents[0].scene.locale = 'invalid-model-locale'],
    ['wrong actor', value => value.documents[0].lease.actorId = '44444444-4444-4444-4444-444444444444'],
    ['wrong context', value => value.documents[0].lease.contextId = '44444444-4444-4444-4444-444444444444'],
    ['wrong lease', value => value.documents[0].lease.leaseId = '44444444-4444-4444-4444-444444444444'],
    ['transport claims finished', value => value.documents[0].lease.status = 'finished'],
    ['runtime authority mismatch', value => value.documents[0].lease.authority.runtimeRunId = 'foreign'],
    ['wrong input', value => value.documents[0].lease.authority.inputs.javaScriptEnabled = true],
    ['missing authority ref', value => value.documents[0].lease.authority.rawRefs.pop()],
    ['ledger semantic tamper', value => value.bindings.closing = false],
    ['parent topology tamper', value => value.parent.topology.publicShellLocale.endedContextCount = 0],
    ['prepared ledger is not finished', value =>
    {
        Object.assign(value.bindings.leases[0], { status: 'prepared', entered: 0, ended: 0 });
        refreshOriginalReaderLedger(value);
    }],
    ['entered ledger is not closed', value =>
    {
        Object.assign(value.bindings.leases[0], { status: 'entered', ended: 0 });
        refreshOriginalReaderLedger(value);
    }],
    ['retained first failure', value =>
    {
        value.bindings.leases[0].firstFailure = { name: 'Error', message: 'original failure' };
        refreshOriginalReaderLedger(value);
    }],
    ['failure leaf', value => value.documents[0].failure = { name: 'Error' }],
    ['missing cut', value => delete value.documents[0].evidence.captureCut],
    ['wrong cut', value => value.documents[0].privateOriginals.captureCut = 1],
    ['out of cut', value => value.documents[0].privateOriginals.originals[0].sequence = 3],
    ['pending leaf', value => value.documents[0].privateOriginals.originals[1].captureState = 'pending'],
    ['overflow', value => value.documents[0].privateOriginals.overflow = true],
    ['sticky capture failure', value => value.documents[0].privateOriginals.failures.push({ sequence: 2, reason: 'read-failed' })],
    ['duplicate capture leaf', value => value.documents[0].privateOriginals.originals.push(structuredClone(value.documents[0].privateOriginals.originals[0]))],
    ['missing limits', value => delete value.documents[0].privateOriginals.limits.bodyBytes],
    ['raised limits', value => value.documents[0].privateOriginals.limits.totalBytes += 1],
    ['unknown limit', value => value.documents[0].privateOriginals.limits.extra = 1],
    ['leaf budget', value => value.documents[0].privateOriginals.limits.leaves = 1],
    ['body budget', value => value.documents[0].privateOriginals.limits.totalBytes = 1],
    ['document budget', value => value.documents[0].privateOriginals.limits.documentBytes = 1],
    ['missing full headers', value => delete value.documents[0].privateOriginals.originals[1].headersArray],
    ['headers object substitute', value => value.documents[0].privateOriginals.originals[1].headersArray = { 'content-type': 'text/html' }],
    ['header budget', value => value.documents[0].privateOriginals.limits.headerBytes = 1],
    ['header count', value => value.documents[0].privateOriginals.limits.headers = 1],
    ['noncanonical base64', value => value.documents[0].privateOriginals.originals[1].bodyBase64 += '\n'],
    ['base64 padding bits', value => Object.assign(value.documents[0].privateOriginals.originals[1],
        { bodyBase64: 'Zh==', byteLength: 1, byteSha256: `sha256:${createHash('sha256').update('f').digest('hex')}` })],
    ['wrong byte length', value => value.documents[0].privateOriginals.originals[1].byteLength += 1],
    ['wrong byte digest', value => value.documents[0].privateOriginals.originals[1].byteSha256 = `sha256:${'0'.repeat(64)}`],
    ['unknown leaf field', value => value.documents[0].privateOriginals.originals[1].hiddenFailure = true],
    ['unknown response source', value => value.documents[0].privateOriginals.originals[1].source = 'model-shortcut'],
    ['request correlation missing', value => value.documents[0].privateOriginals.originals[1].requestOrdinal = 100],
    ['response invocation without original', value => Object.assign(value.documents[0].privateOriginals.originals[1],
        { source: 'api-request', requestOrdinal: null, invocationOrdinal: 1 })],
    ['browser error', value => value.documents[0].evidence.browser.recorder.errors.push({ name: 'Error' })],
    ['browser overflow', value => value.documents[0].evidence.browser.recordOverflow = true],
    ['metadata overflow', value =>
    {
        value.documents[0].privateOriginals.limits.records = 1;
        value.documents[0].evidence.browser.recorder.frames = [{}, {}];
    }],
    ['tail alone', value => value.documents[0].evidence = { identity: value.documents[0].evidence.identity,
        sceneId: value.documents[0].scene.id, captureCut: 2, phase: 'observer-disposal' }]
])
{
    test(`scene original reader rejects ${name} (Node model, not browser facts)`, () =>
    {
        // JSON cloning deliberately removes model aliases, like reopening actual JSON bytes.
        const value = JSON.parse(JSON.stringify(originalReaderModel()));
        mutate(value);
        assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(value));
    });
}

test('scene original reader reopens bounded private single-link bytes (Node file I/O)', t =>
{
    const value = rawRefFixture(t);
    const prefix = '.tmp/browser-contract/runs/owned-node-model/';
    const ref = { ...value.results[0].refs[0], digest: `sha256:${value.results[0].refs[0].digest}` };
    const read = () => readPublicShellLocaleSceneOriginalArtifact({ root: value.directory, ref, prefix });
    assert.deepEqual(read().bytes, value.bytes);
    fs.chmodSync(value.file, 0o644);
    assert.throws(read, /private/u);
    fs.chmodSync(value.file, 0o600);
    const other = `${value.file}.link`;
    fs.linkSync(value.file, other);
    assert.throws(read, /single-link/u);
    fs.unlinkSync(other);
    fs.truncateSync(value.file, 1024 * 1024 * 1024);
    assert.throws(read, /bounded/u);
    fs.writeFileSync(value.file, value.bytes);
    ref.digest = `sha256:${'0'.repeat(64)}`;
    assert.throws(read, /digest mismatch/u);
    ref.digest = `sha256:${createHash('sha256').update(value.bytes).digest('hex')}`;
    ref.path = `${prefix}../scene.json`;
    assert.throws(read, /canonical/u);
});

test('scene original reader rejects remaining budget exhaustion before opening or allocating (Node file I/O)', t =>
{
    const value = rawRefFixture(t);
    const input = { root: value.directory, prefix: '.tmp/browser-contract/runs/owned-node-model/',
        ref: { ...value.results[0].refs[0], digest: `sha256:${value.results[0].refs[0].digest}` } };
    let opens = 0;
    let allocations = 0;
    const originalOpen = fs.openSync;
    const originalAlloc = Buffer.alloc;
    t.mock.method(fs, 'openSync', (...args) =>
    {
        opens += 1;
        return originalOpen(...args);
    });
    t.mock.method(Buffer, 'alloc', (...args) =>
    {
        allocations += 1;
        return originalAlloc(...args);
    });
    syncBuiltinESMExports();
    t.after(() =>
    {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    });
    assert.throws(() => readPublicShellLocaleSceneOriginalArtifact({ ...input,
        remainingBytes: value.bytes.length - 1 }), /combined file byte budget exceeded before allocation/u);
    assert.equal(opens, 0);
    assert.equal(allocations, 0);
    for (const remainingBytes of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER, '1'])
    {
        assert.throws(() => readPublicShellLocaleSceneOriginalArtifact({ ...input, remainingBytes }), /remaining file byte budget invalid/u);
    }
    assert.equal(opens, 0);
    assert.equal(allocations, 0);
    assert.deepEqual(readPublicShellLocaleSceneOriginalArtifact({ ...input, remainingBytes: value.bytes.length }).bytes, value.bytes);
    assert.equal(opens, 1);
});

test('scene original reader rejects inode replacement between stat and open (Node file I/O)', t =>
{
    const value = rawRefFixture(t);
    const originalOpen = fs.openSync;
    let changed = false;
    t.mock.method(fs, 'openSync', (file, ...args) =>
    {
        if (file === value.file && !changed)
        {
            changed = true;
            fs.renameSync(file, `${file}.previous`);
            fs.writeFileSync(file, value.bytes, { mode: 0o600 });
        }
        return originalOpen(file, ...args);
    });
    syncBuiltinESMExports();
    t.after(() =>
    {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    });
    assert.throws(() => readPublicShellLocaleSceneOriginalArtifact({ root: value.directory,
        prefix: '.tmp/browser-contract/runs/owned-node-model/',
        ref: { ...value.results[0].refs[0], digest: `sha256:${value.results[0].refs[0].digest}` } }), /inode changed/u);
});

test('scene original reader rejects a changed file during the actual read (Node file I/O)', t =>
{
    const value = rawRefFixture(t);
    const originalRead = fs.readSync;
    let changed = false;
    t.mock.method(fs, 'readSync', (...args) =>
    {
        const count = originalRead(...args);
        if (!changed)
        {
            changed = true;
            fs.appendFileSync(value.file, 'changed-during-read');
        }
        return count;
    });
    syncBuiltinESMExports();
    t.after(() =>
    {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    });
    assert.throws(() => readPublicShellLocaleSceneOriginalArtifact({ root: value.directory,
        prefix: '.tmp/browser-contract/runs/owned-node-model/',
        ref: { ...value.results[0].refs[0], digest: `sha256:${value.results[0].refs[0].digest}` } }), /changed during read/u);
});

test('scene original reader checks normal and disposal prefix bytes separately (Node model)', () =>
{
    const value = JSON.parse(JSON.stringify(originalReaderModel()));
    const tail = structuredClone(value.documents[0]);
    tail.evidence = { identity: tail.evidence.identity, sceneId: tail.scene.id, captureCut: 2, phase: 'observer-disposal' };
    value.documents.push(tail);
    assert.deepEqual(validatePublicShellLocaleSceneOriginalDocuments(value), { documentCount: 2, sceneCount: 1 });
    tail.privateOriginals.originals[1].headersArray[0].value = 'changed tail header';
    assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(value), /prefix changed/u);
});

test('scene original reader requires a current caller and cannot replace native causal verification (Node model)', async () =>
{
    const owner = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    assert.equal(typeof owner.readPublicShellLocaleSceneOriginals, 'function');
    await assert.rejects(() => owner.readPublicShellLocaleSceneOriginals({ root, matrix, refs: [] }), /parent/u);
    assert.throws(() => requirePublicShellLocaleCausalVerification(), error => error.code === 'native-causal-not-observed');
});

for (const [name, mutate] of [
    ['same ordinal response changes GET to PUT', value =>
    {
        value.documents[0].evidence.responses[0].method = 'PUT';
        value.documents[0].privateOriginals.originals[1].method = 'PUT';
    }],
    ['same ordinal response changes actual URL', value =>
    {
        const url = `${value.runtime.runtime.frontendUrl}/other-resource`;
        value.runtime.resources.push({ url });
        Object.assign(value.documents[0].evidence.responses[0], { url, urlDigest: `sha256:${createHash('sha256').update(url).digest('hex')}` });
        value.documents[0].privateOriginals.originals[1].url = url;
    }],
    ['resource supplied omits resource URL and headers', value =>
    {
        const d = value.documents[0];
        d.evidence.captureCut = d.privateOriginals.captureCut = 3;
        d.privateOriginals.originals.push({ sequence: 3, kind: 'supplied-body', source: 'route-input', captureState: 'observed',
            requestOrdinal: 0, purpose: 'resource-replacement-input', representation: 'route-supplied-body',
            bodyEncoding: 'base64', bodyBase64: 'eA==', byteLength: 1, byteSha256: `sha256:${createHash('sha256').update('x').digest('hex')}` });
    }],
    ['metadata record exceeds actual collector bytes', value => value.documents[0].evidence.requests[0].extra = 'x'.repeat(originalCaptureLimits.headerBytes + 1)],
    ['browser frame 2049 exceeds actual collector count', value => value.documents[0].evidence.browser.recorder.frames = Array.from({ length: 2049 }, () => ({}))]
])
{
    test(`scene original P2 counterexample rejects ${name} (Node model only)`, () =>
    {
        const value = JSON.parse(JSON.stringify(originalReaderModel()));
        mutate(value);
        assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(value));
    });
}

test('scene original P2 parser export rejects unknown envelope before full object parse (Node model)', async () =>
{
    const owner = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    assert.equal(typeof owner.parsePublicShellLocaleSceneOriginalJson, 'function');
    const value = originalReaderModel();
    assert.throws(() => owner.parsePublicShellLocaleSceneOriginalJson(Buffer.from('{"extra":[[],[],[]]}'),
        { kind: 'scene', matrix: value.matrix, caller: value.caller }), /field/u);
});

test('scene original P2 parser accepts original scene and ledger shapes and escaped strings (Node model)', async () =>
{
    const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    const value = originalReaderModel();
    const options = { matrix: value.matrix, caller: value.caller, runtime: value.runtime };
    const sceneBytes = Buffer.from(JSON.stringify(value.documents[0], null, 4).replaceAll('/', '\\/'));
    assert.deepEqual(parse(sceneBytes, { ...options, kind: 'scene' }), value.documents[0]);
    value.bindings.leases[0].events = ['prepared', 'reserved', 'entered', 'finished'].map(phase => ({ phase, at: '2026-10-05T12:00:00.000Z' }));
    refreshOriginalReaderLedger(value);
    assert.deepEqual(parse(Buffer.from(JSON.stringify(value.bindings, null, 2)), { ...options, kind: 'ledger' }), value.bindings);
    const doc = JSON.parse(JSON.stringify(value.documents[0]));
    doc.evidence.browser.recorder.frames = [{ observedAt: 1, dom: {
        language: 'en-US', direction: 'ltr', hydrationKind: null, hydrated: false,
        metadata: { title: 'braces }],{ and quote " / \\ and Unicode 日本語\n\ud800', description: null, openGraphLocale: null },
        copyNodes: [], selectors: [], geometry: [], containment: [[0, 1]], viewport: { width: 10, height: 10 }, fonts: null
    } }];
    assert.deepEqual(parse(Buffer.from(JSON.stringify(doc)), { ...options, kind: 'scene' }), doc);
    assert.throws(() => requirePublicShellLocaleCausalVerification(), error => error.code === 'native-causal-not-observed');
});

test('scene original P2 preflight preserves the formal ledger failureClass without admitting a failed lease (Node model)', async () =>
{
    const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    const value = originalReaderModel();
    value.bindings.leases[0].firstFailure = { name: 'Error', message: 'original failure'.repeat(1000), failureClass: 'contract' };
    refreshOriginalReaderLedger(value);
    const parsed = parse(Buffer.from(JSON.stringify(value.bindings)), { kind: 'ledger', matrix: value.matrix,
        caller: value.caller, runtime: value.runtime });
    assert.deepEqual(parsed, value.bindings);
    assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments({ ...value, bindings: parsed }), /no terminal successful lease/u);
    assert.throws(() => requirePublicShellLocaleCausalVerification(), error => error.code === 'native-causal-not-observed');
});

for (const [name, source] of [
    ['unknown outer graph', () => '{"extra":[' + '[],'.repeat(5000) + '[]]}'],
    ['escaped duplicate key', value => JSON.stringify(value.documents[0]).replace('"scene":', `"sc\\u0065ne":${JSON.stringify(value.documents[0].scene)},"scene":`)],
    ['nested unknown record graph', value =>
    {
        value.documents[0].evidence.requests[0].extra = Array.from({ length: 20 }, () => []);
        return JSON.stringify(value.documents[0]);
    }],
    ['nested arrays instead of scene object', () => '{"scene":' + '['.repeat(1000) + '0' + ']'.repeat(1000) + '}'],
    ['empty array instead of frame', value =>
    {
        value.documents[0].evidence.browser.recorder.frames = [[]];
        return JSON.stringify(value.documents[0]);
    }],
    ['empty containment tuple', value =>
    {
        value.documents[0].evidence.browser.recorder.frames = [{ observedAt: 1, dom: { language: 'en', direction: 'ltr',
            hydrationKind: null, hydrated: false, metadata: { title: '', description: null, openGraphLocale: null },
            copyNodes: [], selectors: [], geometry: [], containment: [[]], viewport: { width: 10, height: 10 }, fonts: [] } }];
        return JSON.stringify(value.documents[0]);
    }],
    ['unterminated string', () => '{"scene":"unterminated}'],
    ['invalid escape', () => '{"scene":"\\q"}'],
    ['raw control character', () => '{"scene":"line\nfeed"}'],
    ['invalid unicode escape', () => '{"scene":"\\u0X00"}'],
    ['object trailing comma', value => JSON.stringify(value.documents[0]).replace(/\}$/u, ',}')],
    ['array trailing comma', value => JSON.stringify(value.documents[0]).replace('"issues":[]', '"issues":[,]')],
    ['trailing second document', value => JSON.stringify(value.documents[0]) + '{}'],
    ['infinite numeric token', value => JSON.stringify(value.documents[0]).replace('"captureCut":2', '"captureCut":1e999')],
    ['unknown ledger field', () => '{"extra":[[],[],[]]}']
])
{
    test(`scene original P2 preflight rejects ${name} before materializing an object graph (Node model)`, async t =>
    {
        const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
        const value = originalReaderModel();
        const input = source(value);
        const originalParse = JSON.parse;
        let fullObjectParses = 0;
        t.mock.method(JSON, 'parse', (text, ...args) =>
        {
            if (text.trimStart().startsWith('{') || text.trimStart().startsWith('['))
            {
                fullObjectParses += 1;
            }
            return originalParse(text, ...args);
        });
        assert.throws(() => parse(Buffer.from(input), { kind: name.includes('ledger') ? 'ledger' : 'scene',
            matrix: value.matrix, caller: value.caller, runtime: value.runtime }), error =>
        {
            assert.match(error.message, name === 'escaped duplicate key' ? /duplicate key/u : /JSON/u);
            return true;
        });
        assert.equal(fullObjectParses, 0, 'rejection must precede whole JSON.parse, not follow allocation');
    });
}

test('scene original P2 resource supplied requires the actual resource ordinal while preference shapes stay unchanged (Node model)', () =>
{
    const value = JSON.parse(JSON.stringify(originalReaderModel()));
    const d = value.documents[0];
    const url = `${value.runtime.runtime.frontendUrl}/resource.js`;
    value.runtime.resources.push({ url });
    d.evidence.requests.push({ url, urlDigest: `sha256:${createHash('sha256').update(url).digest('hex')}`,
        method: 'GET', resourceType: 'script', requestOrdinal: 1, captureSequence: 3 });
    d.evidence.captureCut = d.privateOriginals.captureCut = 4;
    const supplied = { sequence: 4, kind: 'supplied-body', source: 'route-input', captureState: 'observed', requestOrdinal: 1,
        purpose: 'resource-replacement-input', representation: 'route-supplied-body', url,
        headersArray: [{ name: 'Content-Type', value: 'text/javascript' }], headerRepresentation: 'route-supplied-headers',
        bodyEncoding: 'base64', bodyBase64: 'eA==', byteLength: 1, byteSha256: `sha256:${createHash('sha256').update('x').digest('hex')}` };
    d.privateOriginals.originals.push(supplied);
    assert.deepEqual(validatePublicShellLocaleSceneOriginalDocuments(value), { documentCount: 1, sceneCount: 1 });
    supplied.requestOrdinal = 0;
    assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(value), /resource request/u);
    supplied.requestOrdinal = 1;
    delete supplied.headersArray;
    assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(value));
    supplied.headersArray = [];
    supplied.url = `${url}-not-admitted`;
    assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(value));
    for (const purpose of ['forwarded-command', 'stale-delivery-input'])
    {
        delete supplied.url;
        delete supplied.headersArray;
        delete supplied.headerRepresentation;
        supplied.purpose = purpose;
        supplied.requestOrdinal = 0;
        assert.deepEqual(validatePublicShellLocaleSceneOriginalDocuments(value), { documentCount: 1, sceneCount: 1 });
    }
});

test('scene original P2 URL correlation handles collector redaction and separate redirected ordinals (Node model)', () =>
{
    const value = JSON.parse(JSON.stringify(originalReaderModel()));
    const d = value.documents[0];
    const actual = `${d.privateOriginals.originals[0].url}?original=private-query`;
    const represented = `${value.runtime.runtime.frontendUrl}/?[redacted]`;
    for (const record of [d.evidence.requests[0], d.evidence.responses[0]])
    {
        record.url = represented;
        record.urlDigest = `sha256:${createHash('sha256').update(actual).digest('hex')}`;
    }
    d.privateOriginals.originals[0].url = actual;
    d.privateOriginals.originals[1].url = actual;
    assert.deepEqual(validatePublicShellLocaleSceneOriginalDocuments(value), { documentCount: 1, sceneCount: 1 });
    // Redirect is a new actual Request/ordinal, not permission to change ordinal0's URL.
    const redirected = `${value.runtime.runtime.frontendUrl}/redirected`;
    d.evidence.requests.push({ ...d.evidence.requests[0], url: redirected,
        urlDigest: `sha256:${createHash('sha256').update(redirected).digest('hex')}`, requestOrdinal: 1, captureSequence: 3 });
    d.evidence.responses.push({ ...d.evidence.responses[0], url: redirected,
        urlDigest: `sha256:${createHash('sha256').update(redirected).digest('hex')}`, requestOrdinal: 1, captureSequence: 4 });
    d.privateOriginals.originals.push({ ...d.privateOriginals.originals[0], url: redirected, requestOrdinal: 1, sequence: 3 },
        { ...d.privateOriginals.originals[1], url: redirected, requestOrdinal: 1, sequence: 4 });
    d.evidence.captureCut = d.privateOriginals.captureCut = 4;
    assert.deepEqual(validatePublicShellLocaleSceneOriginalDocuments(value), { documentCount: 1, sceneCount: 1 });
    d.privateOriginals.originals[3].requestOrdinal = 0;
    d.evidence.responses[1].requestOrdinal = 0;
    assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(value));
});

test('scene original P2 invocation parent joins the actual request and preserves GET compensation for a PUT parent (Node model)', () =>
{
    const value = JSON.parse(JSON.stringify(originalReaderModel()));
    const d = value.documents[0];
    const url = value.runtime.preferenceUrl;
    d.evidence.requests.push({ url, urlDigest: `sha256:${createHash('sha256').update(url).digest('hex')}`,
        method: 'PUT', resourceType: 'fetch', requestOrdinal: 1, captureSequence: 3 });
    d.evidence.captureCut = d.privateOriginals.captureCut = 4;
    const metadata = { source: 'api-request', parentRequestOrdinal: 1, method: 'GET', url, invocationOrdinal: 1 };
    d.privateOriginals.originals.push({ kind: 'invocation', sequence: 4, captureState: 'observed', ...metadata },
        { ...d.privateOriginals.originals[1], kind: 'response', sequence: 4, ...metadata, requestOrdinal: null });
    assert.deepEqual(validatePublicShellLocaleSceneOriginalDocuments(value), { documentCount: 1, sceneCount: 1 });
    for (const leaf of d.privateOriginals.originals.slice(2))
    {
        leaf.parentRequestOrdinal = 100;
    }
    assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(value), /parent/u);
    for (const leaf of d.privateOriginals.originals.slice(2))
    {
        leaf.parentRequestOrdinal = 1;
        leaf.source = 'route-fetch';
    }
    assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments(value), /parent/u);
});

test('scene original P2 preflight keeps legal metadata and preload bounds distinct from raw string and recorder limits (Node model)', async () =>
{
    const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    const value = JSON.parse(JSON.stringify(originalReaderModel()));
    const d = value.documents[0];
    const url = `${value.runtime.runtime.frontendUrl}/${'x'.repeat(originalCaptureLimits.stringBytes + 1)}`;
    d.evidence.requests.push({ url, urlDigest: `sha256:${createHash('sha256').update(url).digest('hex')}`,
        method: 'GET', resourceType: 'fetch', requestOrdinal: 1, captureSequence: 3 });
    const preload = `${value.runtime.runtime.frontendUrl}/${'x'.repeat(originalCaptureLimits.headerBytes + 1)}`;
    d.evidence.browser.preloads.push({ url: preload, urlDigest: `sha256:${createHash('sha256').update(preload).digest('hex')}`, rel: 'preload', as: 'script' });
    d.evidence.captureCut = d.privateOriginals.captureCut = 3;
    assert.deepEqual(parse(Buffer.from(JSON.stringify(d)), { kind: 'scene', matrix: value.matrix, caller: value.caller, runtime: value.runtime }), d);
    assert.deepEqual(validatePublicShellLocaleSceneOriginalDocuments(value), { documentCount: 1, sceneCount: 1 });
});

test('scene original P2 parser refuses malformed UTF8, nested header graphs and record budget before whole parse (Node model)', async t =>
{
    const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    const value = originalReaderModel();
    const options = { kind: 'scene', matrix: value.matrix, caller: value.caller, runtime: value.runtime };
    const input = JSON.stringify(value.documents[0]);
    const malformed = Buffer.concat([Buffer.from('{"scene":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    const nonAsciiNumber = Buffer.from(input);
    const numberOffset = nonAsciiNumber.indexOf(Buffer.from('"captureCut":2')) + Buffer.byteLength('"captureCut":');
    assert.ok(numberOffset >= Buffer.byteLength('"captureCut":'));
    nonAsciiNumber[numberOffset] = 0xb2;
    const header = structuredClone(value.documents[0]);
    header.privateOriginals.originals[1].headersArray[0].value = { graph: [[]] };
    const frame = structuredClone(value.documents[0]);
    frame.evidence.browser.recorder.events = [{ name: 'locale_runtime_phase', from: null, to: null,
        locale: 'x'.repeat(originalCaptureLimits.headerBytes) }];
    const originalParse = JSON.parse;
    let fullParses = 0;
    t.mock.method(JSON, 'parse', (text, ...args) =>
    {
        if (text.trimStart().startsWith('{') || text.trimStart().startsWith('['))
        {
            fullParses += 1;
        }
        return originalParse(text, ...args);
    });
    for (const bytes of [malformed, nonAsciiNumber, Buffer.from(JSON.stringify(header)), Buffer.from(JSON.stringify(frame)),
        Buffer.from(input.replace('"captureCut":2', '"captureCut":02'))])
    {
        assert.throws(() => parse(bytes, options));
    }
    assert.equal(fullParses, 0);
});

test('scene original writer shape admits the canonical empty driverObservations on normal and tail (Node model)', async () =>
{
    const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    const value = originalReaderModel();
    const normal = value.documents[0];
    normal.evidence.driverObservations = [];
    const tail = structuredClone(normal);
    tail.evidence = { identity: normal.evidence.identity, sceneId: normal.scene.id,
        captureCut: normal.evidence.captureCut, phase: 'observer-disposal', driverObservations: [] };
    const options = { kind: 'scene', matrix: value.matrix, caller: value.caller, runtime: value.runtime };
    assert.deepEqual(parse(Buffer.from(JSON.stringify(normal)), options), normal);
    assert.deepEqual(parse(Buffer.from(JSON.stringify(tail)), options), tail);
    assert.deepEqual(validatePublicShellLocaleSceneOriginalDocuments({ ...value, documents: [normal, tail] }), { documentCount: 2, sceneCount: 1 });
    assert.throws(() => requirePublicShellLocaleCausalVerification(), error => error.code === 'native-causal-not-observed');
});

// Writer-shaped Node data/port models, never rendered/browser facts or qualified stage results.
function originalWriterDomModel()
{
    return { language: 'en-US', direction: 'ltr', hydrationKind: null, hydrated: false,
        metadata: { title: 'Node writer model', description: null, openGraphLocale: null },
        copyNodes: [], selectors: [], geometry: [], containment: [], viewport: { width: 390, height: 844 }, fonts: null };
}

function originalWriterStageModel(issue)
{
    const value = originalReaderModel();
    const scene = matrix.scenes.find(item => item.issue === issue && item.authActionContext === 'anonymous'
        && item.route === 'Home');
    assert.ok(scene);
    value.matrix = { ...matrix, scenes: [scene] };
    const document = value.documents[0];
    document.scene = structuredClone(scene);
    for (const record of [document.lease, document.evidence, document.privateOriginals.binding, value.bindings.leases[0]])
    {
        record.sceneId = scene.id;
    }
    const negotiation = matrix.negotiationCases.find(item => item.id === scene.negotiationId);
    document.lease.authority.inputs = { viewport: scene.viewport, javaScriptEnabled: scene.issue !== 2083,
        acceptLanguage: negotiation.header, cookie: negotiation.cookie, cookieName: value.runtime.cookieName };
    refreshOriginalReaderLedger(value);
    const capture = structuredClone(document.evidence);
    capture.browser.recorder.frames = [{ observedAt: 1, dom: originalWriterDomModel() }];
    const trace = { identity: capture.identity, sceneId: scene.id,
        observations: [{ stage: 'before-click', dom: originalWriterDomModel() },
            { stage: 'pending', target: scene.locale, dom: originalWriterDomModel() },
            { stage: 'after-commit', dom: originalWriterDomModel() }],
        telemetry: [{ name: 'locale_runtime_committed', level: 'info', generation: 1, locale: scene.locale, from: null, to: null }],
        requests: [{ identity: 'a'.repeat(64), type: 'document', method: 'GET' }],
        issues: [], failedRequests: [], domGaps: { unobservedKeys: [], hiddenControls: [] },
        remainingContracts: ['atomic painted-frame continuity'] };
    const observations = issue === 2084
        ? [{ stage: 'first-html', dom: originalWriterDomModel(), evidence: capture },
            { stage: 'hydration-start', observation: { observedAt: 1, dom: originalWriterDomModel() }, evidence: capture },
            ...['interactive-ready', 'selector-open'].map(stage => ({ stage, dom: originalWriterDomModel(), evidence: capture }))]
        : issue === 2085
            ? [{ stage: 'initial-network', fontObservation: { status: 'loaded',
                checks: [{ weight: 400, available: true }],
                faces: [{ family: 'Node model face', weight: '400', status: 'loaded', unicodeRange: 'U+0-FF' }] }, evidence: capture }]
            : [...trace.observations.map(observation => ({ ...observation, evidence: capture })),
                { stage: 'post-commit', trace, evidence: capture },
                { stage: 'first-failure', trace: { ...trace, failure: { name: 'Error', message: 'Node failure' } }, evidence: capture }];
    document.evidence.driverObservations = observations;
    return value;
}

function originalWriterSelectorModel()
{
    const value = originalWriterStageModel(2084);
    const document = value.documents[0];
    const selector = { active: document.scene.locale, pending: null, visible: true, expanded: false, disabled: false,
        items: document.scene.selectorItems.map(item => ({ code: item.code, selected: item.code === document.scene.locale,
            visible: false, ariaLabelOrText: item.nativeName, nativeName: item.nativeName,
            englishName: item.englishName !== item.nativeName ? item.englishName : null, direction: item.direction, disabled: false })) };
    document.evidence.browser.recorder.frames = [{ observedAt: 1, dom: { ...originalWriterDomModel(), selectors: [selector] } }];
    for (const observation of document.evidence.driverObservations)
    {
        const dom = observation.dom ?? observation.observation.dom;
        dom.selectors = [structuredClone(selector)];
    }
    return value;
}

test('scene original selector grammar retains captured projection fields (Node model only)', async () =>
{
    const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    const value = originalWriterSelectorModel();
    const document = value.documents[0];
    assert.deepEqual(parse(Buffer.from(JSON.stringify(document)), { kind: 'scene', matrix: value.matrix,
        caller: value.caller, runtime: value.runtime }), document);
    assert.throws(() => requirePublicShellLocaleCausalVerification(), error => error.code === 'native-causal-not-observed');
});

for (const [name, mutate] of [
    ['unknown selector field', selector => selector.unobserved = {}],
    ['unknown item field', selector => selector.items[0].unobserved = {}],
    ['missing selector disabled', selector => delete selector.disabled],
    ['missing item disabled', selector => delete selector.items[0].disabled],
    ['missing native label', selector => delete selector.items[0].nativeName],
    ['missing English label', selector => delete selector.items[0].englishName],
    ['missing direction', selector => delete selector.items[0].direction],
    ['string selector disabled', selector => selector.disabled = 'false'],
    ['numeric item disabled', selector => selector.items[0].disabled = 0],
    ['numeric native label', selector => selector.items[0].nativeName = 7],
    ['boolean English label', selector => selector.items[0].englishName = false],
    ['nested direction', selector => selector.items[0].direction = []]
])
{
    test(`scene original selector grammar rejects ${name} (Node model only)`, async () =>
    {
        const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
        const value = originalWriterSelectorModel();
        mutate(value.documents[0].evidence.browser.recorder.frames[0].dom.selectors[0]);
        assert.throws(() => parse(Buffer.from(JSON.stringify(value.documents[0])), { kind: 'scene', matrix: value.matrix,
            caller: value.caller, runtime: value.runtime }), /JSON/u);
    });
}

for (const issue of [2084, 2085, 2086])
{
    test(`scene original writer shape admits actual finite ${issue} stage captures on normal and disposal (Node model)`, async () =>
    {
        const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
        const value = originalWriterStageModel(issue);
        const document = value.documents[0];
        const options = { kind: 'scene', matrix: value.matrix, caller: value.caller, runtime: value.runtime };
        const parsed = parse(Buffer.from(JSON.stringify(document)), options);
        assert.deepEqual(parsed, document);
        const tail = structuredClone(document);
        tail.evidence = { identity: document.evidence.identity, sceneId: document.scene.id,
            captureCut: document.evidence.captureCut, phase: 'observer-disposal', driverObservations: document.evidence.driverObservations };
        assert.deepEqual(parse(Buffer.from(JSON.stringify(tail)), options), tail);
        assert.deepEqual(validatePublicShellLocaleSceneOriginalDocuments({ ...value, documents: [parsed, tail] }), { documentCount: 2, sceneCount: 1 });
        assert.throws(() => requirePublicShellLocaleCausalVerification(), error => error.code === 'native-causal-not-observed');
    });
}

test('scene original writer shape reads actual lifecycle missing-page failure inputs but never admits them (Node port model)', async () =>
{
    const { withPublicShellLocaleLifecycleScene } = await import(new URL('../browser-contract/public-shell-locale-lifecycle-binding.mjs', import.meta.url));
    const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    const value = originalWriterStageModel(2084);
    const document = value.documents[0];
    const identity = document.evidence.identity;
    const original = new Error('actual Node lifecycle operation failure');
    const saved = [];
    const context = { pages: () => [], on: () =>
    {}, off: () =>
    {}, addInitScript: async () =>
    {} };
    const harness = { identity, withScene: async (sceneId, createContext, callback) =>
        await callback({ context, fixture: {}, lease: document.lease }) };
    await assert.rejects(withPublicShellLocaleLifecycleScene({ harness, matrix: value.matrix,
        bindings: { identity, resources: [], preferenceUrl: value.runtime.preferenceUrl },
        sceneId: document.scene.id, createContext: async () => context,
        observe: async () =>
        {
            throw original;
        }, saveEvidence: async input => saved.push({ ...input,
            evidence: { ...input.evidence, driverObservations: [] } }) }), error => error === original);
    assert.equal(saved.length, 2);
    assert.equal(saved[0].evidence.pageCount, 0);
    assert.equal(Object.hasOwn(saved[0].evidence, 'captureCut'), false);
    assert.equal(saved[0].evidence.observationFailure.message, original.message);
    assert.equal(saved[1].evidence.phase, 'observer-disposal');
    for (const input of saved)
    {
        const diagnostic = { ...document, evidence: input.evidence, privateOriginals: input.privateOriginals, failure: input.failure };
        const parsed = parse(Buffer.from(JSON.stringify(diagnostic)), { kind: 'scene', matrix: value.matrix, caller: value.caller, runtime: value.runtime });
        assert.deepEqual(parsed, diagnostic);
        assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments({ ...value, documents: [parsed] }));
    }
    assert.throws(() => requirePublicShellLocaleCausalVerification(), error => error.code === 'native-causal-not-observed');
});

test('scene original writer shape reads the actual capture-exception fallback with no cut or pageCount (Node port model)', async () =>
{
    const { withPublicShellLocaleLifecycleScene } = await import(new URL('../browser-contract/public-shell-locale-lifecycle-binding.mjs', import.meta.url));
    const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    const value = originalWriterStageModel(2084);
    const document = value.documents[0];
    const identity = document.evidence.identity;
    const original = new Error('actual Node capture read failure');
    const pages = [];
    const saved = [];
    const context = { pages: () => pages, on: () =>
    {}, off: () =>
    {}, addInitScript: async () =>
    {} };
    const harness = { identity, withScene: async (sceneId, createContext, callback) =>
        await callback({ context, fixture: {}, lease: document.lease }) };
    await assert.rejects(withPublicShellLocaleLifecycleScene({ harness, matrix: value.matrix,
        bindings: { identity, resources: [], preferenceUrl: value.runtime.preferenceUrl },
        sceneId: document.scene.id, createContext: async () => context,
        observe: async () => pages.push({ evaluate: async () =>
        {
            throw original;
        } }), saveEvidence: async input => saved.push({ ...input,
            evidence: { ...input.evidence, driverObservations: [] } }) }), error => error === original);
    assert.equal(saved.length, 2);
    assert.equal(Object.hasOwn(saved[0].evidence, 'pageCount'), false);
    assert.equal(Object.hasOwn(saved[0].evidence, 'captureCut'), false);
    assert.equal(saved[0].evidence.observationFailure.message, original.message);
    for (const input of saved)
    {
        const diagnostic = { ...document, evidence: input.evidence, privateOriginals: input.privateOriginals, failure: input.failure };
        const parsed = parse(Buffer.from(JSON.stringify(diagnostic)), { kind: 'scene', matrix: value.matrix, caller: value.caller, runtime: value.runtime });
        assert.deepEqual(parsed, diagnostic);
        assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments({ ...value, documents: [parsed] }));
    }
});

test('scene original writer shape reads finite capture failure records without discarding sticky failure (Node model)', async () =>
{
    const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    const value = originalWriterStageModel(2086);
    const document = value.documents[0];
    document.failure = { name: 'Error', message: 'actual writer-shaped first failure' };
    document.evidence.observationFailure = document.failure;
    document.evidence.issues = [{ kind: 'warning', digest: 'a'.repeat(64), location: null, captureSequence: 2 },
        { kind: 'error', digest: 'a'.repeat(64), location: { url: 'http://node-model.invalid/', urlDigest: 'b'.repeat(64),
            lineNumber: 1, columnNumber: 2 }, captureSequence: 2 },
        { kind: 'pageerror', digest: 'a'.repeat(64), captureSequence: 2 },
        { kind: 'requestfailed', requestOrdinal: 0, urlDigest: 'a'.repeat(64), failureDigest: 'b'.repeat(64), captureSequence: 2 }];
    document.evidence.browser.recorder.errors = [{ name: 'Error', digest: 'c'.repeat(64) }];
    const diagnosticName = 'Error'.repeat(originalCaptureLimits.headerBytes);
    document.evidence.responses[0].observationError = { name: diagnosticName, digest: 'd'.repeat(64) };
    document.privateOriginals.failures = [{ sequence: 2, reason: 'read-or-validation-failed', name: diagnosticName }];
    const parsed = parse(Buffer.from(JSON.stringify(document)), { kind: 'scene', matrix: value.matrix, caller: value.caller, runtime: value.runtime });
    assert.deepEqual(parsed, document);
    assert.throws(() => validatePublicShellLocaleSceneOriginalDocuments({ ...value, documents: [parsed] }), /sticky failure/u);
    assert.throws(() => requirePublicShellLocaleCausalVerification(), error => error.code === 'native-causal-not-observed');
});

for (const [name, mutate] of [
    ['outer qualified boolean', value => value.documents[0].evidence.driverObservations[0].qualified = true],
    ['nested capture body batch', value => value.documents[0].evidence.driverObservations[0].evidence.privateOriginals = value.documents[0].privateOriginals],
    ['nested capture driver recursion', value => value.documents[0].evidence.driverObservations[0].evidence.driverObservations = [[]]],
    ['unknown stage variant', value => value.documents[0].evidence.driverObservations[0].stage = 'fake-qualified-stage'],
    ['nested unknown trace graph', value => value.documents[0].evidence.driverObservations[3].trace.extra = Array.from({ length: 1000 }, () => [])],
    ['trace qualified boolean', value => value.documents[0].evidence.driverObservations[3].trace.qualificationEligible = true],
    ['trace body batch', value => value.documents[0].evidence.driverObservations[3].trace.privateOriginals = value.documents[0].privateOriginals],
    ['wrong pending stage shape', value => delete value.documents[0].evidence.driverObservations[1].target],
    ['extra recorder graph in nested capture', value => value.documents[0].evidence.driverObservations[0].evidence.browser.recorder.extra = [[]]],
    ['driver observation count overflow', value => value.documents[0].evidence.driverObservations = Array.from({ length: originalCaptureLimits.records + 1 }, () => value.documents[0].evidence.driverObservations[0])]
])
{
    test(`scene original writer shape rejects ${name} before whole object parse (Node model)`, async t =>
    {
        const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
        const value = originalWriterStageModel(2086);
        mutate(value);
        const bytes = Buffer.from(JSON.stringify(value.documents[0]));
        const originalParse = JSON.parse;
        let fullParses = 0;
        t.mock.method(JSON, 'parse', (text, ...args) =>
        {
            if (text.trimStart().startsWith('{') || text.trimStart().startsWith('['))
            {
                fullParses += 1;
            }
            return originalParse(text, ...args);
        });
        assert.throws(() => parse(bytes, { kind: 'scene', matrix: value.matrix, caller: value.caller, runtime: value.runtime }));
        assert.equal(fullParses, 0);
    });
}

test('scene original writer shape preserves duplicate-key and syntax rejection inside finite stage variants (Node model)', async t =>
{
    const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    const value = originalWriterStageModel(2086);
    const source = JSON.stringify(value.documents[0]);
    const originalParse = JSON.parse;
    let fullParses = 0;
    t.mock.method(JSON, 'parse', (text, ...args) =>
    {
        if (text.trimStart().startsWith('{') || text.trimStart().startsWith('['))
        {
            fullParses += 1;
        }
        return originalParse(text, ...args);
    });
    for (const bytes of [
        Buffer.from(source.replace('"stage":"before-click"', '"stage":"before-click","st\\u0061ge":"before-click"')),
        Buffer.from(source.replace('"stage":"before-click"', '"stage":"before-click",')),
        Buffer.from(source.replace('"stage":"before-click"', '"stage":"before\\qclick"'))
    ])
    {
        assert.throws(() => parse(bytes, { kind: 'scene', matrix: value.matrix, caller: value.caller, runtime: value.runtime }));
    }
    assert.equal(fullParses, 0);
});

test('scene original writer shape enforces the unchanged run retained stage-byte budget before whole parse (Node model)', async t =>
{
    const { parsePublicShellLocaleSceneOriginalJson: parse } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    const value = originalWriterStageModel(2085);
    const observation = value.documents[0].evidence.driverObservations[0];
    observation.fontObservation.faces = Array.from({ length: 140 }, () => ({ family: 'Node model', weight: '400', status: 'loaded',
        unicodeRange: 'x'.repeat(originalCaptureLimits.headerBytes) }));
    value.documents[0].evidence.driverObservations = [observation, observation];
    assert.ok(value.documents[0].evidence.driverObservations.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0)
        > originalCaptureLimits.totalBytes);
    const bytes = Buffer.from(JSON.stringify(value.documents[0]));
    const originalParse = JSON.parse;
    let fullParses = 0;
    t.mock.method(JSON, 'parse', (text, ...args) =>
    {
        if (text.trimStart().startsWith('{') || text.trimStart().startsWith('['))
        {
            fullParses += 1;
        }
        return originalParse(text, ...args);
    });
    assert.throws(() => parse(bytes, { kind: 'scene', matrix: value.matrix, caller: value.caller, runtime: value.runtime }), /retained array byte budget/u);
    assert.equal(fullParses, 0);
});

// JSON contract model only: no executable, browser, fixture or raw-ref observation.
function rootBindingModel()
{
    const planBody = {
        schema: 'fsusblog.playwright-browser-identity.v1',
        executionClass: 'correctness',
        evidenceClass: 'browser-contract',
        qualificationEligible: true,
        managedExecutable: true,
        browserName: 'chromium',
        browserVersion: '140.0.0.0',
        revision: '1200',
        executablePath: '/node-contract-model/chromium-1200/chrome',
        executableSha256: `sha256:${'a'.repeat(64)}`,
        playwright: {
            package: '@playwright/test', version: '1.55.0',
            packageDigest: `sha256:${'b'.repeat(64)}`, browserCatalogDigest: `sha256:${'c'.repeat(64)}`
        },
        launchOptions: {
            headless: true, executablePath: '/node-contract-model/chromium-1200/chrome', args: ['--use-gl=angle']
        },
        rendering: {
            fontSetDigest: `sha256:${'d'.repeat(64)}`, localeDataDigest: `sha256:${'e'.repeat(64)}`,
            locale: 'en-US', deviceScaleFactor: 1, renderingMode: 'headless', colorScheme: 'light', gpuMode: 'software'
        }
    };
    const plan = { ...planBody, contentDigest: `sha256:${gateDigest(planBody)}` };
    const actualBody = {
        ...planBody,
        schema: 'fsusblog.playwright-browser-actual.v1',
        planDigest: plan.contentDigest,
        renderingObservation: { locale: 'en-US', deviceScaleFactor: 1, colorScheme: 'light', renderer: 'swiftshader' }
    };
    const roles = ['provider-state', 'fixture-manifest', 'prepare-state', 'fixture-receipt',
        'build-receipt', 'browser-plan', 'browser-actual', 'cookie-source'];
    const preparation = { id: 'cb10d681-ef3b-4b55-8e7d-6043f1ec1c24', startedAt: '2026-10-04T12:00:00.000Z' };
    return {
        schema: 'fsusblog.public-shell-locale-root-binding.v1',
        matrixDigest: matrix.contentDigest,
        sourceState: { commit: matrix.identity.sourceCommit, worktreeFingerprint: matrix.identity.worktreeFingerprint },
        buildDigest: 'f'.repeat(64),
        identity: { commit: matrix.identity.sourceCommit, runId: 'node-model-run', laneId: 'browser-contract', namespace: 'node-model-owner' },
        preparation,
        resources: {
            fixtureRoot: '/node-contract-model/private-fixture', databaseInstance: 'node-model-pg', databaseSchema: 'public',
            redisInstance: 'node-model-redis', redisNamespace: 'node-model-owner'
        },
        runtimeId: 'node-model-dedicated-runtime',
        fixtureReceiptDigest: `sha256:${'1'.repeat(64)}`,
        plan,
        actual: { ...actualBody, contentDigest: `sha256:${gateDigest(actualBody)}` },
        launchOrdinal: 1,
        refs: roles.map((role) => ({
            role, path: `.tmp/browser-contract/runs/node-model-owner/bindings/${preparation.id}/${role}.json`,
            digest: gateDigest({ modelRef: role })
        }))
    };
}

test('root identity mapping derives the exact closed tuples without changing caller input', () =>
{
    const binding = rootBindingModel();
    const before = structuredClone(binding);
    const fixtureId = gateDigest({
        fixtureReceiptDigest: binding.fixtureReceiptDigest, preparation: binding.preparation,
        sourceState: binding.sourceState, buildDigest: binding.buildDigest, runtimeId: binding.runtimeId,
        identity: binding.identity, resources: binding.resources
    });
    const browserId = gateDigest({
        fixtureId, runtimeId: binding.runtimeId, preparation: binding.preparation,
        sourceState: binding.sourceState, buildDigest: binding.buildDigest,
        planDigest: binding.plan.contentDigest, actualDigest: binding.actual.contentDigest, ordinal: 1
    });
    const expected = publicShellLocaleIdentity(matrix, binding.buildDigest, {
        runtimeId: binding.runtimeId, fixtureId, browserId
    });
    assert.deepEqual(derivePublicShellLocaleRootIdentity(matrix, binding), expected);
    assert.deepEqual(binding, before);
    assert.equal(Object.hasOwn(expected, 'qualificationEligible'), false);
    assert.equal(Object.hasOwn(expected, 'resolvedLaunch'), false);
    const reordered = Object.fromEntries(Object.entries(binding).reverse());
    reordered.refs = [...binding.refs].reverse();
    assert.deepEqual(derivePublicShellLocaleRootIdentity(matrix, reordered), expected);
});

test('root identity mapping separates preparations with the same stable browser actual digest', () =>
{
    const first = rootBindingModel();
    const second = structuredClone(first);
    second.preparation.id = '9f37a062-ab9b-41b8-b775-69bc3fa89f81';
    for (const ref of second.refs)
    {
        ref.path = ref.path.replace(first.preparation.id, second.preparation.id);
    }
    assert.equal(first.actual.contentDigest, second.actual.contentDigest);
    const before = derivePublicShellLocaleRootIdentity(matrix, first);
    const after = derivePublicShellLocaleRootIdentity(matrix, second);
    assert.equal(before.runtimeId, after.runtimeId);
    assert.notEqual(before.fixtureId, after.fixtureId);
    assert.notEqual(before.browserId, after.browserId);
});

test('root identity mapping does not adopt uniform rehashed model result IDs', () =>
{
    const binding = rootBindingModel();
    const expected = derivePublicShellLocaleRootIdentity(matrix, binding);
    const results = matrix.scenes.slice(0, 2).map((scene) => resultFor(scene, expected));
    for (const result of results)
    {
        assert.deepEqual(result.identity, expected);
        Object.assign(result.identity = structuredClone(result.identity), {
            runtimeId: 'uniform-forged-runtime', fixtureId: 'uniform-forged-fixture', browserId: 'uniform-forged-browser'
        });
        delete result.contentDigest;
        result.contentDigest = gateDigest(result);
        assert.notDeepEqual(result.identity, expected);
    }
    // This tests the caller's independent expected mapping, not the unchanged
    // aggregate/verifier entry points or model raw becoming browser evidence.
    assert.deepEqual(derivePublicShellLocaleRootIdentity(matrix, binding), expected);
});

for (const [name, mutate] of [
    ['null binding', () => null],
    ['array binding', () => []],
    ['unknown schema', (value) =>
    {
        value.schema = 'invented';
    }],
    ['extra self-proving flag', (value) =>
    {
        value.resolvedLaunch = true;
    }],
    ['missing field', (value) =>
    {
        delete value.runtimeId;
    }],
    ['matrix drift', (value) =>
    {
        value.matrixDigest = '0'.repeat(64);
    }],
    ['source drift', (value) =>
    {
        value.sourceState.commit = '0'.repeat(40);
    }],
    ['nonprimitive source commit', (value) =>
    {
        value.sourceState.commit = { valueOf: null, toString: null };
    }],
    ['fingerprint drift', (value) =>
    {
        value.sourceState.worktreeFingerprint = '0'.repeat(64);
    }],
    ['source extra key', (value) =>
    {
        value.sourceState.expected = true;
    }],
    ['identity commit drift', (value) =>
    {
        value.identity.commit = '0'.repeat(40);
    }],
    ['identity extra key', (value) =>
    {
        value.identity.fixtureId = 'forged';
    }],
    ['empty identity', (value) =>
    {
        value.identity.runId = '';
    }],
    ['invalid build digest', (value) =>
    {
        value.buildDigest = 'invalid';
    }],
    ['missing receipt digest', (value) =>
    {
        value.fixtureReceiptDigest = null;
    }],
    ['invalid preparation id', (value) =>
    {
        value.preparation.id = 'arbitrary-uuid-label';
    }],
    ['invalid preparation date', (value) =>
    {
        value.preparation.startedAt = 'not-a-date';
    }],
    ['noncanonical preparation date', (value) =>
    {
        value.preparation.startedAt = '2026-02-30T12:00:00.000Z';
    }],
    ['extra preparation key', (value) =>
    {
        value.preparation.checked = true;
    }],
    ['relative fixture root', (value) =>
    {
        value.resources.fixtureRoot = 'private-fixture';
    }],
    ['aliased fixture root', (value) =>
    {
        value.resources.fixtureRoot += '/..';
    }],
    ['empty resource', (value) =>
    {
        value.resources.redisInstance = '';
    }],
    ['extra resource key', (value) =>
    {
        value.resources.owned = true;
    }],
    ['empty runtime', (value) =>
    {
        value.runtimeId = '';
    }],
    ['noncanonical runtime', (value) =>
    {
        value.runtimeId = '../foreign';
    }],
    ['zero launch ordinal', (value) =>
    {
        value.launchOrdinal = 0;
    }],
    ['second launch ordinal', (value) =>
    {
        value.launchOrdinal = 2;
    }],
    ['missing ref', (value) =>
    {
        value.refs.pop();
    }],
    ['duplicate role', (value) =>
    {
        value.refs[1].role = value.refs[0].role;
    }],
    ['unknown role', (value) =>
    {
        value.refs[0].role = 'invented';
    }],
    ['duplicate path', (value) =>
    {
        value.refs[1].path = value.refs[0].path;
    }],
    ['extra ref field', (value) =>
    {
        value.refs[0].sourcePath = value.refs[0].path;
    }],
    ['ref traversal', (value) =>
    {
        value.refs[0].path = `.tmp/browser-contract/runs/node-model-owner/bindings/${value.preparation.id}/../x.json`;
    }],
    ['ref dot alias', (value) =>
    {
        value.refs[0].path = `.tmp/browser-contract/runs/node-model-owner/bindings/${value.preparation.id}/./x.json`;
    }],
    ['ref separator alias', (value) =>
    {
        value.refs[0].path = value.refs[0].path.replaceAll('/', '\\');
    }],
    ['absolute ref', (value) =>
    {
        value.refs[0].path = `/${value.refs[0].path}`;
    }],
    ['cross-owner ref', (value) =>
    {
        value.refs[0].path = `.tmp/browser-contract/runs/foreign/bindings/${value.preparation.id}/x.json`;
    }],
    ['cross-preparation ref', (value) =>
    {
        value.refs[0].path = value.refs[0].path.replace(value.preparation.id, '9f37a062-ab9b-41b8-b775-69bc3fa89f81');
    }],
    ['unscoped preparation ref', (value) =>
    {
        value.refs[0].path = value.refs[0].path.replace(`${value.preparation.id}/`, '');
    }],
    ['invalid ref digest', (value) =>
    {
        value.refs[0].digest = 'not-a-digest';
    }],
    ['nonserializable plan', (value) =>
    {
        value.plan.browserType = {};
    }],
    ['undefined browser value', (value) =>
    {
        value.actual.browserVersion = undefined;
    }],
    ['callable browser value', (value) =>
    {
        value.plan.browserVersion = () => 'fake';
    }],
    ['cyclic browser value', (value) =>
    {
        value.actual.renderingObservation.self = value.actual;
    }],
    ['nonfinite browser value', (value) =>
    {
        value.actual.renderingObservation.deviceScaleFactor = Infinity;
    }],
    ['accessor ref', (value) =>
    {
        Object.defineProperty(value.refs[0], 'digest', { enumerable: true, get()
        {
            throw new Error('must not execute');
        } });
    }],
    ['plan byte drift', (value) =>
    {
        value.plan.browserVersion = 'changed';
    }],
    ['actual byte drift', (value) =>
    {
        value.actual.browserVersion = 'changed';
    }],
    ['actual plan mismatch', (value) =>
    {
        value.actual.planDigest = `sha256:${'2'.repeat(64)}`;
    }],
    ['missing rendering observation', (value) =>
    {
        delete value.actual.renderingObservation;
    }],
    ['invalid rendering observation', (value) =>
    {
        value.actual.renderingObservation.locale = 'foreign';
    }]
])
{
    test(`root identity mapping rejects ${name}`, () =>
    {
        const original = rootBindingModel();
        const changed = mutate(original);
        const binding = changed === undefined ? original : changed;
        assert.throws(() => derivePublicShellLocaleRootIdentity(matrix, binding), /root binding/u);
    });
}

for (const [name, mutate] of [
    ['actual plan mismatch', (value) =>
    {
        value.actual.planDigest = `sha256:${'2'.repeat(64)}`;
    }],
    ['planned versus actual executable', (value) =>
    {
        value.actual.executableSha256 = `sha256:${'2'.repeat(64)}`;
    }],
    ['rendering observation mismatch', (value) =>
    {
        value.actual.renderingObservation.locale = 'foreign';
    }],
    ['diagnostic browser classification', (value) =>
    {
        value.plan.evidenceClass = 'diagnostic';
        value.actual.evidenceClass = 'diagnostic';
    }],
    ['coercible browser version', (value) =>
    {
        value.plan.browserVersion = {};
        value.actual.browserVersion = {};
    }]
])
{
    test(`root identity mapping rejects rehashed ${name}`, () =>
    {
        const binding = rootBindingModel();
        mutate(binding);
        delete binding.plan.contentDigest;
        binding.plan.contentDigest = `sha256:${gateDigest(binding.plan)}`;
        delete binding.actual.contentDigest;
        binding.actual.contentDigest = `sha256:${gateDigest(binding.actual)}`;
        assert.throws(() => derivePublicShellLocaleRootIdentity(matrix, binding), /root binding/u);
    });
}

// Independent contract-model expectations from the issue/stage boundaries.
// These fixtures exercise admission only; they do not establish browser qualification.
const evidenceFields = ['network', 'commitGenerations', 'geometry', 'preference', 'failureRecovery'];

test('caller Root slice rejects a missing expected identity instead of adopting the first result (Node model)', () =>
{
    const binding = rootBindingModel();
    const scene = matrix.scenes[0];
    const focusedMatrix = { ...matrix, scenes: [scene] };
    const identity = derivePublicShellLocaleRootIdentity(focusedMatrix, binding);
    assert.throws(() => validatePublicShellLocaleSubResults({
        matrix: focusedMatrix, results: [resultFor(scene, identity)], buildDigest: binding.buildDigest
    }), /caller.*identity/u);
});

test('caller Root slice rejects uniformly forged IDs even after every result is rehashed (Node model)', () =>
{
    const binding = rootBindingModel();
    const scenes = matrix.scenes.slice(0, 2);
    const focusedMatrix = { ...matrix, scenes };
    const identity = derivePublicShellLocaleRootIdentity(focusedMatrix, binding);
    const results = scenes.map(scene => resultFor(scene, identity));
    for (const result of results)
    {
        result.identity = { ...identity, runtimeId: 'forged-runtime', fixtureId: 'forged-fixture', browserId: 'forged-browser' };
        delete result.contentDigest;
        result.contentDigest = gateDigest(result);
    }
    assert.throws(() => validatePublicShellLocaleSubResults({
        matrix: focusedMatrix, results, buildDigest: binding.buildDigest, identity
    }), error => error.code === 'cross-run-identity' && error.message.includes('identity.runtimeId'));
});

test('caller Root slice keeps explicit-identity summary admission non-qualifying (Node model)', () =>
{
    const binding = rootBindingModel();
    const scene = matrix.scenes[0];
    const focusedMatrix = { ...matrix, scenes: [scene] };
    const identity = derivePublicShellLocaleRootIdentity(focusedMatrix, binding);
    const result = validatePublicShellLocaleSubResults({
        matrix: focusedMatrix, results: [resultFor(scene, identity)], buildDigest: binding.buildDigest, identity
    });
    assert.deepEqual(result.identity, identity);
    assert.equal(Object.hasOwn(result, 'qualificationEligible'), false);
});

test('caller Root slice cannot replace an explicit Root ref with a submitted model identity (Node model)', async () =>
{
    const binding = rootBindingModel();
    await assert.rejects(() => readPublicShellLocaleCallerRoot({
        root, matrix, buildDigest: binding.buildDigest, callerOwner: {
            identity: binding.identity, preparation: binding.preparation, sourceState: binding.sourceState,
            buildDigest: binding.buildDigest, fixtureRoot: binding.resources.fixtureRoot, resources: binding.resources
        }
    }), /caller Root ref/u);
});

function callerRootRefModel(t)
{
    const runDirectory = path.join(root, '.tmp/browser-contract/runs');
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const owned = fs.mkdtempSync(path.join(runDirectory, 'node-root-reader-model-'));
    t.after(() => fs.rmSync(owned, { recursive: true, force: true }));
    const binding = rootBindingModel();
    binding.identity.namespace = path.basename(owned);
    const prefix = `.tmp/browser-contract/runs/${binding.identity.namespace}/bindings/${binding.preparation.id}/`;
    const refs = binding.refs.map(ref =>
    {
        const file = path.join(root, prefix, `${ref.role}.json`);
        const body = ref.role === 'browser-plan' ? binding.plan : ref.role === 'browser-actual' ? binding.actual
            : { evidenceKind: 'node-contract-model', role: ref.role };
        const bytes = Buffer.from(JSON.stringify(body) + '\n');
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        return { role: ref.role, path: path.relative(root, file).replaceAll(path.sep, '/'),
            digest: createHash('sha256').update(bytes).digest('hex') };
    });
    binding.refs = refs;
    const file = path.join(root, prefix, 'root-binding.json');
    const bytes = Buffer.from(JSON.stringify(binding) + '\n');
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const options = {
        root, matrix, buildDigest: binding.buildDigest,
        callerRootRef: { artifact: path.relative(root, file).replaceAll(path.sep, '/'),
            digest: createHash('sha256').update(bytes).digest('hex') },
        callerOwner: {
            identity: binding.identity, preparation: binding.preparation, sourceState: binding.sourceState,
            buildDigest: binding.buildDigest, fixtureRoot: binding.resources.fixtureRoot, resources: binding.resources
        },
        fixtureProviderFile: 'tests/browser-contract/default-fixture-provider.mjs'
    };
    return { file, binding, options };
}

for (const [name, mutate, pattern] of [
    ['missing current owner', value => value.options.callerOwner = null, /current owner/u],
    ['foreign preparation', value => value.options.callerOwner = { ...value.options.callerOwner,
        preparation: { ...value.binding.preparation, id: '9f37a062-ab9b-41b8-b775-69bc3fa89f81' } }, /current preparation/u],
    ['Root byte tamper', value => fs.appendFileSync(value.file, 'tampered'), /ref digest mismatch/u],
    ['Root path alias', value => value.options.callerRootRef.artifact = `./${value.options.callerRootRef.artifact}`, /current preparation/u],
    ['original byte tamper', value => fs.appendFileSync(path.join(root, value.binding.refs[3].path), 'tampered'), /ref digest mismatch/u],
    ['public original', value => fs.chmodSync(path.join(root, value.binding.refs[0].path), 0o644), /private/u],
    ['original symlink', value =>
    {
        const file = path.join(root, value.binding.refs[0].path);
        fs.renameSync(file, `${file}.saved`);
        fs.symlinkSync(`${file}.saved`, file);
    }, /symlink/u],
    ['unsupported configured provider', value => value.options.fixtureProviderFile = 'tests/browser-contract/fixture.mjs', /supported snapshot validator/u]
])
{
    test(`caller Root slice rejects ${name} before treating model originals as authority`, async t =>
    {
        const value = callerRootRefModel(t);
        mutate(value);
        await assert.rejects(() => readPublicShellLocaleCallerRoot(value.options), pattern);
    });
}

test('caller Root slice cannot convert admission or byte-only integrity into native qualification', () =>
{
    assert.throws(() => requirePublicShellLocaleCausalVerification(), error => error.code === 'native-causal-not-observed');
});
const stageContracts = [
    { issue: 2083, stages: ['first-response'], required: [] },
    { issue: 2084, stages: ['first-html', 'hydration-start', 'interactive-ready', 'selector-open'], required: ['geometry'] },
    { issue: 2085, stages: ['initial-network'], required: ['network'] },
    { issue: 2086, stages: ['preparing', 'commit', 'post-commit', 'spa-navigation', 'refresh', 'back-forward', 'latest-wins'],
        required: ['network', 'commitGenerations', 'geometry', 'preference'] },
    { issue: 2087, stages: ['domain-failure', 'font-failure', 'preference-failure', 'revision-conflict', 'artifact-invalid', 'superseded-failure', 'retry'],
        required: evidenceFields }
];

function notApplicable()
{
    return { applicable: false, reason: 'not-required-by-canonical-scene' };
}

function rawRefFixture(t)
{
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-locale-raw-ref-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const refPath = '.tmp/browser-contract/runs/owned-node-model/scene.json';
    const file = path.join(directory, refPath);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from('{"evidenceKind":"node-contract-model"}\n');
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const results = [{ scene: { id: 'node-model-scene' }, refs: [{
        path: refPath, digest: createHash('sha256').update(bytes).digest('hex')
    }] }];
    return { directory, file, bytes, results };
}

test('raw ref integrity reopens private bytes without creating browser qualification', (t) =>
{
    const value = rawRefFixture(t);
    const verified = verifyPublicShellLocaleRawRefs({ root: value.directory, results: value.results });
    assert.equal(verified.artifactCount, 1);
    assert.equal(verified.runDirectory, '.tmp/browser-contract/runs/owned-node-model');
    assert.equal(Object.hasOwn(verified, 'qualificationEligible'), false);
    value.results[0].refs[0].digest = `sha256:${value.results[0].refs[0].digest}`;
    assert.equal(verifyPublicShellLocaleRawRefs({ root: value.directory, results: value.results }).artifactCount, 1);
});

for (const [name, mutate, expected] of [
    ['missing file', (value) => fs.unlinkSync(value.file), /unreadable/u],
    ['changed raw bytes', (value) => fs.appendFileSync(value.file, 'tampered'), /digest mismatch/u],
    ['incorrect digest', (value) => value.results[0].refs[0].digest = '0'.repeat(64), /digest mismatch/u],
    ['public permissions', (value) => fs.chmodSync(value.file, 0o644), /private/u],
    ['regular directory', (value) =>
    {
        fs.unlinkSync(value.file);
        fs.mkdirSync(value.file);
    }, /regular file/u],
    ['final symlink', (value) =>
    {
        fs.renameSync(value.file, `${value.file}.saved`);
        fs.symlinkSync(`${value.file}.saved`, value.file);
    }, /symlink/u],
    ['parent symlink', (value) =>
    {
        const parent = path.dirname(value.file);
        fs.renameSync(parent, `${parent}.saved`);
        fs.symlinkSync(`${parent}.saved`, parent);
    }, /symlink/u],
    ['outside run owner', (value) => value.results[0].refs[0].path = '.tmp/other/scene.json', /owned run/u],
    ['parent traversal', (value) => value.results[0].refs[0].path = '.tmp/browser-contract/runs/owned-node-model/../scene.json', /canonical/u],
    ['absolute path', (value) => value.results[0].refs[0].path = value.file, /canonical/u],
    ['backslash alias', (value) => value.results[0].refs[0].path = value.results[0].refs[0].path.replaceAll('/', '\\'), /canonical/u],
    ['duplicate artifact', (value) => value.results.push(structuredClone(value.results[0])), /duplicate raw/u],
    ['cross-run artifact', (value) => value.results.push({ scene: { id: 'other-scene' }, refs: [{
        path: '.tmp/browser-contract/runs/other-run/scene.json', digest: value.results[0].refs[0].digest
    }] }), /cross-run/u]
])
{
    test(`raw ref integrity rejects ${name}`, (t) =>
    {
        const value = rawRefFixture(t);
        mutate(value);
        assert.throws(() => verifyPublicShellLocaleRawRefs({ root: value.directory, results: value.results }), expected);
    });
}

const toolchain = {
    node: process.version,
    npm: 'local-fixture',
    dotnet: 'local-fixture',
    vite: 'local-fixture',
    vitest: 'local-fixture',
    playwright: 'local-fixture',
    emsdk: 'local-fixture'
};

function fixture(t)
{
    const workspace = fs.mkdtempSync(path.join(root, '.tmp/public-shell-locale-aggregate-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const artifactRoot = path.join(workspace, 'build');
    const domains = ['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm'];
    for (const domain of domains)
    {
        fs.mkdirSync(path.join(artifactRoot, domain), { recursive: true });
        fs.writeFileSync(path.join(artifactRoot, domain, 'manifest.txt'), `${domain}\n`);
    }
    const buildReceipt = createProductionBuildReceipt({
        root,
        artifactRoot,
        sourceState: {
            commit: matrix.identity.sourceCommit,
            worktreeFingerprint: matrix.identity.worktreeFingerprint
        },
        producer: {
            workflow: 'local PublicShell locale aggregate fixture',
            runId: `public-shell-locale-${process.pid}`,
            runAttempt: 1,
            job: 'public-shell-locale-aggregate'
        },
        toolchain,
        inputPaths: ['tests/browser-contract/public-shell-locale-matrix.mjs'],
        domains: domains.map((name) => ({ name, path: name })),
        build: {
            profile: 'local-public-shell-locale-contract',
            command: 'node --test tests/tools/public-shell-locale-aggregate.test.mjs'
        }
    });
    const inputFile = path.join(workspace, 'sub-results.json');
    const outputFile = path.join(workspace, 'qualification.json');
    const runsRoot = path.join(root, '.tmp/browser-contract/runs');
    fs.mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
    const rawRoot = fs.mkdtempSync(path.join(runsRoot, 'node-aggregate-model-'));
    t.after(() => fs.rmSync(rawRoot, { recursive: true, force: true }));
    return { workspace, artifactRoot, buildReceipt, inputFile, outputFile, rawRoot };
}

function buildSealSnapshot(value)
{
    return ['receipt.json', ...value.buildReceipt.artifacts.map(artifact => artifact.path)].map(relative =>
    {
        const file = path.join(value.artifactRoot, relative);
        return { path: relative, mode: fs.statSync(file).mode & 0o777, bytes: fs.readFileSync(file) };
    });
}

for (const [name, writable] of [
    ['receipt', ['receipt.json']],
    ['artifact', ['backend-runtime/manifest.txt']],
    ['receipt and artifact', ['receipt.json', 'backend-runtime/manifest.txt']]
])
{
    test(`read-only build admission rejects a writable ${name} without changing input modes or bytes`, t =>
    {
        const value = fixture(t);
        for (const relative of writable)
        {
            fs.chmodSync(path.join(value.artifactRoot, relative), 0o644);
        }
        const before = buildSealSnapshot(value);
        const gate = { matrix, receiptFile: path.join(value.artifactRoot, 'receipt.json'),
            config: JSON.parse(fs.readFileSync(path.join(root, 'config/testing/public-shell-locale-gate.json'), 'utf8')) };
        let rejection;
        try
        {
            verifyPublicShellLocaleBuild(gate);
        }
        catch (error)
        {
            rejection = error;
        }
        assert.deepEqual(buildSealSnapshot(value), before, 'read-only admission must not repair or rewrite any input');
        assert.match(rejection?.message ?? '', /read-only seal is missing/u, 'a writable seal must be rejected');
    });
}

test('read-only build admission accepts the original producer seal without changing input modes or bytes', t =>
{
    const value = fixture(t);
    const before = buildSealSnapshot(value);
    assert.ok(before.every(file => (file.mode & 0o222) === 0), 'original producer must establish every input seal');
    const gate = { matrix, receiptFile: path.join(value.artifactRoot, 'receipt.json'),
        config: JSON.parse(fs.readFileSync(path.join(root, 'config/testing/public-shell-locale-gate.json'), 'utf8')) };
    const admitted = verifyPublicShellLocaleBuild(gate);
    assert.equal(admitted.digest, value.buildReceipt.contentDigest);
    assert.deepEqual(buildSealSnapshot(value), before);
});

function resultFor(scene, identity)
{
    const body = {
        schema: publicShellLocaleSubResultSchema,
        status: 'passed',
        evidenceKind: 'browser-contract',
        qualificationEligible: true,
        browserSpawnCount: 0,
        subMatrixSpawnCount: 0,
        scene: structuredClone(scene),
        observed: {
            locale: scene.locale,
            uiLocale: scene.transition?.expectedUiLocale ?? scene.locale,
            source: scene.source,
            route: scene.route,
            stage: scene.stage,
            copyKeys: structuredClone(scene.expectedKeys),
            requiredDomains: [...scene.requiredDomains],
            fontFaceIds: [...scene.requiredFont.faceIds],
            selectorLocales: matrix.locales.map((locale) => locale.code),
            network: {
                checked: true,
                domainSet: [...scene.requiredDomains],
                fontSet: [...scene.requiredFont.faceIds],
                localeSet: [...scene.networkPolicy.localeSet],
                includeCacheAndPreload: scene.networkPolicy.includeCacheAndPreload,
                businessDataReRequests: scene.networkPolicy.businessDataReRequests,
                requestCounts: {
                    document: 1,
                    localeArtifacts: scene.requiredDomains.length,
                    fonts: scene.requiredFont.faceIds.length,
                    total: 1 + scene.requiredDomains.length + scene.requiredFont.faceIds.length
                }
            },
            commitGenerations: {
                sameRun: true,
                document: 1,
                locale: 1,
                font: 1,
                preference: 1
            },
            geometry: {
                inspected: true,
                ref: scene.geometryRef,
                viewport: structuredClone(scene.viewport),
                layoutStable: true
            },
            preference: {
                checked: true,
                persistenceChecked: true,
                state: 'current-run-fixture'
            },
            failureRecovery: {
                checked: true,
                recoveryObserved: true,
                state: scene.transition?.failureMode ?? 'normal'
            },
            consoleErrors: [],
            warnings: [],
            notObserved: [],
            issues: []
        },
        identity: structuredClone(identity),
        refs: [{
            path: `local-fixture/${scene.id}.json`,
            digest: gateDigest({ sceneId: scene.id, evidenceId: scene.evidenceId })
        }]
    };
    const contract = stageContracts.find((item) => item.issue === scene.issue);
    for (const field of evidenceFields)
    {
        if (!contract.required.includes(field))
        {
            body.observed[field] = notApplicable();
        }
    }
    return { ...body, contentDigest: gateDigest(body) };
}

function validateSceneModel(scene, mutate = null)
{
    const focusedMatrix = { ...matrix, scenes: [scene] };
    const buildDigest = gateDigest({ scope: 'stage-applicability-node-contract-model' });
    const identity = publicShellLocaleIdentity(focusedMatrix, buildDigest, {
        runtimeId: 'node-contract-model-runtime',
        fixtureId: 'node-contract-model-fixture',
        browserId: 'no-browser-node-contract-model'
    });
    const result = resultFor(scene, identity);
    mutate?.(result);
    delete result.contentDigest;
    result.contentDigest = gateDigest(result);
    return validatePublicShellLocaleSubResults({ matrix: focusedMatrix, results: [result], buildDigest, identity });
}

for (const contract of stageContracts)
{
    for (const stage of contract.stages)
    {
        test(`stage applicability accepts exact canonical ${contract.issue}/${stage} contract-model shape`, () =>
        {
            const scene = matrix.scenes.find((item) => item.issue === contract.issue && item.stage === stage);
            assert.ok(scene, 'stage must exist in the unchanged canonical matrix');
            assert.deepEqual(publicShellLocaleStageApplicability(scene),
                Object.fromEntries(evidenceFields.map((field) => [field, contract.required.includes(field)])));
            assert.equal(validateSceneModel(scene).orderedResults.length, 1);
        });
    }
}

const requiredScene = matrix.scenes.find((scene) => scene.issue === 2087 && scene.stage === 'domain-failure');
const requiredErrorCodes = {
    network: ['unsupported-network-field', 'network-not-observed'],
    commitGenerations: ['unsupported-generation-field', 'generation-not-observed'],
    geometry: ['unsupported-geometry-field', 'geometry-not-observed'],
    preference: ['unsupported-preference-field', 'preference-not-observed'],
    failureRecovery: ['unsupported-failure-field', 'failure-recovery-not-observed']
};
for (const field of evidenceFields)
{
    for (const [label, mutate, expectedCode] of [
        ['missing applicable evidence', (result) => delete result.observed[field], 'unsupported-observation'],
        ['producer claimed N/A on required evidence', (result) => result.observed[field] = notApplicable(), requiredErrorCodes[field][0]],
        ['false checked substitute', (result) => result.observed[field][field === 'commitGenerations' ? 'sameRun' : field === 'geometry' ? 'inspected' : 'checked'] = false, requiredErrorCodes[field][1]],
        ['zero checked substitute', (result) => result.observed[field][field === 'commitGenerations' ? 'sameRun' : field === 'geometry' ? 'inspected' : 'checked'] = 0, requiredErrorCodes[field][1]]
    ])
    {
        test(`stage applicability rejects ${field}: ${label}`, () =>
        {
            assert.throws(() => validateSceneModel(requiredScene, mutate), (error) => error.code === expectedCode);
        });
    }
}

const firstResponseScene = matrix.scenes.find((scene) => scene.issue === 2083);
for (const field of evidenceFields)
{
    for (const [label, value] of [
        ['missing N/A marker', undefined],
        ['false as N/A', false],
        ['zero as N/A', 0],
        ['checked claim as N/A', { checked: true }],
        ['unchecked claim as N/A', { checked: false }],
        ['N/A with hidden numeric generation', { ...notApplicable(), document: 0 }],
        ['unregistered N/A reason', { applicable: false, reason: 'producer-opt-out' }]
    ])
    {
        test(`stage applicability rejects first-response ${field}: ${label}`, () =>
        {
            assert.throws(() => validateSceneModel(firstResponseScene, (result) => result.observed[field] = value),
                (error) => error.code === 'non-applicable-evidence');
        });
    }
}

test('stage applicability rejects unsupported stage and wrong issue/stage pair', () =>
{
    for (const stage of ['unregistered-stage', 'initial-network'])
    {
        assert.throws(() => validateSceneModel({ ...firstResponseScene, stage }),
            (error) => error.code === 'unsupported-stage');
    }
});

test('stage applicability registers every current matrix issue/stage and no unsupported issue', () =>
{
    const registered = stageContracts.flatMap((contract) => contract.stages.map((stage) => `${contract.issue}/${stage}`)).sort();
    const actual = [...new Set(matrix.scenes.map((scene) => `${scene.issue}/${scene.stage}`))].sort();
    assert.deepEqual(registered, actual);
    assert.throws(() => publicShellLocaleStageApplicability({ ...firstResponseScene, issue: 9999 }),
        (error) => error.code === 'unsupported-stage');
});

for (const [field, checkedField, code] of [
    ['preference', 'persistenceChecked', 'preference-not-observed'],
    ['failureRecovery', 'recoveryObserved', 'failure-recovery-not-observed']
])
{
    for (const value of [false, 0])
    {
        test(`stage applicability rejects ${field}.${checkedField}=${value} on required scene`, () =>
        {
            assert.throws(() => validateSceneModel(requiredScene, (result) => result.observed[field][checkedField] = value),
                (error) => error.code === code);
        });
    }
}

function createResults(buildDigest, rawRoot)
{
    const identity = publicShellLocaleIdentity(matrix, buildDigest, {
        runtimeId: 'local-public-shell-runtime',
        fixtureId: 'local-public-shell-fixture',
        browserId: 'no-browser-local-contract-fixture'
    });
    return matrix.scenes.map((scene, index) =>
    {
        const result = resultFor(scene, identity);
        // These are contract-model bytes, not browser/DOM/runtime observations.
        const bytes = Buffer.from(JSON.stringify({ evidenceKind: 'node-contract-model', sceneId: scene.id, identity }));
        const file = path.join(rawRoot, `scene-${index}.json`);
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        result.refs = [{ path: path.relative(root, file).replaceAll(path.sep, '/'),
            digest: createHash('sha256').update(bytes).digest('hex') }];
        delete result.contentDigest;
        result.contentDigest = gateDigest(result);
        return result;
    });
}

function writeInput(file, results, extra = {})
{
    fs.writeFileSync(file, `${JSON.stringify({
        schema: 'fsusblog.public-shell-locale-sub-results.v1',
        ...extra,
        results
    }, null, 2)}\n`);
}

function writeReceipt(file, receipt)
{
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

/** Pure serialization/summary model, never the qualifying aggregate entry point. */
async function projectContractModelReceipt(value, results)
{
    const gate = await loadPublicShellLocaleGate({ root, buildReceiptFile: path.join(value.artifactRoot, 'receipt.json') });
    const build = verifyPublicShellLocaleBuild(gate);
    const identity = publicShellLocaleIdentity(gate.matrix, build.digest, {
        runtimeId: 'local-public-shell-runtime', fixtureId: 'local-public-shell-fixture', browserId: 'no-browser-local-contract-fixture'
    });
    const validated = validatePublicShellLocaleSubResults({ matrix: gate.matrix, results, buildDigest: build.digest, identity });
    verifyPublicShellLocaleRawRefs({ root, results: validated.orderedResults });
    const input = JSON.parse(fs.readFileSync(value.inputFile, 'utf8'));
    return createPublicShellLocaleQualification({
        gate, build, inputPath: value.inputFile,
        inputDigest: gateDigest({ ...input, results: validated.orderedResults }),
        identity, results: validated.orderedResults, verifierCommand: gate.config.commands.verify
    });
}

test('pure ten-locale receipt projection preserves counters but model bytes cannot qualify', async (t) =>
{
    const value = fixture(t);
    const results = createResults(value.buildReceipt.contentDigest, value.rawRoot);
    writeInput(value.inputFile, results, { producer: 'local-sub-result-fixture' });
    const receipt = await projectContractModelReceipt(value, results);
    assert.equal(receipt.schema, 'fsusblog.public-shell-locale-qualification.v1');
    assert.equal(receipt.status, 'success');
    assert.equal(receipt.qualificationEligible, true);
    assert.equal(receipt.producer.browserSpawnCount, 0);
    assert.equal(receipt.verifier.browserSpawnCount, 0);
    assert.equal(receipt.matrix.sceneCount, 8208);
    assert.equal(receipt.coverage.locales.length, 10);
    assert.equal(receipt.scenes.length, 8208);
    writeReceipt(value.outputFile, receipt);
    const verified = await verifyPublicShellLocaleQualification({
        root,
        receiptFile: value.outputFile,
        inputFile: value.inputFile,
        buildReceiptFile: path.join(value.artifactRoot, 'receipt.json')
    });
    assert.equal(verified.ok, false);
    assert.ok(verified.errors.some(error => error.includes('caller Root ref')));
    await assert.rejects(() => aggregatePublicShellLocale({
        root, inputFile: value.inputFile, outputFile: value.outputFile,
        buildReceiptFile: path.join(value.artifactRoot, 'receipt.json')
    }), /caller Root ref/u);
    assert.equal(JSON.parse(fs.readFileSync(value.outputFile, 'utf8')).qualificationEligible, false);
});

test('aggregate required-set and identity mutations fail closed', async (t) =>
{
    const value = fixture(t);
    const results = createResults(value.buildReceipt.contentDigest, value.rawRoot);
    const gate = await loadPublicShellLocaleGate({ root, buildReceiptFile: path.join(value.artifactRoot, 'receipt.json') });
    const identity = publicShellLocaleIdentity(matrix, value.buildReceipt.contentDigest, {
        runtimeId: 'local-public-shell-runtime', fixtureId: 'local-public-shell-fixture', browserId: 'no-browser-local-contract-fixture'
    });
    const positive = validatePublicShellLocaleSubResults({ matrix, results, buildDigest: value.buildReceipt.contentDigest, identity });
    assert.equal(positive.orderedResults.length, matrix.scenes.length);
    const rejectMutation = (label, mutate) =>
    {
        const candidate = structuredClone(results);
        mutate(candidate);
        assert.throws(
            () => validatePublicShellLocaleSubResults({ matrix, results: candidate, buildDigest: value.buildReceipt.contentDigest, identity }),
            /does not match|missing|duplicate|extra|diagnostic|crosses|not observed|not checked|spawning|mismatch|unregistered/u,
            label
        );
    };
    rejectMutation('missing scene', (candidate) => candidate.pop());
    rejectMutation('extra scene', (candidate) =>
    {
        const extra = structuredClone(candidate[0]);
        extra.scene.id = '2083/extra-scene';
        candidate.push(extra);
    });
    rejectMutation('duplicate scene', (candidate) => candidate.push(structuredClone(candidate[0])));
    rejectMutation('cross-build identity', (candidate) =>
    {
        candidate[0].identity.buildDigest = 'sha256:' + '0'.repeat(64);
        delete candidate[0].contentDigest;
        candidate[0].contentDigest = gateDigest(candidate[0]);
    });
    rejectMutation('diagnostic sub-result', (candidate) =>
    {
        candidate[0].qualificationEligible = false;
        delete candidate[0].contentDigest;
        candidate[0].contentDigest = gateDigest(candidate[0]);
    });
    rejectMutation('network not checked', (candidate) =>
    {
        const networkResult = candidate.find((result) => result.scene.issue === 2085);
        networkResult.observed.network.checked = false;
        delete networkResult.contentDigest;
        networkResult.contentDigest = gateDigest(networkResult);
    });
    rejectMutation('target locale missing', (candidate) =>
    {
        candidate[0].observed.copyKeys = [];
        delete candidate[0].contentDigest;
        candidate[0].contentDigest = gateDigest(candidate[0]);
    });
    rejectMutation('browser spawn mutation', (candidate) =>
    {
        candidate[0].browserSpawnCount = 1;
        delete candidate[0].contentDigest;
        candidate[0].contentDigest = gateDigest(candidate[0]);
    });
    rejectMutation('screenshot-only authority', (candidate) =>
    {
        candidate[0].observed.screenshot = { digest: '0'.repeat(64) };
        delete candidate[0].contentDigest;
        candidate[0].contentDigest = gateDigest(candidate[0]);
    });
    assert.equal(gate.matrix.scenes.length, 8208);
});

test('terminal receipt, input, refs and digest tampering fail independent verification', async (t) =>
{
    const value = fixture(t);
    const results = createResults(value.buildReceipt.contentDigest, value.rawRoot);
    writeInput(value.inputFile, results);
    writeReceipt(value.outputFile, await projectContractModelReceipt(value, results));
    const originalReceipt = JSON.parse(fs.readFileSync(value.outputFile, 'utf8'));
    const originalInput = JSON.parse(fs.readFileSync(value.inputFile, 'utf8'));
    const wrongSchemaInput = { ...originalInput, schema: 'unregistered-sub-results' };
    writeReceipt(value.inputFile, wrongSchemaInput);
    const wrongSchemaReceipt = structuredClone(originalReceipt);
    wrongSchemaReceipt.input.digest = gateDigest(wrongSchemaInput);
    delete wrongSchemaReceipt.contentDigest;
    wrongSchemaReceipt.contentDigest = gateDigest(wrongSchemaReceipt);
    writeReceipt(value.outputFile, wrongSchemaReceipt);
    const schemaTamper = await verifyPublicShellLocaleQualification({
        root, receiptFile: value.outputFile, inputFile: value.inputFile,
        buildReceiptFile: path.join(value.artifactRoot, 'receipt.json')
    });
    assert.equal(schemaTamper.ok, false);
    assert.ok(schemaTamper.errors.includes('qualification receipt input schema mismatch'));
    writeReceipt(value.inputFile, originalInput);
    writeReceipt(value.outputFile, originalReceipt);
    const rawFile = path.join(root, results[0].refs[0].path);
    const rawBytes = fs.readFileSync(rawFile);
    fs.appendFileSync(rawFile, '\nraw-byte-tamper');
    const rawTamper = await verifyPublicShellLocaleQualification({
        root, receiptFile: value.outputFile, inputFile: value.inputFile,
        buildReceiptFile: path.join(value.artifactRoot, 'receipt.json')
    });
    assert.equal(rawTamper.ok, false);
    assert.ok(rawTamper.errors.some((error) => error.includes('raw ref digest mismatch')));
    fs.writeFileSync(rawFile, rawBytes);
    const expectVerifierFailure = async (label, mutate) =>
    {
        const candidate = structuredClone(originalReceipt);
        mutate(candidate);
        writeReceipt(value.outputFile, candidate);
        const result = await verifyPublicShellLocaleQualification({
            root,
            receiptFile: value.outputFile,
            inputFile: value.inputFile,
            buildReceiptFile: path.join(value.artifactRoot, 'receipt.json')
        });
        assert.equal(result.ok, false, label);
        assert.ok(result.errors.length > 0, label);
    };
    await expectVerifierFailure('receipt digest tamper', (candidate) =>
    {
        candidate.contentDigest = '0'.repeat(64);
    });
    await expectVerifierFailure('referenced scene missing with correct aggregate count', (candidate) =>
    {
        candidate.scenes.pop();
        candidate.contentDigest = gateDigest(Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'contentDigest')));
    });
    await expectVerifierFailure('aggregate browser spawn tamper', (candidate) =>
    {
        candidate.producer.browserSpawnCount = 1;
        candidate.contentDigest = gateDigest(Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'contentDigest')));
    });
    await expectVerifierFailure('identity tamper', (candidate) =>
    {
        candidate.identity.fixtureId = 'cross-run-fixture';
        candidate.contentDigest = gateDigest(Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'contentDigest')));
    });
    await expectVerifierFailure('input tamper', () =>
    {
        const changed = JSON.parse(fs.readFileSync(value.inputFile, 'utf8'));
        changed.results[0].observed.copyKeys = [];
        fs.writeFileSync(value.inputFile, `${JSON.stringify(changed, null, 2)}\n`);
    });
});

test('sub-result order does not affect pure model receipt projection', async (t) =>
{
    const value = fixture(t);
    const results = createResults(value.buildReceipt.contentDigest, value.rawRoot);
    writeInput(value.inputFile, results);
    const first = await projectContractModelReceipt(value, results);
    writeInput(value.inputFile, [...results].reverse());
    const second = await projectContractModelReceipt(value, [...results].reverse());
    assert.equal(first.contentDigest, second.contentDigest);
    assert.deepEqual(first.scenes, second.scenes);
});

test('aggregate rejects missing raw bytes before writing a successful receipt', async (t) =>
{
    const value = fixture(t);
    const results = createResults(value.buildReceipt.contentDigest, value.rawRoot);
    writeInput(value.inputFile, results);
    fs.unlinkSync(path.join(root, results[0].refs[0].path));
    await assert.rejects(() => aggregatePublicShellLocale({
        root, inputFile: value.inputFile, outputFile: value.outputFile,
        buildReceiptFile: path.join(value.artifactRoot, 'receipt.json')
    }), /raw ref is unreadable/u);
    const receipt = JSON.parse(fs.readFileSync(value.outputFile, 'utf8'));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.qualificationEligible, false);
    assert.ok(receipt.firstFailure.message.includes('raw ref is unreadable'));
});

test('production build identity rejects a stale receipt before aggregation', async () =>
{
    const staleReceipt = path.join(root, '.tmp/i18n-production-build-window-20260905-01/receipt.json');
    if (!fs.existsSync(staleReceipt))
    {
        return;
    }
    assert.throws(
        () => verifyProductionBuildReceipt({
            artifactRoot: path.dirname(staleReceipt),
            receiptFile: path.basename(staleReceipt),
            expectedSourceState: matrix.identity
        }),
        /commit SHA mismatch|worktree fingerprint mismatch/u
    );
});
