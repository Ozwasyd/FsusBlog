using System.Text;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultRecoveryAcceptedSourceTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    public static IEnumerable<object[]> Sources()
    {
        yield return ["body\n"u8.ToArray()];
        yield return ["body without final newline"u8.ToArray()];
        yield return [Encoding.UTF8.GetBytes("\uFEFF标题 😀  \r\n尾行\r\n")];
    }

    [Theory]
    [MemberData(nameof(Sources))]
    public async Task ExactRecoveryCheckpoint_UsesCanonicalHistoricalReaderAndPreservesBytes(byte[] source)
    {
        Fixture fixture = new(source);
        ArticleVaultRecoveryAcceptedSourceSnapshot snapshot = await fixture.ReadAsync();
        Assert.Equal(fixture.Tip.ContentSha256, snapshot.Checkpoint.Checkpoints[^1].ContentSha256);
        Assert.Equal(fixture.Result.ContentSha256, snapshot.Checkpoint.ServerResult!.ContentSha256);
        Assert.Equal(source, snapshot.AcceptedSource.Package.RawMarkdown.ToArray());
        Assert.Equal(4, snapshot.AcceptedSource.Package.RevisionId);
        Assert.Equal(900, snapshot.AcceptedSource.Package.RevisionNo);
        Assert.Equal(RevisionCompareSourceKind.HistoricalRevision, fixture.Selector!.Kind);
        Assert.Equal(snapshot.AcceptedSource.Source.Sha256, fixture.Selector.ExpectedSourceDigest);
        Assert.Equal(fixture.ReadFixture.Bundle.Plan.RootManifestSha256, snapshot.AcceptedSource.Instruction.RootManifestSha256);
        Assert.Equal(2, fixture.PermissionReads);
        Assert.Equal(1, fixture.SourceReads);
        Assert.False(snapshot.CanCommitBase);
        Assert.False(snapshot.AcceptedSource.CanCommitBase);
        Assert.Contains("native_conditional_write_and_readback", snapshot.Checkpoint.MissingCapabilities);
        Assert.Contains("atomic_verified_manifest_base_receipt_commit", snapshot.Checkpoint.MissingCapabilities);
        Assert.DoesNotContain(fixture.ReadFixture.ExecutionStore.ReceivedCalls(), call => call.GetMethodInfo().Name.StartsWith("Save", StringComparison.Ordinal));
        Assert.DoesNotContain(fixture.ReadFixture.CheckpointStore.ReceivedCalls(), call => call.GetMethodInfo().Name is "RegisterAsync" or "AppendAsync");
    }

    [Fact]
    public async Task UnacceptedCheckpoint_DoesNotReadPrivateSourceOrPermissions()
    {
        Fixture fixture = new("body\n"u8.ToArray(), accepted: false);
        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal("article_vault_recovery_accepted_server_result_missing", error.Message);
        Assert.Equal(0, fixture.SourceReads);
        Assert.Equal(0, fixture.PermissionReads);
    }

    [Fact]
    public async Task LatestOrTamperedResultReference_IsRejectedBeforeCanonicalSourceRead()
    {
        Fixture fixture = new("body\n"u8.ToArray());
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadFixture.Reader.ReadAcceptedSourceAsync(
            fixture.ReadFixture.Resolution, fixture.ReadFixture.Operation, fixture.Tip.Sequence, "latest", fixture.Adapter));
        fixture.SetResultReference(new(fixture.Result.ResultReference, Digest));
        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal("article_vault_recovery_server_result_binding_drift", error.Message);
        Assert.Equal(0, fixture.SourceReads);
        Assert.Equal(0, fixture.PermissionReads);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ResealedRootOrOriginalPlanReferenceDrift_IsRejectedBeforeSourceRead(bool rootDrift)
    {
        Fixture fixture = new("body\n"u8.ToArray());
        ArticleVaultResolutionPlan altered = rootDrift
            ? fixture.ReadFixture.Resolution with
            {
                RootManifestSha256 = Digest
            }
            : fixture.ReadFixture.Resolution with
            {
                Binding = fixture.ReadFixture.Resolution.Binding with
                {
                    PlanCandidateIdentity = "other-plan"
                }
            };
        altered = altered with
        {
            ContentSha256 = ArticleVaultResolutionPlanner.ComputeContentSha256(altered)
        };
        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
            () => fixture.ReadFixture.Reader.ReadAcceptedSourceAsync(altered, fixture.ReadFixture.Operation,
                fixture.Tip.Sequence, fixture.Tip.ContentSha256, fixture.Adapter));
        Assert.Equal("article_vault_recovery_original_plan_binding_drift", error.Message);
        Assert.Equal(0, fixture.SourceReads);
        Assert.Equal(0, fixture.PermissionReads);
    }

    [Theory]
    [InlineData("before-denied")]
    [InlineData("after-denied")]
    [InlineData("session-drift")]
    public async Task PermissionRefusalOrDrift_PropagatesWithoutAcceptedSource(string mutation)
    {
        Fixture fixture = new("body\n"u8.ToArray());
        fixture.PermissionMutation = (snapshot, count) => mutation switch
        {
            "before-denied" when count == 1 => snapshot with { Status = AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable },
            "after-denied" when count == 2 => snapshot with { Status = AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable },
            "session-drift" when count == 2 => SealPermission(snapshot with { SessionRevision = new string('b', 64) }),
            _ => snapshot
        };
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal(mutation == "before-denied" ? 0 : 1, fixture.SourceReads);
        Assert.Equal(mutation == "before-denied" ? 1 : 2, fixture.PermissionReads);
    }

    [Fact]
    public async Task ResealedDifferentBytes_CannotReplaceAcceptedHistoricalPackage()
    {
        Fixture fixture = new("body\n"u8.ToArray());
        fixture.PackageMutation = package => RevisionComparePackageReadResult.Available(RevisionComparePackageSeal.Create(
            package.ArticleId, package.SourceKind, package.SourceIdentity, package.RevisionId, package.RevisionNo,
            null, null, "different\n"u8, package.Metadata, package.Snapshots));
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal(1, fixture.SourceReads);
        Assert.Equal(1, fixture.PermissionReads);
    }

    [Fact]
    public async Task TrustedSiteMismatch_PreservesHistoricalFactsButReleasesNoSource()
    {
        Fixture fixture = new("body\n"u8.ToArray(), trustedSite: "other-site");
        ArticleVaultRecoveryCheckpointSnapshot historical = await fixture.ReadFixture.Reader.ReadAsync(
            fixture.ReadFixture.Resolution, fixture.ReadFixture.Operation, fixture.Tip.Sequence, fixture.Tip.ContentSha256);
        Assert.Equal(fixture.Result.ContentSha256, historical.ServerResult!.ContentSha256);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal(0, fixture.SourceReads);
        Assert.Equal(0, fixture.PermissionReads);
    }

    [Fact]
    public async Task CancellationDuringHistoricalRead_ReleasesNoPartialAcceptedSource()
    {
        using CancellationTokenSource cancellation = new();
        Fixture fixture = new("body\n"u8.ToArray());
        fixture.PackageMutation = package =>
        {
            cancellation.Cancel();
            return RevisionComparePackageReadResult.Available(package);
        };
        await Assert.ThrowsAsync<OperationCanceledException>(() => fixture.ReadAsync(cancellation.Token));
        Assert.Equal(1, fixture.PermissionReads);
    }

    private static AuthorRecentArticleHistoryPermissionSnapshot SealPermission(AuthorRecentArticleHistoryPermissionSnapshot snapshot)
        => snapshot with
        {
            ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
        };

    // Port substitutes are test-only. The package is produced by the actual canonical revision reader;
    // the hash-linked history establishes controlled read behavior, not a durable recovery execution.
    private sealed class Fixture
    {
        internal ArticleVaultRecoveryCheckpointReaderTests.Fixture ReadFixture
        {
            get;
        }
        internal ArticleVaultAcceptedSourceAdapter Adapter
        {
            get;
        }
        internal ArticleVaultExecutionResult Result
        {
            get;
        }
        internal ArticleVaultOperationCheckpoint Tip
        {
            get; private set;
        }
        internal int SourceReads
        {
            get; private set;
        }
        internal int PermissionReads
        {
            get; private set;
        }
        internal RevisionCompareSourceSelector? Selector
        {
            get; private set;
        }
        internal Func<RevisionComparePackage, RevisionComparePackageReadResult>? PackageMutation
        {
            get; set;
        }
        internal Func<AuthorRecentArticleHistoryPermissionSnapshot, int, AuthorRecentArticleHistoryPermissionSnapshot>? PermissionMutation
        {
            get; set;
        }

        internal Fixture(byte[] source, bool accepted = true, string trustedSite = "site-one")
        {
            ReadFixture = ArticleVaultRecoveryCheckpointReaderTests.Create(source);
            Result = NoOpResult(ReadFixture.Bundle);
            ReadFixture.ExecutionStore.LoadResultAsync(Result.ResultReference, Arg.Any<CancellationToken>()).Returns(Result);
            Tip = ReadFixture.Checkpoint;
            if (accepted)
            {
                SetResultReference(new(Result.ResultReference, Result.ContentSha256));
            }

            IAuthoringRevisionCompareAuthority authority = Substitute.For<IAuthoringRevisionCompareAuthority>();
            authority.GetAuthorizedArticleAsync(Arg.Any<RevisionCompareReadContext>(), 101, Arg.Any<CancellationToken>())
                .Returns(new AuthoringRevisionCompareArticle(101, 4));
            authority.GetRevisionAsync(101, 4, Arg.Any<CancellationToken>()).Returns(
                new ArticleRevisionDetailResponse("4", 101, 900, "Title", Encoding.UTF8.GetString(source),
                    null, null, 1, [], "", "7", DateTime.UnixEpoch, null, null, true, null, null, null));
            var canonicalReader = new AuthoringRevisionComparePackageReader(authority,
                Substitute.For<IAuthoringRevisionCompareDraftContextAuthority>());
            IRevisionComparePackageReader reader = Substitute.For<IRevisionComparePackageReader>();
            reader.ReadAuthorizedAsync(Arg.Any<RevisionCompareReadContext>(), Arg.Any<int>(),
                Arg.Any<RevisionCompareSourceSelector>(), Arg.Any<CancellationToken>()).Returns(async call =>
            {
                SourceReads++;
                Selector = call.Arg<RevisionCompareSourceSelector>();
                RevisionComparePackageReadResult read = await canonicalReader.ReadAuthorizedAsync(
                    call.Arg<RevisionCompareReadContext>(), call.Arg<int>(), Selector, call.Arg<CancellationToken>());
                return read.Package is { } package && PackageMutation is not null ? PackageMutation(package) : read;
            });
            IAuthorRecentArticleHistoryPermissionProjectionProvider permissions = Substitute.For<IAuthorRecentArticleHistoryPermissionProjectionProvider>();
            permissions.ResolveAsync(Arg.Any<AuthorRecentArticleHistoryPermissionRequest>(), Arg.Any<CancellationToken>()).Returns(call =>
            {
                PermissionReads++;
                var request = call.Arg<AuthorRecentArticleHistoryPermissionRequest>();
                AuthorRecentArticleHistoryPermissionSnapshot snapshot = SealPermission(new(
                    AuthorRecentArticleHistoryPermissionSnapshotStatus.Current, request.Owner, Digest, Digest, Digest,
                    [new(101, true, true, Digest)], string.Empty));
                return Task.FromResult(PermissionMutation?.Invoke(snapshot, PermissionReads) ?? snapshot);
            });
            IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(
                new Dictionary<string, string?> { ["SITE_BASEURL"] = "https://site.example/" }).Build();
            Adapter = new(ReadFixture.ExecutionStore, reader, permissions, configuration, trustedSite);
        }

        internal Task<ArticleVaultRecoveryAcceptedSourceSnapshot> ReadAsync(CancellationToken cancellationToken = default)
            => ReadFixture.Reader.ReadAcceptedSourceAsync(ReadFixture.Resolution, ReadFixture.Operation,
                Tip.Sequence, Tip.ContentSha256, Adapter, cancellationToken);

        internal void SetResultReference(VaultOperationStageReference server)
        {
            var history = new List<ArticleVaultOperationCheckpoint> { ReadFixture.Checkpoint };
            Append(VaultOperationState.Validating, VaultServerCommitDisposition.NotStarted);
            Append(VaultOperationState.ExecutingServer, VaultServerCommitDisposition.Unknown);
            Append(VaultOperationState.MaterializingLocal, VaultServerCommitDisposition.Accepted, server);
            Append(VaultOperationState.RecoveryRequired, VaultServerCommitDisposition.Accepted, server);
            Tip = history[^1];
            ReadFixture.CheckpointStore.ReadThroughAsync(ReadFixture.Operation, ReadFixture.Bundle.Plan,
                Tip.Sequence, Tip.ContentSha256, Arg.Any<CancellationToken>()).Returns(history);

            void Append(VaultOperationState state, VaultServerCommitDisposition commit, VaultOperationStageReference? reference = null)
            {
                ArticleVaultOperationCheckpoint previous = history[^1];
                ArticleVaultOperationCheckpoint next = previous with
                {
                    Sequence = previous.Sequence + 1,
                    PreviousCheckpointSha256 = previous.ContentSha256,
                    RecordedAtUnixMs = previous.RecordedAtUnixMs + 1,
                    State = state,
                    ServerCommit = commit,
                    ServerResult = reference,
                    ReasonCode = state == VaultOperationState.RecoveryRequired ? "native_materialization_missing" : null
                };
                history.Add(next with
                {
                    ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(next)
                });
            }
        }

        private static ArticleVaultExecutionResult NoOpResult(ArticleVaultSealedExecutionBundle bundle)
        {
            VaultSyncPlanGroup group = bundle.Plan.Groups[0];
            VaultSyncPlanItem item = group.Items[0];
            string idempotency = ArticleVaultExecutionIntegrity.ComputeGroupIdempotency(bundle.Plan, group);
            ArticleVaultOperationResultReceipt operation = new(ArticleVaultExecutionSchemas.OperationReceipt, 1,
                bundle.Plan.SiteIdentity, bundle.Plan.VaultIdentity, bundle.PlanSha256, group.GroupIdentity, item.OperationIdentity,
                item.PortableArticleIdentity, item.Decision, ArticleVaultOperationOutcome.NoOp, 101, 4, 4,
                "article-service/noop", null, null, [], [], idempotency, item.Server.Source!.Sha256, null, string.Empty);
            operation = operation with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealOperationReceipt(operation)
            };
            ArticleVaultGroupResultReceipt receipt = new(ArticleVaultExecutionSchemas.GroupReceipt, 1,
                bundle.Plan.SiteIdentity, bundle.Plan.VaultIdentity, bundle.PlanSha256, group.GroupIdentity, idempotency,
                true, [operation], null, string.Empty);
            receipt = receipt with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealGroupReceipt(receipt)
            };
            ArticleVaultExecutionResult result = new(ArticleVaultExecutionSchemas.Result, 1, bundle.Plan.ResultCandidateIdentity,
                bundle.Plan.SiteIdentity, bundle.Plan.VaultIdentity, bundle.PlanReference, bundle.PlanSha256, bundle.Plan.IdempotencyKey,
                ArticleVaultExecutionOutcome.NoOp, [receipt], null, bundle.Plan.CreatedAtUnixMs + 1, string.Empty);
            return result with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealResult(result)
            };
        }
    }
}
