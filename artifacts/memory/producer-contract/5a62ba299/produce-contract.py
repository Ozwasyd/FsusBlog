import datetime
import hashlib
import json
import pathlib
import shutil
import subprocess
import uuid

root = pathlib.Path.cwd()
candidate = '5a62ba29959c0b116c71a49fd4bfa2d805116d19'
master = '9d72a1c93b297f719d8695a642cdfb1615cf1d51'
work = root / '.tmp/memory/projector-contract-20261009'
out = root / 'artifacts/memory/producer-contract/5a62ba299'
projector = 'src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs'
bootstrap = 'src/backend/Infrastructure/Bootstrap/RuntimeInfrastructureServiceCollectionExtensions.cs'
configuration = 'config/application/backend-configuration-contract.json'

def call(*args):
    return subprocess.check_output(args, text=True).strip()

assert call('git', 'rev-parse', 'HEAD') == candidate
assert call('git', 'rev-parse', 'origin/master') == master
assert not call('git', 'status', '--porcelain')
assert call('git', 'ls-remote', '--heads', 'origin', 'refs/heads/codex/mem-3444-compliant-integration').split()[0] == candidate
changed = call('git', 'diff', '--name-only', 'cd79b28c255c35527496431e910fef7b6db66f80', '00e5f1a0b9c7de2a4c2b04a4e2ea9d0b6ea7846b').splitlines()
assert len(changed) == 7
terms = ['IMemoryHostReadLease', 'IMemoryHostViewSource', 'MemoryCapabilityController',
         'MemoryReservationCoordinator', 'MemoryContentIdentity', 'MemoryLocationToken', 'maximumHolds']
observations = []
for name in [projector, bootstrap, configuration]:
    local = (root / name).read_bytes()
    published = subprocess.check_output(['git', 'show', candidate + ':' + name])
    canonical = subprocess.check_output(['git', 'show', master + ':' + name])
    assert local == published
    counts = {term: canonical.decode().count(term) for term in terms}
    assert all(count == 0 for count in counts.values())
    observations.append({'path': name, 'candidateSha256': hashlib.sha256(local).hexdigest(),
                         'masterSha256': hashlib.sha256(canonical).hexdigest(),
                         'candidateEqualsMaster': local == canonical, 'masterTypedInputCounts': counts})
assert observations[0]['candidateEqualsMaster']
text = (root / projector).read_text()
for hook in ['Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken ct)',
             'BuildSnapshotCoreAsync(existingHtml, gateCt)',
             'FrozenDictionary<int, PublicBinaryArtifact> articleFrames',
             'MaterializeVisibilityCheckedArticleFrames(',
             'PublicHotReadBinaryArtifactFactory.FromWriter(',
             'PublicHotReadPublicationEvidence.CreateVerified(version, projectionCutoff)']:
    assert hook in text
assert 'services.AddScoped<IPublicHotArtifactProjector, PublicHotArtifactProjector>();' in (root / bootstrap).read_text()
bootstrap_source = '\n'.join(p.read_text() for p in (root / 'src/backend/Infrastructure/Bootstrap').glob('*.cs'))
assert not any(term in bootstrap_source for term in terms)
outside_memory = []
for path in (root / 'src/backend').rglob('*.cs'):
    if 'obj' in path.parts or 'bin' in path.parts or '/Infrastructure/Memory/' in str(path):
        continue
    found = [term for term in terms if term in path.read_text()]
    if found:
        outside_memory.append({'path': str(path.relative_to(root)), 'terms': found})
assert {r['path'] for r in outside_memory} == {
    'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadMetrics.cs',
    'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSnapshot.HostOwnership.cs',
}
worktrees = []
for block in call('git', 'worktree', 'list', '--porcelain').split('\n\n'):
    fields = dict(line.split(' ', 1) for line in block.splitlines() if ' ' in line)
    if 'worktree' not in fields:
        continue
    dirty = call('git', '-C', fields['worktree'], 'status', '--porcelain', '--', projector)
    assert not dirty
    worktrees.append({'path': fields['worktree'], 'head': fields['HEAD'], 'uncommittedProjectorChanges': False})
