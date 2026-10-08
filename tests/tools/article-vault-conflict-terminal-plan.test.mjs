import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = mkdtempSync(path.join(os.tmpdir(), 'article-vault-conflict-terminal-plan-'));
let actual;

// Real original planner, serialized scalar bytes, merge, conflict verifier, plan and journal APIs.
// Git/backup/result references below are descriptor fixtures, never native observations or receipts.
const program = String.raw`
using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using FsusBlog.Shared.Contracts.ArticleVault;

const string A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const string B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const string C = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const long Now = 1_800_000_000_000;
var checks = new Dictionary<string, object>();
var input = Input(false);
var before = ArticleVaultSyncPlanCodec.Serialize(input.Metadata.Plan);
var built = ArticleVaultResolutionPlanner.Build(input);
checks["scalar-build"] = built.ReasonCode ?? "valid";
if (built.Plan is null) throw new InvalidDataException("actual_scalar_plan_build_failed:" + built.ReasonCode);
var plan = built.Plan;
checks["current-plan"] = Result(ArticleVaultResolutionPlanner.VerifyCurrent(plan, input));
checks["execution-unavailable"] = Result(ArticleVaultResolutionPlanner.RequireExecutionAdmission(plan, input));
checks["original-blocked-preserved"] = input.Metadata.Plan.Status == VaultSyncPlanStatus.Blocked
    && before.SequenceEqual(ArticleVaultSyncPlanCodec.Serialize(input.Metadata.Plan)) && input.Metadata.Plan.OperationOrder.Count == 0;
var bytes = ArticleVaultResolutionPlanner.Serialize(plan);
checks["plan-round-trip"] = bytes.SequenceEqual(ArticleVaultResolutionPlanner.Serialize(ArticleVaultResolutionPlanner.Deserialize(bytes)));
checks["proposal-binds-real-candidate"] = plan.ExpectedOutput!.MetadataManifestSha256 == input.MetadataCandidate!.Metadata.ContentSha256
    && plan.Decisions[0].ResultCandidateSha256 == input.MetadataCandidate.ContentSha256
    && plan.ExpectedOutput.ExpectedServerRevision == input.Metadata.Binding.Coordinates.Server.ServerRevision;
checks["proposal-no-body"] = !Encoding.UTF8.GetString(bytes).Contains("private-local-title", StringComparison.Ordinal)
    && !Encoding.UTF8.GetString(bytes).Contains("private-server-summary", StringComparison.Ordinal);
var repeated = ArticleVaultResolutionPlanner.Build(input).Plan!;
checks["confirmation-idempotent"] = plan.ContentSha256 == repeated.ContentSha256
    && plan.ResolutionOperationIdentity == repeated.ResolutionOperationIdentity;
var newConfirmation = input with { Confirmation = input.Confirmation with { ConfirmationIdentity = "confirmation-next" } };
var nextPlan = ArticleVaultResolutionPlanner.Build(newConfirmation).Plan!;
checks["new-confirmation-append-only"] = nextPlan.ContentSha256 != plan.ContentSha256
    && nextPlan.ResolutionOperationIdentity != plan.ResolutionOperationIdentity
    && bytes.SequenceEqual(ArticleVaultResolutionPlanner.Serialize(plan));

checks["missing-decision"] = ArticleVaultResolutionPlanner.Build(input with { Decisions = [] }).ReasonCode!;
checks["duplicate-decision"] = ArticleVaultResolutionPlanner.Build(input with { Decisions = [input.Decisions[0], input.Decisions[0]] }).ReasonCode!;
checks["unknown-action"] = ArticleVaultResolutionPlanner.Build(input with
    { Decisions = [input.Decisions[0] with { Action = (VaultConflictAction)999 }] }).ReasonCode!;
checks["wrong-provenance"] = ArticleVaultResolutionPlanner.Build(input with
    { Decisions = [input.Decisions[0] with { Provenance = VaultConflictDisposition.Manual }] }).ReasonCode!;
checks["candidate-ref-tamper"] = ArticleVaultResolutionPlanner.Build(input with
    { Decisions = [input.Decisions[0] with { ResultCandidateSha256 = A }] }).ReasonCode!;
checks["confirmation-in-future"] = ArticleVaultResolutionPlanner.Build(input with
    { Confirmation = input.Confirmation with { ConfirmedAtUnixMs = Now + 1 } }).ReasonCode!;
checks["expired-plan"] = ArticleVaultResolutionPlanner.Build(input with { ExpiresAtUnixMs = Now }).ReasonCode!;
checks["manual-reader-unavailable"] = ArticleVaultResolutionPlanner.Build(Input(true)).ReasonCode!;
checks["missing-base-bytes"] = ArticleVaultResolutionPlanner.Build(input with
    { Metadata = input.Metadata with { BaseBytes = ReadOnlyMemory<byte>.Empty } }).ReasonCode!;

var cancelledInput = input with { MetadataCandidate = null,
    Decisions = [input.Decisions[0] with { Action = VaultConflictAction.CancelOperation, ResultCandidateSha256 = null }] };
var cancelled = ArticleVaultResolutionPlanner.Build(cancelledInput).Plan!;
checks["cancellation-is-descriptor"] = cancelled.State == VaultResolutionPlanState.Cancelled && cancelled.ExpectedOutput is null;
checks["cancelled-execution-denied"] = Result(ArticleVaultResolutionPlanner.RequireExecutionAdmission(cancelled, cancelledInput));
checks["cancel-with-result-denied"] = ArticleVaultResolutionPlanner.Build(cancelledInput with
    { Decisions = [cancelledInput.Decisions[0] with { ResultCandidateSha256 = A }] }).ReasonCode!;

checks["stale-git-ref"] = Result(ArticleVaultResolutionPlanner.VerifyCurrent(plan, input with
    { Git = input.Git with { ContentSha256 = A } }));
checks["stale-conflict-ref"] = Result(ArticleVaultResolutionPlanner.VerifyCurrent(plan, input with
    { Evidence = input.Evidence with { ContentSha256 = A } }));
checks["stale-root-ref"] = Result(ArticleVaultResolutionPlanner.VerifyCurrent(plan, input with
    { Metadata = input.Metadata with { Root = input.Metadata.Root with { ContentSha256 = A } } }));
checks["stale-decisions"] = Result(ArticleVaultResolutionPlanner.VerifyCurrent(plan, cancelledInput));
var observation = input.Metadata.Observations[0];
var revised = observation with { ServerCoordinate = Coordinate(observation.ServerCoordinate with { ServerRevision = 6 }) };
revised = revised with { ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(revised) };
checks["stale-server-coordinate"] = Result(ArticleVaultResolutionPlanner.VerifyCurrent(plan, input with
    { Metadata = input.Metadata with { Observations = [revised] } }));
var changedLocalBytes = ArticleVaultManifestCodec.Serialize(Metadata(
    ArticleVaultManifestCodec.DeserializeMetadata(input.Metadata.LocalBytes.Span) with { Title = "private-current-local-drift" }));
checks["stale-local-byte-snapshot"] = Result(ArticleVaultResolutionPlanner.VerifyCurrent(plan, input with
    { Metadata = input.Metadata with { LocalBytes = changedLocalBytes } }));
foreach (var authority in new[] { "lifecycle", "permission", "dependency" })
{
    var changedCoordinate = Coordinate(authority switch
    {
        "lifecycle" => observation.ServerCoordinate with { Lifecycle = "published" },
        "permission" => observation.ServerCoordinate with { PermissionSha256 = B },
        _ => observation.ServerCoordinate with { DependencySha256 = B }
    });
    var changedObservation = observation with { ServerCoordinate = changedCoordinate };
    changedObservation = changedObservation with { ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(changedObservation) };
    checks["stale-server-" + authority] = Result(ArticleVaultResolutionPlanner.VerifyCurrent(plan, input with
        { Metadata = input.Metadata with { Observations = [changedObservation] } }));
}
var markerSources = input.Git.Sources.SetItem(0, input.Git.Sources[0] with { MarkerRanges = [new(0, 7, "git-marker")] });
var markedGit = Git(input.Git with { Sources = markerSources,
    WorktreeSha256 = ArticleVaultGitFactDecoder.ComputeWorktreeSha256(markerSources) });
checks["markers-block-new-plan"] = ArticleVaultResolutionPlanner.Build(input with { Git = markedGit }).ReasonCode!;
checks["markers-stale-old-plan"] = Result(ArticleVaultResolutionPlanner.VerifyCurrent(plan, input with { Git = markedGit }));
checks["plan-digest-tamper"] = Throws(() => ArticleVaultResolutionPlanner.Serialize(plan with { ContentSha256 = A }));
checks["plan-extra-executable-field"] = Throws(() => ArticleVaultResolutionPlanner.Deserialize(
    Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(bytes)[..^1] + ",\"shell\":\"private-command\"}")));
checks["plan-size-bound"] = Throws(() => ArticleVaultResolutionPlanner.Deserialize(new byte[ArticleVaultGitFactDecoder.MaxOutputBytes + 1]));

var prepared = Journal(new(ArticleVaultRecoveryJournalVerifier.Schema, 1, plan.ResolutionOperationIdentity,
    plan.ContentSha256, plan.Binding.SiteIdentity, plan.Binding.VaultIdentity, plan.Binding.DeviceIdentity,
    0, null, VaultRecoveryState.Prepared, new("backup-fixture", A),
    new(ArticleVaultRecoveryJournalVerifier.MaxBackupBytes, Now + 3_600_000, true, "private-source", "owned-encrypted-backup-expiry-v1"),
    null, null, null, plan.Binding.Coordinates.Base.ContentSha256, null, Now, ""));
var committing = Next(prepared, VaultRecoveryState.ServerCommitting);
var committed = Next(committing, VaultRecoveryState.ServerCommitted, server: new("server-result-fixture", B));
var materializing = Next(committed, VaultRecoveryState.LocalMaterializing);
var recovery = Next(materializing, VaultRecoveryState.RecoveryRequired);
var recovered = Next(recovery, VaultRecoveryState.Recovered, local: new("local-result-fixture", C), baseline: new("base-result-fixture", B));
var complete = Next(recovered, VaultRecoveryState.Complete);
ImmutableArray<ArticleVaultRecoveryJournal> history = [prepared, committing, committed, materializing, recovery, recovered, complete];
var rolled = Next(recovery, VaultRecoveryState.RolledForward, local: new("local-result-fixture", C), baseline: new("base-result-fixture", B));
var cancelledJournal = Next(prepared, VaultRecoveryState.Cancelled);
var failed = Next(committing, VaultRecoveryState.Failed);
var states = history.Add(rolled).Add(cancelledJournal).Add(failed);
checks["closed-journal-state-coverage"] = Enum.GetValues<VaultRecoveryState>().Select(state => new
    { state = JsonNamingPolicy.KebabCaseLower.ConvertName(state.ToString()),
      valid = states.Where(journal => journal.State == state).All(journal => ArticleVaultRecoveryJournalVerifier.ValidateStructure(journal).IsValid),
      count = states.Count(journal => journal.State == state) }).ToArray();
checks["history-exact"] = Result(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, history, Tip(complete)));
checks["roll-forward-descriptor"] = Result(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan,
    [prepared, committing, committed, materializing, recovery, rolled, Next(rolled, VaultRecoveryState.Complete)],
    Tip(Next(rolled, VaultRecoveryState.Complete))));
checks["cancel-history"] = Result(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, [prepared, cancelledJournal], Tip(cancelledJournal)));
checks["server-failure-history"] = Result(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, [prepared, committing, failed], Tip(failed)));
checks["recovery-unavailable"] = Result(ArticleVaultRecoveryJournalVerifier.RequireRecoveryAdmission(plan, input,
    [prepared, committing, committed, materializing, recovery], Tip(recovery)));
checks["complete-ref-not-physical-proof"] = Result(ArticleVaultRecoveryJournalVerifier.RequireRecoveryAdmission(plan, input, history, Tip(complete)));
checks["partial-cannot-be-complete"] = Result(ArticleVaultRecoveryJournalVerifier.ValidateStructure(Journal(recovery with { State = VaultRecoveryState.Complete })));
checks["server-only-not-local-base"] = recovery.ServerResult == committed.ServerResult && recovery.LocalMaterialization is null
    && recovery.BaseCommit is null && recovery.AfterBaseSha256 is null;
checks["old-checkpoint-not-latest"] = Result(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, history, Tip(committed)));
checks["checkpoint-identity-tamper"] = Result(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, history, new("latest", complete.ContentSha256)));
checks["checkpoint-digest-tamper"] = Result(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, history, Tip(complete) with { ContentSha256 = A }));
checks["history-deletion"] = Result(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, history.RemoveAt(0), Tip(complete)));
checks["history-reordered"] = Result(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan,
    history.SetItem(2, materializing).SetItem(3, committed), Tip(complete)));
var overwritten = Journal(recovery with { ServerResult = new("replacement-server-result", C) });
checks["server-history-overwrite"] = Result(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan,
    [prepared, committing, committed, materializing, overwritten], Tip(overwritten)));
var deleted = Journal(recovery with { ServerResult = null });
checks["server-history-delete"] = Result(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan,
    [prepared, committing, committed, materializing, deleted], Tip(deleted)));
var swappedBackup = Journal(recovery with { Backup = new("backup-other", C) });
checks["backup-ref-swap"] = Result(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan,
    [prepared, committing, committed, materializing, swappedBackup], Tip(swappedBackup)));
var wrongOperation = Journal(prepared with { ResolutionOperationIdentity = "operation-other" });
checks["journal-plan-binding-drift"] = Result(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, [wrongOperation], Tip(wrongOperation)));
checks["recovery-current-ref-drift"] = Result(ArticleVaultRecoveryJournalVerifier.RequireRecoveryAdmission(plan,
    input with { Git = markedGit }, history, Tip(complete)));

checks["invalid-backup-policy"] = new[] {
    prepared.BackupPolicy with { MaxBytes = ArticleVaultRecoveryJournalVerifier.MaxBackupBytes + 1 },
    prepared.BackupPolicy with { MaxBytes = 0 },
    prepared.BackupPolicy with { EncryptionRequired = false },
    prepared.BackupPolicy with { PrivacyClass = "public" },
    prepared.BackupPolicy with { CleanupPolicyIdentity = "delete-user-files" },
    prepared.BackupPolicy with { DeleteAfterUnixMs = Now },
    prepared.BackupPolicy with { DeleteAfterUnixMs = Now + ArticleVaultRecoveryJournalVerifier.MaxBackupRetentionMs + 1 }
}.Select(policy => Result(ArticleVaultRecoveryJournalVerifier.ValidateStructure(Journal(prepared with { BackupPolicy = policy })))).ToArray();
var journalBytes = ArticleVaultRecoveryJournalVerifier.Serialize(recovery);
checks["journal-round-trip"] = journalBytes.SequenceEqual(ArticleVaultRecoveryJournalVerifier.Serialize(
    ArticleVaultRecoveryJournalVerifier.Deserialize(journalBytes)));
checks["journal-no-body"] = !Encoding.UTF8.GetString(journalBytes).Contains("private-local-title", StringComparison.Ordinal);
checks["journal-extra-token-field"] = Throws(() => ArticleVaultRecoveryJournalVerifier.Deserialize(
    Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(journalBytes)[..^1] + ",\"token\":\"private-token\"}")));
checks["journal-size-bound"] = Throws(() => ArticleVaultRecoveryJournalVerifier.Deserialize(new byte[ArticleVaultGitFactDecoder.MaxOutputBytes + 1]));
checks["journal-digest-tamper"] = Throws(() => ArticleVaultRecoveryJournalVerifier.Serialize(recovery with { ContentSha256 = A }));
Console.WriteLine(JsonSerializer.Serialize(new { qualification = "descriptor-and-prerequisite-only", checks }));

object Result(ArticleVaultValidationResult value) => new { valid = value.IsValid, reason = value.ReasonCode };
string Throws(Action action)
{
    try { action(); return "unexpected-acceptance"; }
    catch (InvalidDataException error) { return error.Message; }
}
VaultArticleCoordinate Coordinate(VaultArticleCoordinate value) => value with { ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(value) };
ArticleVaultMetadataManifest Metadata(ArticleVaultMetadataManifest value) => value with { ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(value) };
ArticleVaultGitFacts Git(ArticleVaultGitFacts value) => value with { ContentSha256 = ArticleVaultGitFactDecoder.ComputeContentSha256(value) };
ArticleVaultRecoveryJournal Journal(ArticleVaultRecoveryJournal value) => value with { ContentSha256 = ArticleVaultRecoveryJournalVerifier.ComputeContentSha256(value) };
VaultRecoveryReference Tip(ArticleVaultRecoveryJournal value) => new(plan.ResolutionOperationIdentity + "-checkpoint-" + value.Sequence, value.ContentSha256);
ArticleVaultRecoveryJournal Next(ArticleVaultRecoveryJournal previous, VaultRecoveryState state,
    VaultRecoveryReference? server = null, VaultRecoveryReference? local = null, VaultRecoveryReference? baseline = null)
    => Journal(previous with { Sequence = previous.Sequence + 1, PreviousCheckpointSha256 = previous.ContentSha256,
        State = state, CreatedAtUnixMs = previous.CreatedAtUnixMs + 1, ServerResult = server ?? previous.ServerResult,
        LocalMaterialization = local ?? previous.LocalMaterialization, BaseCommit = baseline ?? previous.BaseCommit,
        AfterBaseSha256 = baseline is null ? previous.AfterBaseSha256 : B });

ArticleVaultResolutionPlanInput Input(bool overlap)
{
    var baseline = Metadata(new(ArticleVaultSchemas.MetadataManifest, 1, "site-fixture", "vault-fixture", "device-fixture",
        "article-fixture", "server-fixture", "baseline title", "baseline summary", "baseline-slug", A, A, ""));
    var local = Metadata(baseline with { Title = "private-local-title" });
    var server = Metadata(overlap ? baseline with { Title = "private-server-title" } : baseline with { Summary = "private-server-summary" });
    var source = ArticleVaultManifestCodec.CaptureSourceBytes(Encoding.UTF8.GetBytes("private-source-body\n"));
    var baseCoordinate = Coordinate(new(ArticleVaultSchemas.Coordinate, 1, true, false, 4, source, baseline.ContentSha256, A, "draft", A, ""));
    var localCoordinate = Coordinate(baseCoordinate with { MetadataManifestSha256 = local.ContentSha256 });
    var serverCoordinate = Coordinate(baseCoordinate with { ServerRevision = 5, MetadataManifestSha256 = server.ContentSha256 });
    const string Projection = "articles/article-fixture.md";
    var article = new ArticleVaultArticleManifest(ArticleVaultSchemas.ArticleManifest, 1, baseline.SiteIdentity,
        baseline.VaultIdentity, baseline.DeviceIdentity, baseline.PortableArticleIdentity, baseline.ServerArticleIdentity,
        new(Projection, ArticleVaultManifestCodec.ComputeProjectionSha256(Projection)), new(baseCoordinate, localCoordinate, baseCoordinate),
        new(0, null, null, null, null, null, null), VaultArticleState.Clean, "");
    article = article with { State = ArticleVaultStateMachine.Derive(article) };
    article = article with { ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article) };
    var observation = new ArticleVaultServerObservation(ArticleVaultPlanSchemas.ServerObservation, 1, baseline.SiteIdentity,
        baseline.VaultIdentity, baseline.DeviceIdentity, baseline.PortableArticleIdentity, baseline.ServerArticleIdentity, serverCoordinate, "");
    observation = observation with { ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation) };
    var root = new ArticleVaultRootManifest(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
        new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
        baseline.SiteIdentity, baseline.VaultIdentity, baseline.DeviceIdentity,
        [new(baseline.PortableArticleIdentity, ".fsus/articles/article-fixture.json", article.ContentSha256, Projection)], [], "");
    root = root with { ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root) };
    var original = ArticleVaultSyncPlanner.Build(new(root, [article], [observation],
        [new("group-fixture", [baseline.PortableArticleIdentity], [])], VaultSyncDirection.Sync, Now, Now + 60_000, false));
    if (!original.IsSuccess) throw new InvalidDataException("original_plan_fixture_invalid:" + string.Join(',', original.Errors));
    var originalPlan = original.Plan!;
    var item = originalPlan.Groups[0].Items[0];
    var binding = new VaultConflictBinding(originalPlan.SiteIdentity, originalPlan.VaultIdentity, originalPlan.DeviceIdentity,
        item.PortableArticleIdentity, item.ServerArticleIdentity, originalPlan.PlanCandidateIdentity, originalPlan.ContentSha256,
        item.GroupIdentity, item.OperationIdentity, article.ContentSha256, observation.ContentSha256, new(item.Base, item.Local, item.Server));
    var metadata = new ArticleVaultScalarMetadataInput(originalPlan, root, [article], [observation],
        new(Now, VaultSyncDirection.Sync, false), binding, ArticleVaultManifestCodec.Serialize(baseline),
        ArticleVaultManifestCodec.Serialize(local), ArticleVaultManifestCodec.Serialize(server));
    var merged = ArticleVaultScalarMetadataMerge.Build(metadata);
    var fact = merged.Conflict ?? new(VaultConflictType.MetadataDisjoint, null, merged.Candidate!.Facts, null);
    var entry = ArticleVaultConflictRegistry.Find(fact.Type)!;
    var evidence = new ArticleVaultConflictEvidence(ArticleVaultConflictSchemas.Evidence, 1, ArticleVaultConflictRegistry.ContentSha256,
        binding, [new(fact.Type, entry.Disposition, entry.AllowedActions, fact)], "");
    evidence = evidence with { ContentSha256 = ArticleVaultConflictCodec.ComputeContentSha256(evidence) };
    ImmutableArray<VaultGitSourceFacts> sources = [new(baseline.PortableArticleIdentity, source.Sha256, [])];
    ImmutableArray<VaultGitOperation> operations = [];
    var git = Git(new(ArticleVaultGitFactDecoder.Schema, 1,
        new(root.SiteIdentity, root.VaultIdentity, root.DeviceIdentity, "agent-fixture", A, root.ContentSha256, VaultPathComparisonPolicy.Ordinal),
        VaultGitAvailability.NotPresent, "git-not-present", null, null, null, null, null, null, null, operations, sources,
        ArticleVaultGitFactDecoder.ComputeWorktreeSha256(sources), ArticleVaultGitFactDecoder.ComputeOperationSha256(operations), ""));
    return new(metadata, evidence, git,
        [new(fact.Type, overlap ? VaultConflictAction.ProposeMetadataReplacement : VaultConflictAction.PrepareMetadataCandidate,
            entry.Disposition, merged.Candidate?.ContentSha256)], merged.Candidate, new("confirmation-fixture", "actor-fixture", Now), Now + 30_000);
}
`;

