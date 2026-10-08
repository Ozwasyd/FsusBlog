global using Xunit;

using System.Collections.Immutable;
using System.Reflection;
using System.Text.Json;

using FsusBlog.Server.Tests.Unit;
using FsusBlog.Shared.Contracts.ArticleVault;

// Structural composite checks only. Fixture references prove no actual backup/server/local artifact.
ArticleVaultMetadataManifest baseline = Invoke<ArticleVaultMetadataManifest>("Metadata");
ArticleVaultMetadataManifest local = baseline with { Title = "diagnostic-local-title", ContentSha256 = string.Empty };
local = local with { ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(local) };
ArticleVaultMetadataManifest server = baseline with { Summary = "diagnostic-server-summary", ContentSha256 = string.Empty };
server = server with { ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(server) };
ArticleVaultScalarMetadataInput metadata = Invoke<ArticleVaultScalarMetadataInput>("Input", baseline, local, server, null!);
ArticleVaultScalarMetadataCandidate candidate = ArticleVaultScalarMetadataMerge.Build(metadata).Candidate!;
VaultConflictRegistryEntry entry = ArticleVaultConflictRegistry.Find(VaultConflictType.MetadataDisjoint)!;
VaultConflictObservation observation = new(VaultConflictType.MetadataDisjoint, null, candidate.Facts, null);
ArticleVaultConflictEvidence evidence = new(ArticleVaultConflictSchemas.Evidence, 1, ArticleVaultConflictRegistry.ContentSha256,
    metadata.Binding, [new(entry.Type, entry.Disposition, entry.AllowedActions, observation)], string.Empty);
evidence = evidence with { ContentSha256 = ArticleVaultConflictCodec.ComputeContentSha256(evidence) };
Assert.True(ArticleVaultConflictVerifier.ValidateStructure(evidence).IsValid);

string digest = new('a', 64);
ImmutableArray<VaultGitSourceFacts> sources = [new(metadata.Binding.PortableArticleIdentity,
    metadata.Binding.Coordinates.Local.Source!.Sha256, ArticleVaultGitFactDecoder.FindMarkers("source\n"u8))];
ImmutableArray<VaultGitOperation> operations = [];
ArticleVaultGitFacts git = new(ArticleVaultGitFactDecoder.Schema, 1,
    new(metadata.Binding.SiteIdentity, metadata.Binding.VaultIdentity, metadata.Binding.DeviceIdentity, "qa-agent", digest,
        metadata.Root.ContentSha256, VaultPathComparisonPolicy.Ordinal), VaultGitAvailability.NotPresent, "git-not-present",
    null, null, null, null, null, null, null, operations, sources,
    Hash(sources), Hash(operations), string.Empty);
git = git with { ContentSha256 = ArticleVaultGitFactDecoder.ComputeContentSha256(git) };
Assert.True(ArticleVaultGitFactDecoder.Validate(git).IsValid);
ArticleVaultResolutionPlanInput current = new(metadata, evidence, git,
    [new(entry.Type, VaultConflictAction.PrepareMetadataCandidate, entry.Disposition, candidate.ContentSha256)], candidate,
    new("qa-confirmation", "qa-actor", metadata.Context.NowUnixMs), metadata.Plan.ExpiresAtUnixMs);
ArticleVaultResolutionPlanResult built = ArticleVaultResolutionPlanner.Build(current);
Assert.Null(built.ReasonCode);
ArticleVaultResolutionPlan plan = built.Plan!;
long created = current.Metadata.Context.NowUnixMs;
ArticleVaultRecoveryJournal prepared = Seal(new(ArticleVaultRecoveryJournalVerifier.Schema, 1, plan.ResolutionOperationIdentity,
    plan.ContentSha256, plan.Binding.SiteIdentity, plan.Binding.VaultIdentity, plan.Binding.DeviceIdentity,
    0, null, VaultRecoveryState.Prepared, new("qa-missing-backup", digest),
    new(1024, created + 60_000, true, "private-source", "owned-encrypted-backup-expiry-v1"),
    null, null, null, plan.Binding.Coordinates.Base.ContentSha256, null, created, string.Empty));
