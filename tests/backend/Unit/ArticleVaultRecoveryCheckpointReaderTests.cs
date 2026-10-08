using System.Collections.Immutable;

using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultRecoveryCheckpointReaderTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const long Now = 1_800_000_000_000;

    [Fact]
    public void CompiledResolutionRecoveryAndReaderOwners_HaveNoFilesystemProcessOrMutationCalls()
    {
        Type[] owners =
        [typeof(ArticleVaultResolutionPlanner), typeof(ArticleVaultRecoveryJournalVerifier), typeof(ArticleVaultGitFactDecoder),
            typeof(ArticleVaultRecoveryCheckpointReader), typeof(ArticleVaultRecoveryStoredProposalReader)];
        RuntimeMetadataInspection.RuntimeMemberSite[] references = owners
            .SelectMany(static owner => new[] { owner }.Concat(owner.GetNestedTypes(System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.NonPublic)))
            .SelectMany(static type => RuntimeMetadataInspection.ReadMemberSites(type)).ToArray();
        Assert.NotEmpty(references);
        Assert.DoesNotContain(references, static site =>
        {
            Type? owner = site.Member as Type ?? site.Member.DeclaringType;
            string name = owner?.FullName ?? string.Empty;
            return name.StartsWith("System.IO.", StringComparison.Ordinal) && !typeof(Exception).IsAssignableFrom(owner!)
                || name.StartsWith("System.Diagnostics.Process", StringComparison.Ordinal)
                || name.StartsWith("System.Net.", StringComparison.Ordinal)
                || name.Contains("IArticleVaultCanonicalGroupWriter", StringComparison.Ordinal)
                || site.Member.Name is "ExecuteGroupAsync" or "ExecuteAsync" or "SaveResultAsync" or "AppendAsync" or "RegisterAsync";
        });
    }

    [Fact]
    public async Task Reader_UsesExactSealedPlanAndCheckpointReferencesWithoutWritesOrLatestLookup()
    {
        Fixture fixture = Create();
        ArticleVaultRecoveryCheckpointSnapshot snapshot = await fixture.Reader.ReadAsync(
            fixture.Resolution, fixture.Operation, 0, fixture.Checkpoint.ContentSha256);
        Assert.Equal(fixture.Checkpoint, Assert.Single(snapshot.Checkpoints));
        Assert.Null(snapshot.ServerResult);
        Assert.Null(snapshot.MaterializationPreflight);
        Assert.Contains("encrypted_recovery_backup_and_journal_persistence", snapshot.MissingCapabilities);
        await fixture.ExecutionStore.Received(1).LoadSealedAsync(fixture.Bundle.PlanReference, fixture.Bundle.PlanSha256, Arg.Any<CancellationToken>());
        await fixture.CheckpointStore.Received(1).ReadThroughAsync(fixture.Operation, fixture.Bundle.Plan, 0,
            fixture.Checkpoint.ContentSha256, Arg.Any<CancellationToken>());
        Assert.DoesNotContain(fixture.ExecutionStore.ReceivedCalls(), call => call.GetMethodInfo().Name.StartsWith("Save", StringComparison.Ordinal));
        Assert.DoesNotContain(fixture.CheckpointStore.ReceivedCalls(), call => call.GetMethodInfo().Name is "RegisterAsync" or "AppendAsync");
    }

    [Fact]
    public async Task Reader_RejectsLatestAndCrossArticleBindingsBeforeCheckpointRead()
    {
        Fixture fixture = Create();
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Reader.ReadAsync(fixture.Resolution, fixture.Operation, 0, "latest"));
        ArticleVaultResolutionPlan altered = fixture.Resolution with
        {
            Binding = fixture.Resolution.Binding with
            {
                PortableArticleIdentity = "other-article"
            }
        };
        altered = altered with
        {
            ContentSha256 = ArticleVaultResolutionPlanner.ComputeContentSha256(altered)
        };
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Reader.ReadAsync(altered, fixture.Operation, 0, fixture.Checkpoint.ContentSha256));
        Assert.Empty(fixture.CheckpointStore.ReceivedCalls());
    }

    [Fact]
    public async Task Reader_RejectsMissingSealedPlanAndTamperedHistory()
    {
        Fixture fixture = Create();
        fixture.ExecutionStore.LoadSealedAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ArticleVaultSealedExecutionBundle?>(null));
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Reader.ReadAsync(fixture.Resolution, fixture.Operation, 0, fixture.Checkpoint.ContentSha256));
        fixture = Create();
        ArticleVaultOperationCheckpoint altered = fixture.Checkpoint with
        {
            State = VaultOperationState.Synced
        };
        fixture.CheckpointStore.ReadThroughAsync(Arg.Any<ArticleVaultOperationIdentity>(), Arg.Any<ArticleVaultSyncPlan>(),
            Arg.Any<long>(), Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(Task.FromResult<IReadOnlyList<ArticleVaultOperationCheckpoint>>([altered]));
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Reader.ReadAsync(fixture.Resolution, fixture.Operation, 0, fixture.Checkpoint.ContentSha256));
    }

    // This fixture tests exact read binding, not a persisted journal or executable resolution proof.
    internal static Fixture Create(byte[]? sourceBytes = null)
    {
        VaultSourceByteIdentity source = ArticleVaultManifestCodec.CaptureSourceBytes(sourceBytes ?? "source\n"u8.ToArray());
        VaultArticleCoordinate coordinate = new(ArticleVaultSchemas.Coordinate, 1, true, false, 4, source, Digest, Digest, "draft", Digest, string.Empty);
        coordinate = coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };
        const string Path = "articles/article-one.md";
        ArticleVaultArticleManifest article = new(ArticleVaultSchemas.ArticleManifest, 1, "site-one", "vault-one", "device-one", "article-one", "101",
            new(Path, ArticleVaultManifestCodec.ComputeProjectionSha256(Path)), new(coordinate, coordinate, coordinate),
            new(0, null, null, null, null, null, null), VaultArticleState.Clean, string.Empty);
        article = article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
        ArticleVaultRootManifest root = new(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            "site-one", "vault-one", "device-one", [new("article-one", ".fsus/articles/article-one.json", article.ContentSha256, Path)], [], string.Empty);
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        ArticleVaultServerObservation observation = new(ArticleVaultPlanSchemas.ServerObservation, 1, "site-one", "vault-one", "device-one",
            "article-one", "101", coordinate, string.Empty);
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        ArticleVaultSyncPlan plan = ArticleVaultSyncPlanner.Build(new(root, [article], [observation],
            [new("group-one", ["article-one"], [])], VaultSyncDirection.Sync, Now, Now + 60_000, false)).Plan!;
        ArticleVaultExecutionPayload payload = new(ArticleVaultExecutionSchemas.Payload, 1, [], string.Empty);
        payload = payload with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealPayload(payload)
        };
        ArticleVaultSealedExecutionBundle bundle = new(ArticleVaultExecutionSchemas.Bundle, 1, plan.PlanCandidateIdentity, plan.ContentSha256,
            7, plan, root, [article], [observation], payload, string.Empty);
        bundle = bundle with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle)
        };
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        VaultSyncPlanItem item = plan.Groups[0].Items[0];
        VaultConflictBinding binding = new(plan.SiteIdentity, plan.VaultIdentity, plan.DeviceIdentity, item.PortableArticleIdentity, item.ServerArticleIdentity,
            plan.PlanCandidateIdentity, plan.ContentSha256, item.GroupIdentity, item.OperationIdentity, article.ContentSha256, observation.ContentSha256,
            new(item.Base, item.Local, item.Server));
        ArticleVaultResolutionPlan resolution = new(ArticleVaultResolutionPlanner.Schema, 1, "resolution-reader-test", VaultResolutionPlanState.Prepared,
            binding, Digest, Digest, root.ContentSha256, ArticleVaultScalarMetadataMerge.FieldRegistrySha256,
            [new(item.GroupIdentity, true, [item.PortableArticleIdentity], [])],
            [new(VaultConflictType.MetadataDisjoint, VaultConflictAction.PrepareMetadataCandidate, VaultConflictDisposition.Automatic, Digest)],
            [VaultConflictType.MetadataDisjoint], new(4, source.Sha256, Digest, Digest), new("confirmation-one", "actor-one", Now), Now + 30_000, string.Empty);
        resolution = resolution with
        {
            ContentSha256 = ArticleVaultResolutionPlanner.ComputeContentSha256(resolution)
        };
        ArticleVaultOperationIdentity operation = ArticleVaultOperationVerifier.Bind(plan, "agent-one", Digest, Digest, Now + 30_000);
        ArticleVaultOperationCheckpoint checkpoint = new(ArticleVaultOperationSchemas.Checkpoint, 1, operation.OperationIdentity, operation.ContentSha256,
            0, null, Now, VaultOperationState.Planned, VaultServerCommitDisposition.NotStarted, null, null,
            [new(item.PortableArticleIdentity, item.Base.ContentSha256, item.Base.ContentSha256)], false, null, string.Empty);
        checkpoint = checkpoint with
        {
            ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(checkpoint)
        };
        IArticleVaultExecutionStore executionStore = Substitute.For<IArticleVaultExecutionStore>();
        IArticleVaultOperationCheckpointStore checkpointStore = Substitute.For<IArticleVaultOperationCheckpointStore>();
        executionStore.LoadSealedAsync(bundle.PlanReference, bundle.PlanSha256, Arg.Any<CancellationToken>()).Returns(Task.FromResult<ArticleVaultSealedExecutionBundle?>(bundle));
        checkpointStore.ReadThroughAsync(operation, plan, 0, checkpoint.ContentSha256, Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<IReadOnlyList<ArticleVaultOperationCheckpoint>>([checkpoint]));
        return new(bundle, resolution, operation, checkpoint, executionStore, checkpointStore, new(executionStore, checkpointStore));
    }

    internal sealed record Fixture(
        ArticleVaultSealedExecutionBundle Bundle,
        ArticleVaultResolutionPlan Resolution,
        ArticleVaultOperationIdentity Operation,
        ArticleVaultOperationCheckpoint Checkpoint,
        IArticleVaultExecutionStore ExecutionStore,
        IArticleVaultOperationCheckpointStore CheckpointStore,
        ArticleVaultRecoveryCheckpointReader Reader);
}