before(async () =>
{
    const shared = path.join(root, 'src/shared/FsusBlog.Shared.csproj')
        .replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    writeFileSync(path.join(directory, 'PlanFixture.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><LangVersion>14.0</LangVersion><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
    <ItemGroup><ProjectReference Include="${shared}" /></ItemGroup>
</Project>\n`);
    writeFileSync(path.join(directory, 'Program.cs'), program);
    const { stdout } = await promisify(execFile)(process.env.DOTNET_HOST_PATH || 'dotnet',
        ['run', '--project', path.join(directory, 'PlanFixture.csproj'), '--verbosity', 'quiet', '--no-launch-profile', '--disable-build-servers'],
        { cwd: directory, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_CLI_HOME: path.join(directory, 'cli-home'),
                MSBUILDDISABLENODEREUSE: '1', FSUSBLOG_PRODUCTION_BUILD_ROOT: path.join(directory, 'compiled') } });
    actual = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
});

after(() => rmSync(directory, { recursive: true, force: true }));

const valid = { valid: true, reason: null };
const rejected = reason => ({ valid: false, reason });
const expectations = {
    'scalar-build': 'valid',
    'current-plan': valid,
    'execution-unavailable': rejected('article_vault_resolution_canonical_execution_admission_missing'),
    'original-blocked-preserved': true,
    'plan-round-trip': true,
    'proposal-binds-real-candidate': true,
    'proposal-no-body': true,
    'confirmation-idempotent': true,
    'new-confirmation-append-only': true,
    'missing-decision': 'article_vault_resolution_input_missing',
    'duplicate-decision': 'article_vault_resolution_decision_confirmation_or_expiry_invalid',
    'unknown-action': 'article_vault_resolution_decision_invalid_item_0',
    'wrong-provenance': 'article_vault_resolution_decision_invalid_item_0',
    'candidate-ref-tamper': 'article_vault_resolution_candidate_digest_or_effects_drift_item_0',
    'confirmation-in-future': 'article_vault_resolution_decision_confirmation_or_expiry_invalid',
    'expired-plan': 'article_vault_resolution_decision_confirmation_or_expiry_invalid',
    'manual-reader-unavailable': 'article_vault_resolution_manual_candidate_reader_missing_item_0',
    'missing-base-bytes': 'article_vault_scalar_metadata_source_invalid',
    'cancellation-is-descriptor': true,
    'cancelled-execution-denied': rejected('article_vault_resolution_cancelled'),
    'cancel-with-result-denied': 'article_vault_resolution_cancel_result_present_item_0',
    'stale-git-ref': rejected('article_vault_resolution_stale_git_facts'),
    'stale-conflict-ref': rejected('article_vault_resolution_stale_conflict_evidence'),
    'stale-root-ref': rejected('article_vault_resolution_stale_root_manifest'),
    'stale-decisions': rejected('article_vault_resolution_stale_binding_or_decisions'),
    'stale-server-coordinate': rejected('article_vault_plan_coordinate_drift'),
    'stale-local-byte-snapshot': rejected('article_vault_scalar_metadata_source_binding_mismatch'),
    'stale-server-lifecycle': rejected('article_vault_plan_coordinate_drift'),
    'stale-server-permission': rejected('article_vault_plan_coordinate_drift'),
    'stale-server-dependency': rejected('article_vault_plan_coordinate_drift'),
    'markers-block-new-plan': 'article_vault_git_source_blocked',
    'markers-stale-old-plan': rejected('article_vault_resolution_stale_git_facts'),
    'plan-digest-tamper': 'article_vault_resolution_content_invalid',
    'plan-extra-executable-field': 'article_vault_resolution_schema_invalid',
    'plan-size-bound': 'article_vault_resolution_size_limit',
    'history-exact': valid,
    'roll-forward-descriptor': valid,
    'cancel-history': valid,
    'server-failure-history': valid,
    'recovery-unavailable': rejected('article_vault_recovery_canonical_materializer_and_operation_admission_missing'),
    'complete-ref-not-physical-proof': rejected('article_vault_recovery_canonical_materializer_and_operation_admission_missing'),
    'partial-cannot-be-complete': rejected('article_vault_recovery_receipt_state_or_digest_invalid'),
    'server-only-not-local-base': true,
    'old-checkpoint-not-latest': rejected('article_vault_recovery_exact_checkpoint_drift'),
    'checkpoint-identity-tamper': rejected('article_vault_recovery_exact_checkpoint_drift'),
    'checkpoint-digest-tamper': rejected('article_vault_recovery_exact_checkpoint_drift'),
    'history-deletion': rejected('article_vault_recovery_prepared_checkpoint_missing'),
    'history-reordered': rejected('article_vault_recovery_checkpoint_transition_invalid'),
    'server-history-overwrite': rejected('article_vault_recovery_checkpoint_transition_invalid'),
    'server-history-delete': rejected('article_vault_recovery_checkpoint_transition_invalid'),
    'backup-ref-swap': rejected('article_vault_recovery_checkpoint_transition_invalid'),
    'journal-plan-binding-drift': rejected('article_vault_recovery_plan_binding_drift'),
    'recovery-current-ref-drift': rejected('article_vault_resolution_stale_git_facts'),
    'journal-round-trip': true,
    'journal-no-body': true,
    'journal-extra-token-field': 'article_vault_recovery_schema_invalid',
    'journal-size-bound': 'article_vault_recovery_size_limit',
    'journal-digest-tamper': 'article_vault_recovery_receipt_state_or_digest_invalid'
};

for (const [name, expected] of Object.entries(expectations))
{
    test(`real Shared plan/journal prerequisite: ${name}`, () =>
    {
        assert.equal(actual.qualification, 'descriptor-and-prerequisite-only');
        assert.deepEqual(actual.checks[name], expected);
    });
}

test('all ten actual journal enum states have valid descriptor fixtures without granting recovery', () =>
{
    assert.deepEqual(actual.checks['closed-journal-state-coverage'].map(row => row.state), [
        'prepared', 'server-committing', 'server-committed', 'local-materializing', 'recovery-required',
        'recovered', 'rolled-forward', 'cancelled', 'failed', 'complete'
    ]);
    for (const row of actual.checks['closed-journal-state-coverage'])
    {
        assert.equal(row.count, 1);
        assert.equal(row.valid, true);
    }
});

test('backup capacity, TTL, encryption, privacy and cleanup policy mutations fail closed', () =>
{
    assert.equal(actual.checks['invalid-backup-policy'].length, 7);
    for (const result of actual.checks['invalid-backup-policy'])
    {
        assert.deepEqual(result, rejected('article_vault_recovery_backup_policy_invalid'));
    }
});