ArticleVaultRecoveryJournal committing = Seal(prepared with
{
    Sequence = 1, PreviousCheckpointSha256 = prepared.ContentSha256, State = VaultRecoveryState.ServerCommitting,
    CreatedAtUnixMs = created + 1
});
ArticleVaultRecoveryJournal interrupted = Seal(committing with
{
    Sequence = 2, PreviousCheckpointSha256 = committing.ContentSha256, State = VaultRecoveryState.RecoveryRequired,
    CreatedAtUnixMs = created + 2
});
ImmutableArray<ArticleVaultRecoveryJournal> history = [prepared, committing, interrupted];
VaultRecoveryReference checkpoint = new(plan.ResolutionOperationIdentity + "-checkpoint-2", interrupted.ContentSha256);
if (args[0] == "export")
{
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        plan = Convert.ToBase64String(ArticleVaultResolutionPlanner.Serialize(plan)),
        history = history.Select(journal => Convert.ToBase64String(ArticleVaultRecoveryJournalVerifier.Serialize(journal))).ToArray()
    }));
    return;
}
using JsonDocument export = JsonDocument.Parse(File.ReadAllText(args[1]));
plan = ArticleVaultResolutionPlanner.Deserialize(Convert.FromBase64String(export.RootElement.GetProperty("plan").GetString()!));
history = export.RootElement.GetProperty("history").EnumerateArray().Select(item =>
    ArticleVaultRecoveryJournalVerifier.Deserialize(Convert.FromBase64String(item.GetString()!))).ToImmutableArray();
Assert.True(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, history, checkpoint).IsValid);
Assert.False(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, history,
    checkpoint with { ContentSha256 = prepared.ContentSha256 }).IsValid);
Assert.False(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, [history[1], history[2]], checkpoint).IsValid);
string admission = ArticleVaultRecoveryJournalVerifier.RequireRecoveryAdmission(plan, current, history, checkpoint).ReasonCode!;
Assert.Equal("article_vault_recovery_canonical_materializer_and_operation_admission_missing", admission);
Assert.Equal("article_vault_resolution_canonical_execution_admission_missing",
    ArticleVaultResolutionPlanner.RequireExecutionAdmission(plan, current).ReasonCode);
ArticleVaultResolutionPlanInput expired = current with
{
    Metadata = metadata with { Context = metadata.Context with { NowUnixMs = plan.ExpiresAtUnixMs + 1 } }
};
ArticleVaultValidationResult stale = ArticleVaultRecoveryJournalVerifier.RequireRecoveryAdmission(plan, expired, history, checkpoint);
Assert.False(stale.IsValid);
Assert.NotEqual(admission, stale.ReasonCode);
ArticleVaultRecoveryJournal fakeComplete = Seal(interrupted with { State = VaultRecoveryState.Complete });
Assert.False(ArticleVaultRecoveryJournalVerifier.ValidateStructure(fakeComplete).IsValid);
Console.WriteLine(JsonSerializer.Serialize(new
{
    pid = Environment.ProcessId, status = "passed", structuralChecks = 7,
    states = history.Select(journal => journal.State.ToString()), admission,
    staleReason = stale.ReasonCode, authorityQualification = false
}));

static string Hash<T>(T value)
    => ArticleVaultManifestCodec.ComputeSha256((byte[])typeof(ArticleVaultManifestCodec)
        .GetMethod("SerializeCanonical", BindingFlags.NonPublic | BindingFlags.Static)!
        .MakeGenericMethod(typeof(T)).Invoke(null, [value])!);

static ArticleVaultRecoveryJournal Seal(ArticleVaultRecoveryJournal journal)
    => journal with { ContentSha256 = ArticleVaultRecoveryJournalVerifier.ComputeContentSha256(journal) };

static T Invoke<T>(string method, params object[] arguments)
    => (T)typeof(ArticleVaultScalarMetadataMergeTests).GetMethod(method, BindingFlags.NonPublic | BindingFlags.Static)!
        .Invoke(null, arguments)!;