issues = []
for number in [3445, 3446, 3451, 3454, 3456]:
    path = work / f'issue{number}.json'
    issue = json.loads(path.read_text())
    assert issue['number'] == number and issue['state'] == 'OPEN'
    issues.append({'issue': number, 'state': issue['state'], 'bodySha256': hashlib.sha256(issue['body'].encode()).hexdigest(),
                   'comments': len(issue['comments']), 'rawCaptureSha256': hashlib.sha256(path.read_bytes()).hexdigest()})
assert 'Missing thresholds block this issue' in json.loads((work / 'issue3445.json').read_text())['body']
prior = json.loads((root / 'artifacts/memory/control-delivery/00e5f1a0b/checkpoint.json').read_text())
assert prior['sourceHead'] == '00e5f1a0b9c7de2a4c2b04a4e2ea9d0b6ea7846b' and prior['passedCases'] == 29

record = {
    'schema': 'fsusblog.memory.projector-missing-contract-source-probe.v1',
    'runId': 'projector-contract-' + str(uuid.uuid4()),
    'observedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'candidate': candidate, 'candidateTree': call('git', 'rev-parse', candidate + '^{tree}'),
    'latestFetchedMaster': master, 'masterIncorporated': False,
    'sevenChangedFilesAtOriginalSourceIncrement': changed,
    'canonicalSourceObservations': observations, 'typedReferencesOutsideMemoryModule': outside_memory,
    'localWorktreeWriterObservation': worktrees,
    'ownership': {'projectorAdapter': 'This root retained P06/P07 (#3456/#3459) ordinary producer/snapshot integration. No projector assignment to the released native/disk/OS/GPU/transient/flat-index modules; local worktrees show no pending projector write. Local checks do not certify every external coordinator session.',
                  'contentAndLocation': 'Original PublicHotArtifactProjector owns public representation/eligibility. Canonical backing owner (ManagedMemoryBacking or released NativeMemoryArenaBuilder/slice) owns actual allocation/block/revision/epoch and returns the real lease. This root must connect supplied authentic content mappings to those owners; article DB coordinates are not MemoryContentIdentity.',
                  'holdAndMetadataPolicy': 'This root owns P01/P02/P03 (#3445/#3446/#3447) source/finite policy contract work. P01 existing fixture/measurement/acceptance manifest authority freezes numerical rules before performance results; P02 revisioned configuration contract owns units/zero/omission semantics; P03 canonical ledger owns actual domains/admission/charge. No external prerequisite root owns these issues.',
                  'configurationComposition': 'Existing config/application/backend-configuration-contract.json and RuntimeInfrastructureServiceCollectionExtensions retain production configuration/DI authority; there is no memory-policy producer registration in the inspected source.'},
    'missingContract': {
        'producerOwnership': 'For each identity AEDS artifact key, an exclusively transferable actual IMemoryHostReadLease or actual IMemoryHostViewSource plus its current MemoryLocationToken, with stable immutable full frame bytes and the same canonical public eligibility/publication evidence.',
        'contentIdentity': 'Real MemoryContentIdentity(BlobId, ContentGeneration, RepresentationId) from the existing artifact/materialization owner. No mapping from article ID, publication timestamp, CurrentRevisionId, CurrentPublicationId or frame hash to all these owner identities currently exists in the projector.',
        'backingAdmission': 'Real payload/operation ResourceDomainId, current MemoryReservationCoordinator, admitted layout/capacity and hold limit, ResidencyRevision and DeviceEpoch from actual source owner. ManagedMemoryBacking.TryCreate requires these inputs; NativeMemoryArenaBuilder additionally requires frozen NativeMemoryArenaPolicy. The returned lease supplies Content/Location/Memory; raw arrays supply none of these facts.',
        'qualifiedSelection': 'For production capability selection, real MemoryCapabilityController/MemoryCapabilitySelection, current MemoryCapabilityWorkloadAdmission, MemoryGovernorDecision and original resource charges. Select/TryReserveOperation validate supplied facts; they neither create content identity nor return a materialized host read lease. No fabricated Qualified/Admitted status is permitted.',
        'sharedHoldPolicy': 'Frozen policy revision and positive maximumHolds including overlapping snapshot roots/immutable clones/current-last-good-sticky references and actual concurrent consumers, with explicit unit/count, exhaustion result, scope, zero/omission semantics and reload/drain behavior. Existing MaxArtifactObjects counts artifacts, not lease holds; MaxResidentBytes/overlap estimates are not a hold policy.',
        'metadataAdmission': 'Frozen bounded lease/representation/clone/consumer roster and conservative metadata capacity/headroom model for group arrays, HashSet/index entries, snapshot/gates and hold objects. Actual registered byte/operation domains, units, finite charge vector, reservation/conversion owner and release lifetime through final group/consumer completion are required before these allocations. Existing ledger entryLimit/eventCapacity bound ledger metadata, not snapshot ownership metadata. No physical layout or exact CLR header size may be fabricated.',
    },
    'ordinaryCodeGap': 'Original BuildSnapshotCoreAsync/materialization helpers do not receive a typed admitted backing result and therefore cannot call FromHostReadLease + WithHostReadLeases. Delta/view/taxonomy constructors also require producer-owned transfer of unchanged/new representation leases after authoritative inputs exist. The root ordinary attachment/consumer adapter already exists; adding a disconnected overload or wrapping raw arrays with new identities is not a genuine original-path connection.',
    'decision': 'Dependent production projector connection BlockedMissingAuthenticInputsAndFrozenPolicy; no production source edit or Auto activation. This is a specific missing contract within retained root stages, not a generic dependency on the parent.',
    'sourceProbeExit': 0, 'runtimeTestsRunThisProbe': 0, 'wholeIssueOrCriterionAcceptance': 'NotAccepted',
    'previousControlsNotRerun': {'snapshot29Source': prior['sourceHead'],
                               'hostFrame21Source': 'de0adc1a5ed4a32f5cdfc01b9c560f9b357cd250',
                               'nonce14Source': 'ab2c589d02fabfa6ed15967f0e58800d2555398a'},
    'scope': 'Read-only producer/type/configuration/writer inspection; no runtime, native, lease race, alias, TOCTOU, custody, receipt or full SOURCE audit. No issues/metadata changed.'
}
out.mkdir(exist_ok=False, parents=True)
(out / 'probe.json').write_text(json.dumps(record, indent=2) + '\n')
shutil.copyfile(work / 'produce-contract.py', out / 'produce-contract.py')
md = f'''# Canonical projector connection: precise missing contract

Inspected published candidate `{candidate}`. Latest fetched origin/master `{master}`; not incorporated. The projector is byte-identical in both (SHA256 `{observations[0]['candidateSha256']}`). All existing P01/P02/P05/Auto/P06 issue bodies and comments were reread; their current state is OPEN. This report is a source inspection, not runtime or stage acceptance.

## Seven files changed in the preceding source increment

'''
md += '\n'.join('- `' + name + '`' for name in changed) + '\n'
md += '''
## Existing original path and typed interfaces

`IPublicHotArtifactProjector.BuildInitialSnapshotAsync(CancellationToken ct)` (PublicHotArtifactProjector.cs:31/134) calls `BuildSnapshotAsync(IEnumerable<KeyValuePair<string, PublicHtmlArtifact>> existingHtml, CancellationToken ct)` (137), then `BuildSnapshotCoreAsync(existingHtml, ct)` (147). It builds FrozenDictionary<int,PublicBinaryArtifact>, FrozenDictionary<PublicListKey,PublicBinaryArtifact>, category/tag artifacts and the original visibility publication evidence. `BuildArticleFramesAsync` (497) / `MaterializeVisibilityCheckedArticleFrames` (519), `BuildListFramesAsync` (614), `BuildCategoryFrameAsync` (1406), `BuildTagFrameAsync` (1438) and `EncodeFrame` (1470) call the original array writer/factory. Delta, view and taxonomy reconstruction also call original snapshot constructors. The source has no actual host source/lease, memory content/location mapping, controller, canonical ledger or shared hold policy input.

The existing typed destination is `PublicHotReadBinaryArtifactFactory.FromHostReadLease(IMemoryHostReadLease, AedsFrameType, string, long, PublicHotReadOptions)` (PublicHotReadMetrics.cs:528), followed by `PublicHotReadSnapshot.WithHostReadLeases(IReadOnlyList<IMemoryHostReadLease>, int maximumHolds)` (PublicHotReadSnapshot.HostOwnership.cs:21). It consumes real supplied exclusive disposal custody after binding validation and remains identity-only. These calls cannot receive the existing arrays as owning leases.

The actual backing interfaces already exist: `IMemoryHostViewSource.TryAcquireHostView(MemoryLocationToken)` returns `MemoryOperationResult<IMemoryHostReadLease>`; `IMemoryHostReadLease` supplies `MemoryContentIdentity Content`, `MemoryLocationToken Location`, `ReadOnlyMemory<byte> Memory`, disposal custody. `IMemoryMaterializer.MaterializeAsync(MemoryContentIdentity, MemoryLocationToken, CancellationToken)` is the explicit asynchronous non-host path. The managed and arena owners return genuine allocation/block location; projector must not create substitute location/role IDs.

`MemoryCapabilityController.Select(exclusiveGroup, admissions)` (324) returns a selection token; `TryReserveOperation(selection, admission, governor, charges)` (335) checks actual policy/runtime/governor/admission facts and admits the operation. Neither produces content identity or host bytes. RuntimeInfrastructureServiceCollectionExtensions.cs:408 registers the canonical projector, but production Bootstrap has none of these memory services or typed inputs. The existing configuration contract has no memory policy binding. Existing PublicHotReadOptions residency/artifact count limits do not provide the missing ownership metadata/hold contract.

## Ownership and missing inputs

The ordinary projector adapter and canonical representation connection remain this root's retained P06/P07 integration. No released module owns this projector, and all six local task worktrees have no pending projector edits. This local observation does not certify every external coordinator session. No conflicting write is attempted because essential inputs are absent independently of any writer lock.

The materialization owner must supply stable canonical public frame bytes and actual memory Blob/Generation/Representation identity, source/location and exclusive read-lease custody. Article ID, DB revision/publication coordinates, version timestamp or hash alone cannot establish those memory identities. ManagedMemoryBacking.TryCreate needs actual ledger/payload-operation domains, content, residency revision, device epoch, capacity and holdLimit; NativeMemoryArenaBuilder additionally needs its actual frozen arena policy. Real source owners generate and retain physical allocation/block identity. Public eligibility/currentness remains the original projector/publication authority.

This root also owns the missing P01/P02/P03 contract work (#3445/#3446/#3447), rather than another prerequisite root. The existing P01 fixture/measurement/acceptance-manifest authority must freeze numerical rules, P02 configuration contract must define revision/units/zero/omission semantics, and P03 canonical ledger must provide real topology/domains/charge admission. Required policy inputs are: positive maximumHolds scoped across roots/immutable clones/current-last-good-sticky overlap and concurrent consumers; bounded lease/representation/clone/consumer roster; conservative metadata capacity/headroom for arrays/HashSets/index/snapshot/gates/hold objects; actual byte/operation domains, finite charge vector, reservation/conversion owner, final-group/consumer release lifetime, exhaustion behavior and reload/drain behavior. Existing ledger entryLimit/eventCapacity only bounds ledger metadata. No measured/frozen authoritative values or producer of that snapshot ownership policy was found; fixture counts 1/2/3/8 cannot become defaults. Exact CLR header/layout or unrelated existing budgets cannot be repurposed into fabricated physical charges.

## Result

The missing ordinary call is precise: once admitted authoritative representation leases and policy are genuinely supplied to original BuildSnapshotCoreAsync/materialization helpers, use the existing FromHostReadLease + WithHostReadLeases transfer while retaining original visibility/publication checks and rejection cleanup. Delta/view/taxonomy paths also need actual source-owned transfer for unchanged/new representations. Currently these inputs are absent, so a disconnected overload or array wrapper would not connect the original production path. The dependent connection remains **BlockedMissingAuthenticInputsAndFrozenPolicy**. No product source was changed or qualified, no Auto enabled, and no new IDs/statuses/budgets invented.

The successful 29-case preflight/TRX remains at 00e5f1a0b9c7de2a4c2b04a4e2ea9d0b6ea7846b. Previous 21-case and 14-case results retain their original commits. No tests were rerun for this source inspection; no held native/lease race/alias/TOCTOU/custody/receipt/full SOURCE audits were invoked. All 23 issue rows/237 criteria remain NotAccepted in the previous complete checkpoint.
'''
(out / 'contract.md').write_text(md)
manifest = {'candidate': candidate, 'latestFetchedMaster': master, 'runId': record['runId'], 'files': []}
for path in sorted(out.iterdir()):
    data = path.read_bytes()
    manifest['files'].append({'path': path.name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'candidate': candidate, 'latestFetchedMaster': master, 'sourceProbeExit': 0,
                  'projectorIdenticalToMaster': True, 'decision': record['decision'],
                  'artifactPath': str(out.relative_to(root)), 'runtimeTestsRun': 0}))
