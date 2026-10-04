import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {buildBoundedQueueAcceptanceReceipt, defaultCatalogPath, deliveryCatalogDigest, discoverBoundedChannels, discoverUnboundedChannels, queueDispositionReport, validateBoundedChannelCatalog, verifyBoundedQueueAcceptanceReceipt, warningOnlyMutation, warningMutationParent, validateWarningMutationTrx, validateWarningMutationIdentity, validateWarningMutationReady, validateWarningMutationTerminal, validateWarningMutationDllParity} = await import(new URL('../../tools/governance/bounded-channel-contracts.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let discoveredCatalogQueues = null;

function gitFixtureObject(type, bytes)
{
    return crypto.createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
}

function parentFixture()
{
    const blob = gitFixtureObject('blob', Buffer.from('fixture'));
    const tree = gitFixtureObject('tree', Buffer.concat([Buffer.from('100644 source.cs\0'), Buffer.from(blob, 'hex')]));
    const commit = Buffer.from(`tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nfixture\n`);
    return { commit, index: Buffer.from(`100644 blob ${blob}\tsource.cs\0`), sha: gitFixtureObject('commit', commit), tree };
}

function oracleTrx(variant)
{
    const method = warningOnlyMutation.oracle.split('.').at(-1);
    const className = warningOnlyMutation.oracle.slice(0, -(method.length + 1));
    const failed = variant === 'mutant';
    return `<TestRun><Results><UnitTestResult testId="oracle" testName="${warningOnlyMutation.oracle}" outcome="${failed ? 'Failed' : 'Passed'}">${failed ? `<Output><ErrorInfo><Message>Assert.Throws() Failure: No exception was thrown. Expected: System.IO.IOException</Message><StackTrace>${warningOnlyMutation.oracle}()</StackTrace></ErrorInfo></Output>` : ''}</UnitTestResult></Results><TestDefinitions><UnitTest id="oracle"><TestMethod className="${className}" name="${method}" /></UnitTest></TestDefinitions><ResultSummary><Counters total="1" executed="1" passed="${failed ? 0 : 1}" failed="${failed ? 1 : 0}" notExecuted="0" error="0" timeout="0" aborted="0" notRunnable="0" disconnected="0" /></ResultSummary></TestRun>`;
}

test('physical proof validates the full parent index against the immutable Git object', () =>
{
    const value = parentFixture();
    assert.equal(warningMutationParent(value.commit, value.index, value.sha).tree, value.tree);
    assert.throws(() => warningMutationParent(value.commit, value.index, '0'.repeat(40)), /commit object mismatch/u);
    assert.throws(() => warningMutationParent(value.commit, Buffer.alloc(0), value.sha), /index\/tree mismatch/u);
    assert.throws(() => warningMutationParent(value.commit, Buffer.concat([value.index, value.index]), value.sha), /duplicate/u);
    assert.throws(() => warningMutationParent(value.commit, Buffer.from(value.index.toString().replace('source.cs', '../source.cs')), value.sha), /unsafe/u);
});

test('physical proof requires the unchanged exact oracle to pass baseline and kill mutant', () =>
{
    assert.equal(validateWarningMutationTrx(oracleTrx('baseline'), 'baseline').passed, 1);
    assert.equal(validateWarningMutationTrx(oracleTrx('mutant'), 'mutant').failed, 1);
    assert.throws(() => validateWarningMutationTrx(oracleTrx('baseline'), 'mutant'), /required result/u);
    assert.throws(() => validateWarningMutationTrx(oracleTrx('mutant'), 'baseline'), /required result/u);
});

test('physical proof rejects infrastructure errors, unrelated assertions, skip and another test', () =>
{
    const trx = oracleTrx('mutant');
    assert.throws(() => validateWarningMutationTrx(trx.replace('Assert.Throws() Failure: No exception was thrown', 'Assert.Equal() Failure'), 'mutant'), /different reason/u);
    assert.throws(() => validateWarningMutationTrx(trx.replace('System.IO.IOException', 'System.TimeoutException'), 'mutant'), /different reason/u);
    assert.throws(() => validateWarningMutationTrx(trx.replace('executed="1"', 'executed="0"'), 'mutant'), /specified executed oracle/u);
    assert.throws(() => validateWarningMutationTrx(trx.replace('notExecuted="0"', 'notExecuted="1"'), 'mutant'), /specified executed oracle/u);
    assert.throws(() => validateWarningMutationTrx(trx.replaceAll(warningOnlyMutation.oracle.split('.').at(-1), 'PeerRecordingFixture'), 'mutant'), /specified executed oracle/u);
    assert.throws(() => validateWarningMutationTrx(trx.replace('total="1"', 'total="2"'), 'mutant'), /specified executed oracle/u);
    assert.throws(() => validateWarningMutationTrx(trx.replace('testId="oracle"', 'testId="different"'), 'mutant'), /specified executed oracle/u);
    assert.throws(() => validateWarningMutationTrx(trx.replace('error="0"', 'error="1"'), 'mutant'), /specified executed oracle/u);
});

test('physical source fault is a real single store-write removal, with canonical Shell execution ownership', () =>
{
    const source = fs.readFileSync(path.join(root, warningOnlyMutation.source), 'utf8');
    assert.equal(source.split(warningOnlyMutation.before).length, 2);
    assert.ok(warningOnlyMutation.after.includes('_logger.LogWarning'));
    assert.ok(!warningOnlyMutation.after.includes('WriteBatchAsync'));
    const shell = fs.readFileSync(path.join(root, 'tools/test/lanes/_suite-support.sh'), 'utf8');
    assert.match(shell, /RunBoundedWarningOnlySourceMutation\(\)[\s\S]*setsid --wait bash/u);
    assert.ok(shell.includes(`local oracle='${warningOnlyMutation.oracle}'`));
    const producer = fs.readFileSync(path.join(root, 'tools/governance/bounded-channel-contracts.mjs'), 'utf8');
    assert.doesNotMatch(producer, /node:child_process|\bspawnSync\(|\bexecFileSync\(/u);
});

test('ordinary backend-unit has no physical mutation call or exclusive evidence/cache dependency', () =>
{
    const shell = fs.readFileSync(path.join(root, 'tools/test/lanes/_suite-support.sh'), 'utf8');
    const start = shell.indexOf('RunBackendUnitLane() {');
    const end = shell.indexOf('\nRunDistributedContractFastOnly() {', start);
    assert.ok(start >= 0 && end > start);
    assert.doesNotMatch(shell.slice(start, end), /RunBoundedWarningOnlySourceMutation|warning-only-source-mutation/u);
    assert.match(shell, /\[\[ "\$purpose" == development \]\]/u);
    assert.doesNotMatch(shell, /\.tmp\/backend-unit\/warning-only-source-mutation\.json/u);
    const matrix = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    const laneStart = matrix.indexOf('    - id: backend-unit\n');
    const laneEnd = matrix.indexOf('\n    - id:', laneStart + 1);
    assert.ok(laneStart >= 0 && laneEnd > laneStart);
    assert.doesNotMatch(matrix.slice(laneStart, laneEnd), /warning-only-source-mutation|tests\/tools\/bounded-channel-contracts\.test\.mjs|tools\/governance\/bounded-channel-contracts\.mjs/u);
});

function mutationIdentityFixture()
{
    const expected = { currentCommit: '1'.repeat(40), fingerprint: `sha256:${'2'.repeat(64)}`, runId: 'owned-run-3', purpose: 'canonical' };
    const invocation = { candidateCommit: expected.currentCommit, parentCommit: expected.currentCommit,
        candidateFingerprint: expected.fingerprint, runId: expected.runId, purpose: expected.purpose };
    return { expected, invocation };
}

test('physical identity compares every invocation field with independently supplied expected values', () =>
{
    const { expected, invocation } = mutationIdentityFixture();
    assert.deepEqual(validateWarningMutationIdentity(invocation, expected), expected);
    for (const field of ['candidateCommit', 'candidateFingerprint', 'runId', 'purpose'])
    {
        assert.throws(() => validateWarningMutationIdentity({ ...invocation, [field]: 'different' }, expected), /independently expected/u);
    }
    assert.throws(() => validateWarningMutationIdentity(invocation), /independent expected/u);
    for (const field of ['currentCommit', 'fingerprint', 'runId', 'purpose'])
    {
        assert.throws(() => validateWarningMutationIdentity(invocation, { ...expected, [field]: '' }), /independent expected/u);
    }
});

test('old parent is explicitly development-only and cannot qualify the current immutable candidate', () =>
{
    const { expected, invocation } = mutationIdentityFixture();
    const oldParent = { ...invocation, parentCommit: '4'.repeat(40) };
    assert.throws(() => validateWarningMutationIdentity(oldParent, expected), /current immutable commit/u);
    assert.equal(validateWarningMutationIdentity({ ...oldParent, purpose: 'development' },
        { ...expected, purpose: 'development' }).purpose, 'development');
    assert.throws(() => validateWarningMutationIdentity({ ...oldParent, parentCommit: 'not-a-commit', purpose: 'development' },
        { ...expected, purpose: 'development' }), /parent/u);
});

test('ready ownership uses native PGID/SID and supports a forked setsid launcher', () =>
{
    const direct = '100 90 90 90 S shell\n200 100 200 200 S waiting';
    assert.equal(validateWarningMutationReady('200 100 200 200', direct, 200, 100).processGroup, 200);
    const forked = '100 90 90 90 S shell\n200 100 90 90 S setsid\n201 200 201 201 S waiting';
    const ready = validateWarningMutationReady('201 200 201 201', forked, 200, 100);
    assert.equal(ready.processGroup, 201);
    assert.equal(ready.session, 201);
    assert.notEqual(ready.processGroup, ready.launcher);
});

test('ready ownership rejects assumed launcher PGID, incorrect SID, peer ancestry and missing leader', () =>
{
    const processes = '100 90 90 90 S shell\n200 100 90 90 S setsid\n201 200 201 201 S waiting';
    assert.throws(() => validateWarningMutationReady('201 200 200 201', processes, 200, 100), /ownership/u);
    assert.throws(() => validateWarningMutationReady('201 200 201 200', processes, 200, 100), /ownership/u);
    assert.throws(() => validateWarningMutationReady('201 200 201 201', processes.replace('201 200', '201 300'), 200, 100), /ownership/u);
    assert.throws(() => validateWarningMutationReady('201 200 201 201', processes.replace('200 100', '200 300'), 200, 100), /ancestry/u);
    assert.throws(() => validateWarningMutationReady('201 200 201 201', processes.replace('\n201 200 201 201 S waiting', ''), 200, 100), /ownership/u);
    assert.throws(() => validateWarningMutationReady('201 200 201 201', processes, 201, 201), /ownership/u);
});

test('physical terminal observation rejects remaining owned group/session, live launcher and empty inventory', () =>
{
    const ready = { owner: 100, launcher: 200, processGroup: 201, session: 201 };
    const observer = 'PID PPID PGID SID S COMMAND\n100 90 90 90 S shell';
    assert.doesNotThrow(() => validateWarningMutationTerminal(observer, ready));
    assert.throws(() => validateWarningMutationTerminal(`${observer}\n202 1 201 201 S dotnet`, ready), /not terminated/u);
    assert.throws(() => validateWarningMutationTerminal(`${observer}\n202 1 202 201 S dotnet`, ready), /not terminated/u);
    assert.throws(() => validateWarningMutationTerminal(`${observer}\n200 100 90 90 S setsid`, ready), /not terminated/u);
    assert.throws(() => validateWarningMutationTerminal('', ready), /malformed/u);
    assert.throws(() => validateWarningMutationTerminal('PID PPID PGID SID S COMMAND', ready), /observer is absent/u);
    assert.throws(() => validateWarningMutationTerminal(`${observer}\n100 90 90 90 S duplicate`, ready), /malformed/u);
});

test('DLL parity requires actual identical variant backend and test-directory bytes, not timestamps', () =>
{
    assert.doesNotThrow(() => validateWarningMutationDllParity(Buffer.from('actual-DLL'), Buffer.from('actual-DLL')));
    assert.throws(() => validateWarningMutationDllParity(Buffer.from('actual-DLL'), Buffer.from('other-DLL')), /differs/u);
    assert.throws(() => validateWarningMutationDllParity(Buffer.alloc(0), Buffer.alloc(0)), /differs/u);
});

function catalog()
{
    return JSON.parse(fs.readFileSync(defaultCatalogPath, 'utf8'));
}

function currentDiscovery()
{
    discoveredCatalogQueues ??= discoverBoundedChannels();
    return discoveredCatalogQueues;
}

function mutate(change)
{
    const value = catalog();
    change(value);
    value.digest = deliveryCatalogDigest(value.queues);
    return validateBoundedChannelCatalog(defaultCatalogPath, { catalog: value, discovered: currentDiscovery() });
}

test('discovers direct, wrapped, and indirect bounded channel owners', () =>
{
    const file = 'src/Fixture.cs';
    const discovered = discoverBoundedChannels({ sources: new Map([[file, `
using System.Threading.Channels;
sealed class Fixture {
  private const string RawExample = """Channel.CreateBounded<int>(1)""";
  private const string VerbatimExample = @"Channel.CreateBounded<int>(1)";
  private const string InterpolatedExample = $"Channel.CreateBounded<int>({1})";
  // Channel<int> commented = Channel.CreateBounded<int>(1);
  Channel<int> direct = Channel.CreateBounded<int>(1);
  Channel<int> wrapped;
  Channel<int> indirect;
  Fixture() { wrapped = Inner(); indirect = Outer(); }
  private static Channel<int> Inner() => Channel.CreateBounded<int>(2);
  private static Channel<int> Outer() => Inner();
}
`]]) });
    assert.deepEqual(discovered.map((item) => [item.target, item.creationKind]), [
        ['direct', 'direct'],
        ['indirect', 'indirect'],
        ['wrapped', 'wrapped']
    ]);
});

test('discovers unbounded channels after masking comments and literals', () =>
{
    const file = 'src/Fixture.cs';
    const discovered = discoverUnboundedChannels({ sources: new Map([[file, `
const string text = "Channel.CreateUnbounded<int>()";
// Channel.CreateUnbounded<int>();
Channel<int> actual = Channel.CreateUnbounded<int>();
`]]) });
    assert.deepEqual(discovered, [{ file, line: 4 }]);
});

test('catalog is bidirectionally exact and rejects every real unbounded channel', () =>
{
    const forbidden = discoverUnboundedChannels().map((channel) => `unbounded channel is forbidden: ${channel.file}:${channel.line}`);
    assert.deepEqual(validateBoundedChannelCatalog(defaultCatalogPath, { discovered: currentDiscovery() }), forbidden);
    const report = queueDispositionReport();
    assert.equal(report.length, currentDiscovery().length);
    assert.ok(report.every((entry) => entry.disposition && entry.implementationOwner));
});

test('required security-risk catalog binds protected admission and replay without request SQL', () =>
{
    const queue = catalog().queues.find((entry) => entry.queueId === 'security-risk-event');
    assert.equal(queue.deliveryClass, 'required');
    assert.equal(queue.drainParticipant, true);
    assert.equal(queue.channelBehavior.fullMode, 'Wait');
    assert.equal(queue.channelBehavior.writerPrimitive, 'TryWrite+TryEnqueueOrShed');
    assert.match(queue.channelBehavior.waitTryWriteDisposition, /protected local durable admission/u);
    assert.match(queue.channelBehavior.waitTryWriteDisposition, /without request-path SQL/u);
    assert.deepEqual(queue.readerCallsites, [{
        file: 'src/backend/Infrastructure/Security/SecurityRiskEventWriter.cs',
        token: '_journal.Value.TryLease(out write)'
    }]);
    assert.deepEqual(queue.fallback.callsites, [{
        file: 'src/backend/Infrastructure/Security/SecurityRiskEventWriter.cs',
        token: 'await _journal.Value.AdmitAsync(safe)'
    }, {
        file: 'src/backend/Infrastructure/Security/SecurityRiskFallbackWriter.cs',
        token: 'aes.Encrypt(nonce, plaintext, ciphertext, tag,'
    }]);
    assert.equal(queue.classProof.kind, 'required');
    assert.equal(queue.classProof.durableSource.file, 'src/backend/Infrastructure/Security/SecurityRiskFallbackWriter.cs');
    assert.equal(queue.classProof.durableSource.token, 'File.Move(temporary, path, overwrite: false)');
    assert.match(queue.failureSemantics.commitPostcondition, /confirmed risk-store commit.*per-event key deletion/u);
    assert.match(queue.failureSemantics.overflowMarker, /shed and synchronous SQL fallback counts remain zero/u);
    assert.doesNotMatch(JSON.stringify(queue), /queue-or-shed|records shed|synchronously enter the durable event store/u);
});

test('rejects missing, extra, duplicate queue IDs, discovery keys, and owners', () =>
{
    assert.match(mutate((value) => value.queues.pop()).join('\n'), /missing from catalog/u);
    assert.match(mutate((value) => value.queues.push({ ...value.queues[0], queueId: 'orphan', discoveryKey: 'src/missing.cs#Missing.queue', owner: { ...value.queues[0].owner, id: 'orphan' } })).join('\n'), /orphan catalog queue/u);
    assert.match(mutate((value) =>
    {
        value.queues[1].queueId = value.queues[0].queueId;
    }).join('\n'), /duplicate queue ID/u);
    assert.match(mutate((value) =>
    {
        value.queues[1].discoveryKey = value.queues[0].discoveryKey;
    }).join('\n'), /duplicate discovery key/u);
    assert.match(mutate((value) =>
    {
        value.queues[1].owner.id = value.queues[0].owner.id;
    }).join('\n'), /duplicate owner/u);
});

test('rejects unknown owner and delivery class', () =>
{
    assert.match(mutate((value) =>
    {
        value.queues[0].owner.type = 'UnknownOwner';
    }).join('\n'), /owner does not match/u);
    assert.match(mutate((value) =>
    {
        value.queues[0].deliveryClass = 'unknown';
    }).join('\n'), /unknown delivery class/u);
});

test('loaded schema rejects missing fields and additional properties', () =>
{
    assert.match(mutate((value) =>
    {
        delete value.queues[0].failureSemantics;
    }).join('\n'), /required property 'failureSemantics'/u);
    assert.match(mutate((value) =>
    {
        value.queues[0].wildcardSuppression = '*';
    }).join('\n'), /additional properties/u);
    assert.match(mutate((value) =>
    {
        value.queues[0].classProof.wildcardSuppression = '*';
    }).join('\n'), /additional properties|oneOf/u);
});

test('rejects incomplete class-specific proofs', () =>
{
    assert.match(mutate((value) =>
    {
        delete value.queues.find((queue) => queue.deliveryClass === 'required').classProof.durableSource;
    }).join('\n'), /durableSource/u);
    assert.match(mutate((value) =>
    {
        delete value.queues.find((queue) => queue.deliveryClass === 'required').classProof.replaySource;
    }).join('\n'), /replaySource/u);
    assert.match(mutate((value) =>
    {
        delete value.queues.find((queue) => queue.deliveryClass === 'best-effort').classProof.productProof;
    }).join('\n'), /productProof/u);
    assert.match(mutate((value) =>
    {
        delete value.queues.find((queue) => queue.deliveryClass === 'coalescible').classProof.commutativeProof;
    }).join('\n'), /commutativeProof/u);
    assert.match(mutate((value) =>
    {
        delete value.queues.find((queue) => queue.deliveryClass === 'coalescible').classProof.monotonicProof;
    }).join('\n'), /monotonicProof/u);
    assert.match(mutate((value) =>
    {
        delete value.queues.find((queue) => queue.deliveryClass === 'replayable').classProof.executableSource;
    }).join('\n'), /executableSource/u);
    assert.match(mutate((value) =>
    {
        delete value.queues.find((queue) => queue.deliveryClass === 'replayable').classProof.postcondition;
    }).join('\n'), /postcondition/u);
});

test('best-effort product proof cannot waive protected semantics', () =>
{
    assert.match(mutate((value) =>
    {
        value.queues.find((queue) => queue.deliveryClass === 'best-effort').classProof.impact = 'security audit may be lost';
    }).join('\n'), /cannot waive security/u);
});

test('Wait plus TryWrite requires an explicit disposition', () =>
{
    assert.match(mutate((value) =>
    {
        delete value.queues.find((queue) => queue.channelBehavior.fullMode === 'Wait' && queue.channelBehavior.writerPrimitive.includes('TryWrite')).channelBehavior.waitTryWriteDisposition;
    }).join('\n'), /Wait plus TryWrite must be explained/u);
});

test('drain participant adapters must implement and register the exact wrapper', () =>
{
    assert.match(mutate((value) =>
    {
        value.queues[0].participantAdapter.token = 'UnregisteredAdapter';
    }).join('\n'), /participantAdapter token|participantAdapter is not registered/u);
    assert.match(mutate((value) =>
    {
        value.queues[0].participantAdapter.file = 'src/backend/Infrastructure/Operations/ReleaseDrainParticipants.cs';
    }).join('\n'), /participantAdapter token|participantAdapter is not registered/u);
});

test('writer primitive mutations fail closed instead of becoming universal WriteAsync', () =>
{
    assert.match(mutate((value) =>
    {
        value.queues.find((queue) => queue.channelBehavior.writerPrimitive.includes('TryWrite')).channelBehavior.writerPrimitive = 'WriteAsync';
    }).join('\n'), /writer primitive does not match/u);
});

test('protected audit and security queues cannot be downgraded to warning-only best effort', () =>
{
    assert.match(mutate((value) =>
    {
        const target = value.queues.find((queue) => /audit|security|risk|challenge/iu.test(`${queue.queueId} ${queue.owner.type}`));
        const bestEffort = value.queues.find((queue) => queue.deliveryClass === 'best-effort');
        target.deliveryClass = 'best-effort';
        target.classProof = structuredClone(bestEffort.classProof);
    }).join('\n'), /protected audit\/security queue cannot be best-effort/u);
});

test('a newly discovered bounded channel fails closed until cataloged', () =>
{
    const discovered = [...currentDiscovery()];
    discovered.push({ discoveryKey: 'src/backend/FutureQueue.cs#FutureQueue._channel', file: 'src/backend/FutureQueue.cs', ownerType: 'FutureQueue', target: '_channel', creationKind: 'direct', factory: null, line: 4 });
    assert.match(validateBoundedChannelCatalog(defaultCatalogPath, { discovered }).join('\n'), /missing from catalog: .*FutureQueue/u);
});

test('PublicHot references authoritative contracts without copied authority', () =>
{
    assert.match(mutate((value) =>
    {
        value.queues.find((queue) => queue.owner.type === 'PublicHotArtifactUpdateQueue').copiedAuthority = { rule: 'local copy' };
    }).join('\n'), /must not copy/u);
    assert.match(mutate((value) =>
    {
        value.queues.find((queue) => queue.owner.type === 'PublicHotArtifactUpdateQueue').authoritativeContracts.pop();
    }).join('\n'), /#1629-#1631 exactly/u);
    assert.equal(catalog().queues.find((queue) => queue.owner.type === 'PublicHotReadRiskProjectionWorker').authoritativeContracts, undefined);
    assert.match(mutate((value) =>
    {
        value.queues.find((queue) => queue.owner.type === 'PublicHotReadRiskProjectionWorker').owner.type = 'PublicHotFutureQueue';
    }).join('\n'), /#1629-#1631 exactly/u);
});

test('stable ordering and digest reject reorder or content drift', () =>
{
    const value = catalog();
    value.queues.reverse();
    assert.match(validateBoundedChannelCatalog(defaultCatalogPath, { catalog: value, discovered: currentDiscovery() }).join('\n'), /stable queueId ordering/u);
    const clean = catalog();
    clean.queues[0].disposition += '-drift';
    assert.match(validateBoundedChannelCatalog(defaultCatalogPath, { catalog: clean, discovered: currentDiscovery() }).join('\n'), /digest does not match/u);
});

test('receipt source closure includes every catalog implementation and proof input', () =>
{
    const catalog = JSON.parse(fs.readFileSync(defaultCatalogPath, 'utf8'));
    const references = new Set();
    const visit = (value) =>
    {
        if (!value || typeof value !== 'object')
        {
            return;
        }
        if (typeof value.file === 'string')
        {
            references.add(value.file);
        }
        Object.values(value).forEach(visit);
    };
    visit(catalog.queues);
    const receipt = buildBoundedQueueAcceptanceReceipt();
    const bindings = new Map(receipt.source.files.map((entry) => [entry.path, entry.contentDigest]));
    assert.deepEqual([...references].filter((file) => !bindings.has(file)).sort(), []);
    for (const file of references)
    {
        const expected = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')}`;
        assert.equal(bindings.get(file), expected, file);
    }
    assert.equal(bindings.size, receipt.source.files.length);
});

test('terminal receipt binds current source, catalog, aggregate, matrix, mutations, and zero warnings', () =>
{
    const forbidden = discoverUnboundedChannels();
    if (forbidden.length > 0)
    {
        assert.throws(() => buildBoundedQueueAcceptanceReceipt(), /cannot build bounded queue acceptance receipt: .*unbounded channel is forbidden/u);
        assert.throws(() => verifyBoundedQueueAcceptanceReceipt({ schema: 'fsusblog.bounded-queue-acceptance.v1' }), /unbounded channel is forbidden/u);
        return;
    }
    const receipt = buildBoundedQueueAcceptanceReceipt();
    const participantQueues = catalog().queues.filter((queue) => queue.drainParticipant);
    assert.equal(receipt.schema, 'fsusblog.bounded-queue-acceptance.v1');
    assert.equal(receipt.perQueue.length, participantQueues.length);
    assert.deepEqual(receipt.perQueue.map((queue) => queue.queueId), participantQueues.map((queue) => queue.queueId));
    assert.ok(receipt.perQueue.every((queue) => queue.scenarios.length === 10 && queue.participantAdapter.token));
    assert.equal(receipt.matrix.enumeration, 'BoundedQueueDeliveryCatalog.Embedded.DrainParticipants');
    assert.equal(receipt.matrix.fixtureCount, participantQueues.length * 10);
    assert.deepEqual(receipt.drainAggregate.participantQueueIds, participantQueues.map((queue) => queue.queueId));
    assert.equal(receipt.mutationResults.length, 8);
    assert.deepEqual(receipt.warnings, []);
    assert.match(receipt.contentDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(verifyBoundedQueueAcceptanceReceipt(receipt), receipt);
    const tampered = structuredClone(receipt);
    tampered.warnings.push('mutation warning');
    assert.throws(() => verifyBoundedQueueAcceptanceReceipt(tampered), /does not match current source/u);
});

test('published JSON schema owns the catalog shape', () =>
{
    const schema = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/bounded-channel-delivery-contracts.schema.json'), 'utf8'));
    assert.equal(schema.$id, 'https://fsus.blog/schemas/testing/bounded-channel-delivery-contracts.schema.json');
    assert.deepEqual(schema.properties.queues.items.properties.deliveryClass.enum, ['required', 'best-effort', 'coalescible', 'replayable']);
    assert.deepEqual(
        schema.properties.queues.items.properties.classProof.oneOf.map((entry) => entry.$ref),
        ['#/$defs/requiredProof', '#/$defs/bestEffortProof', '#/$defs/coalescibleProof', '#/$defs/replayableProof']
    );
});
