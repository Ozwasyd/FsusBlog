using System.Collections.Immutable;

using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultConflictReviewReaderTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task ActualScalarProposal_ProjectsCurrentEvidenceWithoutPromotingExecutionAdmission()
    {
        Fixture fixture = new();
        ArticleVaultResolutionPlanInput current = CreateScalarInput(fixture);
        ArticleVaultResolutionPlan proposal = Assert.IsType<ArticleVaultResolutionPlan>(ArticleVaultResolutionPlanner.Build(current).Plan);
        Assert.True(ArticleVaultResolutionPlanner.VerifyCurrent(proposal, current).IsValid);
        fixture.SetProposal(proposal);
        ArticleVaultConflictReviewSnapshot snapshot = await fixture.Reader.ReadAsync(
            new(proposal.ResolutionOperationIdentity, proposal.ContentSha256, null), fixture.Context, current);
        Assert.True(snapshot.CurrentValidation.IsValid);
        Assert.Same(current.Evidence, snapshot.CurrentEvidence);
        Assert.False(snapshot.ExecutionAdmission.IsValid);
        Assert.Equal("article_vault_resolution_canonical_execution_admission_missing", snapshot.ExecutionAdmission.ReasonCode);
        Assert.Null(snapshot.Checkpoint);
        Assert.Empty(fixture.Stored.CheckpointStore.ReceivedCalls());
        fixture.AssertNoWrites();
    }

    [Theory]
    [InlineData("git")]
    [InlineData("expiry")]
    [InlineData("local-bytes")]
    public async Task ActualProposalWithStaleCurrentInputs_RemainsHistoricalWithoutCurrentEvidence(string mutation)
    {
        Fixture fixture = new();
        ArticleVaultResolutionPlanInput input = CreateScalarInput(fixture);
        ArticleVaultResolutionPlan proposal = Assert.IsType<ArticleVaultResolutionPlan>(ArticleVaultResolutionPlanner.Build(input).Plan);
        fixture.SetProposal(proposal);
        ArticleVaultResolutionPlanInput current = mutation switch
        {
            "git" => input with { Git = input.Git with { ContentSha256 = new string('b', 64) } },
            "expiry" => input with { Metadata = input.Metadata with { Context = input.Metadata.Context with { NowUnixMs = input.ExpiresAtUnixMs + 1 } } },
            _ => input with { Metadata = input.Metadata with { LocalBytes = "{}"u8.ToArray() } }
        };
        ArticleVaultConflictReviewSnapshot snapshot = await fixture.Reader.ReadAsync(
            new(proposal.ResolutionOperationIdentity, proposal.ContentSha256, null), fixture.Context, current);
        Assert.Same(proposal, snapshot.Proposal);
        Assert.Equal(ArticleVaultResolutionPlanner.VerifyCurrent(proposal, current), snapshot.CurrentValidation);
        Assert.False(snapshot.CurrentValidation.IsValid);
        Assert.False(snapshot.ExecutionAdmission.IsValid);
        Assert.Null(snapshot.CurrentEvidence);
        fixture.AssertNoWrites();
    }

    [Fact]
    public async Task ExactHistoricalReview_PreservesCanonicalRefusalAndReadsOnlyRequestedReferences()
    {
        Fixture fixture = new();
        ArticleVaultConflictReviewSnapshot snapshot = await fixture.ReadAsync();
        Assert.Same(fixture.Stored.Resolution, snapshot.Proposal);
        Assert.Equal(ArticleVaultResolutionPlanner.VerifyCurrent(fixture.Stored.Resolution, fixture.Current), snapshot.CurrentValidation);
        Assert.Equal(ArticleVaultResolutionPlanner.RequireExecutionAdmission(fixture.Stored.Resolution, fixture.Current), snapshot.ExecutionAdmission);
        Assert.False(snapshot.CurrentValidation.IsValid);
        Assert.False(snapshot.ExecutionAdmission.IsValid);
        Assert.Null(snapshot.CurrentEvidence);
        Assert.Equal("article_vault_resolution_stale_git_facts", snapshot.CurrentValidation.ReasonCode);
        Assert.Equal(fixture.Stored.Checkpoint, Assert.Single(snapshot.Checkpoint!.Checkpoints));
        Assert.Null(snapshot.Checkpoint.ServerResult);
        Assert.Null(snapshot.Checkpoint.MaterializationPreflight);
        Assert.Contains("native_conditional_write_and_readback", snapshot.Checkpoint.MissingCapabilities);
        Assert.Equal(2, fixture.PermissionRequests.Count);
        Assert.Same(fixture.PermissionRequests[0], fixture.PermissionRequests[1]);
        Assert.Equal(new AuthorRecentArticleHistoryOwner(7, "https://permission.example"), fixture.PermissionRequests[0].Owner);
        Assert.Equal([101], fixture.PermissionRequests[0].ArticleIds);
        Assert.Equal(fixture.PermissionDigest, snapshot.PermissionSnapshotSha256);
        await fixture.Proposals.Received(1).ReadExactAsync(fixture.Reference.ResolutionOperationIdentity,
            fixture.Reference.ProposalSha256, Arg.Any<CancellationToken>());
        await fixture.Stored.ExecutionStore.Received(2).LoadSealedAsync(fixture.Stored.Bundle.PlanReference,
            fixture.Stored.Bundle.PlanSha256, Arg.Any<CancellationToken>());
        await fixture.Stored.CheckpointStore.Received(1).ReadThroughAsync(fixture.Stored.Operation,
            fixture.Stored.Bundle.Plan, 0, fixture.Stored.Checkpoint.ContentSha256, Arg.Any<CancellationToken>());
        fixture.AssertNoWrites();
    }

    [Fact]
    public async Task ProposalOnlyReview_DoesNotLookUpAnImplicitCheckpoint()
    {
        Fixture fixture = new();
        ArticleVaultConflictReviewSnapshot snapshot = await fixture.Reader.ReadAsync(
            fixture.Reference with
            {
                Checkpoint = null
            }, fixture.Context, fixture.Current);
        Assert.Null(snapshot.Checkpoint);
        Assert.Empty(fixture.Stored.CheckpointStore.ReceivedCalls());
        await fixture.Stored.ExecutionStore.Received(1).LoadSealedAsync(fixture.Stored.Bundle.PlanReference,
            fixture.Stored.Bundle.PlanSha256, Arg.Any<CancellationToken>());
        fixture.AssertNoWrites();
    }

    [Theory]
    [InlineData("site")]
    [InlineData("vault")]
    [InlineData("device")]
    [InlineData("actor")]
    [InlineData("article")]
    [InlineData("current-site")]
    [InlineData("current-vault")]
    [InlineData("current-device")]
    public async Task UntrustedContext_IsRejectedBeforePermissionOrStorageReads(string mutation)
    {
        Fixture fixture = new();
        ArticleVaultConflictReviewContext context = mutation switch
        {
            "site" => fixture.Context with { SiteIdentity = "other-site" },
            "vault" => fixture.Context with { VaultIdentity = "other-vault" },
            "device" => fixture.Context with { DeviceIdentity = "other-device" },
            "actor" => fixture.Context with { AdminPrincipalId = 0 },
            "article" => fixture.Context with { ArticleId = 0 },
            _ => fixture.Context
        };
        ArticleVaultSyncPlan plan = fixture.Current.Metadata.Plan;
        plan = mutation switch
        {
            "current-site" => plan with { SiteIdentity = "other-site" },
            "current-vault" => plan with { VaultIdentity = "other-vault" },
            "current-device" => plan with { DeviceIdentity = "other-device" },
            _ => plan
        };
        await RejectedAsync("article_vault_conflict_review_context_mismatch", () => fixture.Reader.ReadAsync(
            fixture.Reference, context, fixture.Current with
            {
                Metadata = fixture.Current.Metadata with
                {
                    Plan = plan
                }
            }));
        fixture.AssertNoDataReads();
        Assert.Empty(fixture.Permissions.ReceivedCalls());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AuthenticatedDocumentMismatch_IsRejectedBeforeOriginalPlanRead(bool portableIdentity)
    {
        Fixture fixture = new();
        ArticleVaultConflictReviewContext context = portableIdentity
            ? fixture.Context with
            {
                PortableArticleIdentity = "other-article"
            }
            : fixture.Context with
            {
                ArticleId = 102
            };
        await RejectedAsync("article_vault_conflict_review_document_mismatch", () => fixture.Reader.ReadAsync(
            fixture.Reference, context, fixture.Current));
        Assert.Single(fixture.Proposals.ReceivedCalls());
        Assert.Empty(fixture.Stored.ExecutionStore.ReceivedCalls());
        Assert.Empty(fixture.Stored.CheckpointStore.ReceivedCalls());
    }

    [Theory]
    [InlineData("identity")]
    [InlineData("digest")]
    [InlineData("site")]
    [InlineData("vault")]
    [InlineData("device")]
    public async Task StructurallyResealedWrongProposal_CannotReplaceExactDocument(string mutation)
    {
        Fixture fixture = new();
        ArticleVaultResolutionPlan proposal = fixture.Stored.Resolution;
        proposal = mutation switch
        {
            "identity" => proposal with { ResolutionOperationIdentity = "other-resolution" },
            "digest" => proposal with { Confirmation = proposal.Confirmation with { ConfirmationIdentity = "other-confirmation" } },
            "site" => proposal with { Binding = proposal.Binding with { SiteIdentity = "other-site" } },
            "vault" => proposal with { Binding = proposal.Binding with { VaultIdentity = "other-vault" } },
            _ => proposal with { Binding = proposal.Binding with { DeviceIdentity = "other-device" } }
        };
        proposal = Seal(proposal);
        Assert.True(ArticleVaultResolutionPlanner.ValidateStructure(proposal).IsValid);
        fixture.SetProposal(proposal);
        ArticleVaultConflictReviewReference reference = mutation is "site" or "vault" or "device"
            ? fixture.Reference with
            {
                ProposalSha256 = proposal.ContentSha256
            }
            : fixture.Reference;
        await RejectedAsync("article_vault_conflict_review_document_mismatch", () => fixture.Reader.ReadAsync(
            reference, fixture.Context, fixture.Current));
        Assert.Empty(fixture.Stored.ExecutionStore.ReceivedCalls());
    }

    [Fact]
    public async Task OriginalPlanActorMismatch_IsRejectedBeforeCheckpointRead()
    {
        Fixture fixture = new();
        ArticleVaultSealedExecutionBundle bundle = fixture.Stored.Bundle with
        {
            AdminPrincipalId = 8
        };
        bundle = bundle with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle)
        };
        fixture.Stored.ExecutionStore.LoadSealedAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ArticleVaultSealedExecutionBundle?>(bundle));
        await RejectedAsync("article_vault_conflict_review_actor_mismatch", () => fixture.ReadAsync());
        Assert.Empty(fixture.Stored.CheckpointStore.ReceivedCalls());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task MissingExactProposalOrOriginalPlan_IsRejectedWithoutCheckpointRead(bool missingProposal)
    {
        Fixture fixture = new();
        if (missingProposal)
        {
            fixture.SetProposal(null);
        }
        else
        {
            fixture.Stored.ExecutionStore.LoadSealedAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<ArticleVaultSealedExecutionBundle?>(null));
        }
        await RejectedAsync(missingProposal ? "article_vault_conflict_review_proposal_missing"
            : "article_vault_conflict_review_original_plan_missing", () => fixture.ReadAsync());
        Assert.Empty(fixture.Stored.CheckpointStore.ReceivedCalls());
        fixture.AssertNoWrites();
    }

    [Theory]
    [InlineData("unavailable")]
    [InlineData("stale")]
    [InlineData("read-denied")]
    [InlineData("write-denied")]
    [InlineData("owner")]
    [InlineData("article")]
    [InlineData("extra-decision")]
    [InlineData("digest")]
    public async Task PermissionDeniedBeforeRead_ReleasesNoProposalOrCheckpoint(string mutation)
    {
        Fixture fixture = new();
        fixture.PermissionMutation = (snapshot, _) => MutatePermission(snapshot, mutation);
        await RejectedAsync("article_vault_conflict_review_permission_denied", () => fixture.ReadAsync());
        fixture.AssertNoDataReads();
        Assert.Single(fixture.PermissionRequests);
    }

    [Theory]
    [InlineData("revoked", "article_vault_conflict_review_permission_denied")]
    [InlineData("session", "article_vault_conflict_review_permission_changed")]
    [InlineData("permission", "article_vault_conflict_review_permission_changed")]
    [InlineData("site", "article_vault_conflict_review_permission_changed")]
    [InlineData("configuration", "article_vault_conflict_review_permission_changed")]
    public async Task PermissionRevokedOrChangedAfterRead_ReleasesNoSnapshot(string mutation, string reason)
    {
        Fixture fixture = new();
        fixture.PermissionMutation = (snapshot, count) =>
        {
            if (count != 2)
            {
                return snapshot;
            }
            if (mutation == "configuration")
            {
                fixture.Configuration["SITE_BASEURL"] = "https://other-permission.example/";
                return snapshot;
            }
            return SealPermission(mutation switch
            {
                "revoked" => snapshot with { Status = AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable },
                "session" => snapshot with { SessionRevision = new string('b', 64) },
                "permission" => snapshot with { PermissionRevision = new string('b', 64) },
                _ => snapshot with { SiteRevision = new string('b', 64) }
            });
        };
        await RejectedAsync(reason, () => fixture.ReadAsync());
        Assert.Equal(2, fixture.PermissionRequests.Count);
        Assert.Single(fixture.Stored.CheckpointStore.ReceivedCalls());
        fixture.AssertNoWrites();
    }

    [Theory]
    [InlineData("latest")]
    [InlineData("wrong-digest")]
    [InlineData("tampered-history")]
    public async Task InvalidExactCheckpoint_PropagatesCanonicalRejectionWithoutSnapshot(string mutation)
    {
        Fixture fixture = new();
        ArticleVaultConflictReviewCheckpointReference checkpoint = fixture.Reference.Checkpoint!;
        if (mutation == "tampered-history")
        {
            fixture.Stored.CheckpointStore.ReadThroughAsync(Arg.Any<ArticleVaultOperationIdentity>(), Arg.Any<ArticleVaultSyncPlan>(),
                Arg.Any<long>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<IReadOnlyList<ArticleVaultOperationCheckpoint>>(
                    [fixture.Stored.Checkpoint with { State = VaultOperationState.Synced }]));
        }
        else
        {
            checkpoint = checkpoint with
            {
                ContentSha256 = mutation == "latest" ? "latest" : new string('b', 64)
            };
            fixture.Stored.CheckpointStore.ReadThroughAsync(Arg.Any<ArticleVaultOperationIdentity>(), Arg.Any<ArticleVaultSyncPlan>(),
                Arg.Any<long>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<IReadOnlyList<ArticleVaultOperationCheckpoint>>([fixture.Stored.Checkpoint]));
        }
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Reader.ReadAsync(
            fixture.Reference with
            {
                Checkpoint = checkpoint
            }, fixture.Context, fixture.Current));
        Assert.Single(fixture.PermissionRequests);
        fixture.AssertNoWrites();
    }

    [Theory]
    [InlineData("before")]
    [InlineData("first-permission")]
    [InlineData("proposal")]
    [InlineData("checkpoint")]
    [InlineData("last-permission")]
    public async Task Cancellation_ReleasesNoPartialReviewSnapshot(string stage)
    {
        using CancellationTokenSource cancellation = new();
        Fixture fixture = new();
        if (stage == "before")
        {
            cancellation.Cancel();
        }
        fixture.PermissionMutation = (snapshot, count) =>
        {
            if (stage == "first-permission" && count == 1 || stage == "last-permission" && count == 2)
            {
                cancellation.Cancel();
            }
            return snapshot;
        };
        if (stage == "proposal")
        {
            fixture.Proposals.ReadExactAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(_ =>
                {
                    cancellation.Cancel();
                    return Task.FromCanceled<ArticleVaultResolutionPlan?>(cancellation.Token);
                });
        }
        if (stage == "checkpoint")
        {
            fixture.Stored.CheckpointStore.ReadThroughAsync(Arg.Any<ArticleVaultOperationIdentity>(), Arg.Any<ArticleVaultSyncPlan>(),
                Arg.Any<long>(), Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(_ =>
                {
                    cancellation.Cancel();
                    return Task.FromCanceled<IReadOnlyList<ArticleVaultOperationCheckpoint>>(cancellation.Token);
                });
        }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.ReadAsync(cancellation.Token));
        if (stage is "before" or "first-permission")
        {
            fixture.AssertNoDataReads();
        }
        fixture.AssertNoWrites();
    }

    private static async Task RejectedAsync(string reason, Func<Task<ArticleVaultConflictReviewSnapshot>> read)
        => Assert.Equal(reason, (await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(read)).Message);

    private static ArticleVaultResolutionPlan Seal(ArticleVaultResolutionPlan proposal)
        => proposal with
        {
            ContentSha256 = ArticleVaultResolutionPlanner.ComputeContentSha256(proposal)
        };

    private static ArticleVaultResolutionPlanInput CreateScalarInput(Fixture fixture)
    {
        ArticleVaultMetadataManifest baseline = new(ArticleVaultSchemas.MetadataManifest, 1, "site-one", "vault-one", "device-one",
            "article-one", "101", "base title", "base summary", "base-slug", Digest, Digest, string.Empty);
        baseline = baseline with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(baseline)
        };
        ArticleVaultMetadataManifest local = baseline with
        {
            Title = "local title"
        };
        local = local with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(local)
        };
        ArticleVaultMetadataManifest server = baseline with
        {
            Summary = "server summary"
        };
        server = server with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(server)
        };
        ArticleVaultArticleManifest originalArticle = fixture.Stored.Bundle.ArticleManifests[0];
        VaultArticleCoordinate ancestor = originalArticle.Coordinates.Base with
        {
            MetadataManifestSha256 = baseline.ContentSha256
        };
        ancestor = ancestor with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(ancestor)
        };
        VaultArticleCoordinate localCoordinate = ancestor with
        {
            MetadataManifestSha256 = local.ContentSha256
        };
        localCoordinate = localCoordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(localCoordinate)
        };
        VaultArticleCoordinate serverCoordinate = ancestor with
        {
            ServerRevision = 5,
            MetadataManifestSha256 = server.ContentSha256
        };
        serverCoordinate = serverCoordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(serverCoordinate)
        };
        ArticleVaultArticleManifest article = originalArticle with
        {
            Coordinates = new(ancestor, localCoordinate, ancestor)
        };
        article = article with
        {
            State = ArticleVaultStateMachine.Derive(article)
        };
        article = article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
        ArticleVaultRootManifest root = fixture.Stored.Bundle.RootManifest with
        {
            Articles = [fixture.Stored.Bundle.RootManifest.Articles[0] with { ManifestSha256 = article.ContentSha256 }]
        };
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        ArticleVaultServerObservation observation = fixture.Stored.Bundle.PlannedObservations[0] with
        {
            ServerCoordinate = serverCoordinate
        };
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        long now = fixture.Stored.Bundle.Plan.CreatedAtUnixMs;
        ArticleVaultSyncPlan plan = Assert.IsType<ArticleVaultSyncPlan>(ArticleVaultSyncPlanner.Build(new(root, [article], [observation],
            [new("group-one", ["article-one"], [])], VaultSyncDirection.Sync, now, now + 60_000, false)).Plan);
        Assert.Equal(VaultSyncPlanStatus.Blocked, plan.Status);
        VaultSyncPlanItem item = plan.Groups[0].Items[0];
        VaultConflictBinding binding = new(plan.SiteIdentity, plan.VaultIdentity, plan.DeviceIdentity, item.PortableArticleIdentity,
            item.ServerArticleIdentity, plan.PlanCandidateIdentity, plan.ContentSha256, item.GroupIdentity, item.OperationIdentity,
            article.ContentSha256, observation.ContentSha256, new(item.Base, item.Local, item.Server));
        ArticleVaultScalarMetadataInput metadata = new(plan, root, [article], [observation], new(now, VaultSyncDirection.Sync, false), binding,
            ArticleVaultManifestCodec.Serialize(baseline), ArticleVaultManifestCodec.Serialize(local), ArticleVaultManifestCodec.Serialize(server));
        ArticleVaultScalarMetadataCandidate candidate = Assert.IsType<ArticleVaultScalarMetadataCandidate>(ArticleVaultScalarMetadataMerge.Build(metadata).Candidate);
        VaultConflictRegistryEntry entry = ArticleVaultConflictRegistry.Find(VaultConflictType.MetadataDisjoint)!;
        ArticleVaultConflictEvidence evidence = new(ArticleVaultConflictSchemas.Evidence, 1, ArticleVaultConflictRegistry.ContentSha256,
            binding, [new(entry.Type, entry.Disposition, entry.AllowedActions, new(entry.Type, null, candidate.Facts, null))], string.Empty);
        evidence = evidence with
        {
            ContentSha256 = ArticleVaultConflictCodec.ComputeContentSha256(evidence)
        };
        ArticleVaultGitFacts git = fixture.Current.Git with
        {
            Scope = fixture.Current.Git.Scope with
            {
                RootManifestSha256 = root.ContentSha256
            }
        };
        git = git with
        {
            ContentSha256 = ArticleVaultGitFactDecoder.ComputeContentSha256(git)
        };
        ArticleVaultSealedExecutionBundle bundle = fixture.Stored.Bundle with
        {
            Plan = plan,
            PlanReference = plan.PlanCandidateIdentity,
            PlanSha256 = plan.ContentSha256,
            RootManifest = root,
            ArticleManifests = [article],
            PlannedObservations = [observation]
        };
        bundle = bundle with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle)
        };
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        fixture.Stored.ExecutionStore.LoadSealedAsync(plan.PlanCandidateIdentity, plan.ContentSha256, Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ArticleVaultSealedExecutionBundle?>(bundle));
        return new(metadata, evidence, git, [new(entry.Type, VaultConflictAction.PrepareMetadataCandidate, entry.Disposition, candidate.ContentSha256)],
            candidate, fixture.Stored.Resolution.Confirmation, fixture.Stored.Resolution.ExpiresAtUnixMs);
    }

    private static AuthorRecentArticleHistoryPermissionSnapshot SealPermission(AuthorRecentArticleHistoryPermissionSnapshot snapshot)
        => snapshot with
        {
            ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
        };

    private static AuthorRecentArticleHistoryPermissionSnapshot MutatePermission(
        AuthorRecentArticleHistoryPermissionSnapshot snapshot, string mutation)
    {
        AuthorRecentArticleHistoryPermissionSnapshot altered = mutation switch
        {
            "unavailable" => snapshot with { Status = AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable },
            "stale" => snapshot with { Status = AuthorRecentArticleHistoryPermissionSnapshotStatus.Stale },
            "read-denied" => snapshot with { Decisions = [snapshot.Decisions[0] with { CanProject = false }] },
            "write-denied" => snapshot with { Decisions = [snapshot.Decisions[0] with { CanWrite = false }] },
            "owner" => snapshot with { Owner = snapshot.Owner with { AdminPrincipalId = 8 } },
            "article" => snapshot with { Decisions = [snapshot.Decisions[0] with { ArticleId = 102 }] },
            "extra-decision" => snapshot with { Decisions = [.. snapshot.Decisions, new(102, true, true, Digest)] },
            _ => snapshot
        };
        return mutation == "digest" ? altered with
        {
            ContentDigest = new string('b', 64)
        } : SealPermission(altered);
    }

    // Controlled unit collaborators reuse the upstream structurally sealed historical fixture.
    // Its proposal is not an executable resolution proof; actual current validation must reject it.
    private sealed class Fixture
    {
        internal ArticleVaultRecoveryCheckpointReaderTests.Fixture Stored { get; } = ArticleVaultRecoveryCheckpointReaderTests.Create();
        internal IArticleVaultResolutionProposalStore Proposals { get; } = Substitute.For<IArticleVaultResolutionProposalStore>();
        internal IAuthorRecentArticleHistoryPermissionProjectionProvider Permissions { get; } = Substitute.For<IAuthorRecentArticleHistoryPermissionProjectionProvider>();
        internal IConfiguration Configuration
        {
            get;
        } = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["SITE_BASEURL"] = "https://permission.example/" }).Build();
        internal List<AuthorRecentArticleHistoryPermissionRequest> PermissionRequests { get; } = [];
        internal Func<AuthorRecentArticleHistoryPermissionSnapshot, int, AuthorRecentArticleHistoryPermissionSnapshot>? PermissionMutation
        {
            get; set;
        }
        internal string? PermissionDigest
        {
            get; private set;
        }
        internal ArticleVaultConflictReviewReader Reader
        {
            get;
        }
        internal ArticleVaultConflictReviewReference Reference
        {
            get;
        }
        internal ArticleVaultConflictReviewContext Context { get; } = new(7, "site-one", "vault-one", "device-one", 101, "article-one");
        internal ArticleVaultResolutionPlanInput Current
        {
            get;
        }

        internal Fixture()
        {
            SetProposal(Stored.Resolution);
            Permissions.ResolveAsync(Arg.Any<AuthorRecentArticleHistoryPermissionRequest>(), Arg.Any<CancellationToken>()).Returns(call =>
            {
                var request = call.Arg<AuthorRecentArticleHistoryPermissionRequest>();
                PermissionRequests.Add(request);
                AuthorRecentArticleHistoryPermissionSnapshot snapshot = SealPermission(new(
                    AuthorRecentArticleHistoryPermissionSnapshotStatus.Current, request.Owner, Digest, Digest, Digest,
                    [new(request.ArticleIds.Single(), true, true, Digest)], string.Empty));
                snapshot = PermissionMutation?.Invoke(snapshot, PermissionRequests.Count) ?? snapshot;
                PermissionDigest = snapshot.ContentDigest;
                return Task.FromResult(snapshot);
            });
            Reference = new(Stored.Resolution.ResolutionOperationIdentity, Stored.Resolution.ContentSha256,
                new(Stored.Operation, Stored.Checkpoint.Sequence, Stored.Checkpoint.ContentSha256));
            ArticleVaultSealedExecutionBundle bundle = Stored.Bundle;
            ArticleVaultScalarMetadataInput metadata = new(bundle.Plan, bundle.RootManifest, bundle.ArticleManifests, bundle.PlannedObservations,
                new(bundle.Plan.CreatedAtUnixMs, bundle.Plan.Direction, false), Stored.Resolution.Binding,
                ReadOnlyMemory<byte>.Empty, ReadOnlyMemory<byte>.Empty, ReadOnlyMemory<byte>.Empty);
            ArticleVaultConflictEvidence evidence = new(ArticleVaultConflictSchemas.Evidence, 1,
                ArticleVaultConflictRegistry.ContentSha256, Stored.Resolution.Binding, [], string.Empty);
            evidence = evidence with
            {
                ContentSha256 = ArticleVaultConflictCodec.ComputeContentSha256(evidence)
            };
            ImmutableArray<VaultGitSourceFacts> sources = [new("article-one", bundle.ArticleManifests[0].Coordinates.Local.Source!.Sha256, [])];
            ArticleVaultGitFacts git = new(ArticleVaultGitFactDecoder.Schema, 1,
                new("site-one", "vault-one", "device-one", "agent-one", Digest, bundle.RootManifest.ContentSha256, VaultPathComparisonPolicy.Ordinal),
                VaultGitAvailability.NotPresent, "git-not-present", null, null, null, null, null, null, null, [], sources,
                ArticleVaultGitFactDecoder.ComputeWorktreeSha256(sources), ArticleVaultGitFactDecoder.ComputeOperationSha256([]), string.Empty);
            git = git with
            {
                ContentSha256 = ArticleVaultGitFactDecoder.ComputeContentSha256(git)
            };
            Assert.True(ArticleVaultGitFactDecoder.Validate(git).IsValid);
            Current = new(metadata, evidence, git, Stored.Resolution.Decisions, null,
                Stored.Resolution.Confirmation, Stored.Resolution.ExpiresAtUnixMs);
            Reader = new(Proposals, Stored.ExecutionStore, Stored.Reader, Permissions, Configuration, "site-one");
        }

        internal void SetProposal(ArticleVaultResolutionPlan? proposal)
            => Proposals.ReadExactAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(Task.FromResult(proposal));

        internal Task<ArticleVaultConflictReviewSnapshot> ReadAsync(CancellationToken cancellationToken = default)
            => Reader.ReadAsync(Reference, Context, Current, cancellationToken);

        internal void AssertNoDataReads()
        {
            Assert.Empty(Proposals.ReceivedCalls());
            Assert.Empty(Stored.ExecutionStore.ReceivedCalls());
            Assert.Empty(Stored.CheckpointStore.ReceivedCalls());
        }

        internal void AssertNoWrites()
        {
            Assert.DoesNotContain(Proposals.ReceivedCalls(), call => call.GetMethodInfo().Name != nameof(IArticleVaultResolutionProposalStore.ReadExactAsync));
            Assert.DoesNotContain(Stored.ExecutionStore.ReceivedCalls(), call => call.GetMethodInfo().Name is not ("LoadSealedAsync" or "LoadResultAsync"));
            Assert.DoesNotContain(Stored.CheckpointStore.ReceivedCalls(), call => call.GetMethodInfo().Name != "ReadThroughAsync");
        }
    }
}
