using System.Text;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultDependencyExecutionPreflightTests
{
    private const string Article = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly ArticleEmbedResolutionBudgetLimits s_budgets = new(8, 64, 1_048_576, 60_000, 128);

    [Fact]
    public void RealCanonicalSourceOnlyPlanAndPayloadPassTheZeroWriteGate()
    {
        Scenario scenario = CreateScenario();
        Assert.True(Verify(scenario).IsValid);
    }

    [Fact]
    public async Task AcceptedSourceStageReadsExactRevisionWithoutGrantingTerminalOrBaseCommit()
    {
        Scenario scenario = CreateScenario();
        ArticleVaultExecutionResult result = AcceptedResult(scenario.Bundle);
        IArticleVaultExecutionStore store = Substitute.For<IArticleVaultExecutionStore>();
        store.LoadSealedAsync(scenario.Bundle.PlanReference, scenario.Bundle.PlanSha256, Arg.Any<CancellationToken>())
            .Returns(scenario.Bundle);
        store.LoadResultAsync(result.ResultReference, Arg.Any<CancellationToken>()).Returns(result);
        IAuthoringRevisionCompareAuthority revisionAuthority = Substitute.For<IAuthoringRevisionCompareAuthority>();
        revisionAuthority.GetAuthorizedArticleAsync(Arg.Any<RevisionCompareReadContext>(), 42, Arg.Any<CancellationToken>())
            .Returns(new AuthoringRevisionCompareArticle(42, 9));
        revisionAuthority.GetRevisionAsync(42, 9, Arg.Any<CancellationToken>()).Returns(
            new ArticleRevisionDetailResponse("9", 42, 900, "Title", "content\n", null, null, 1, [], "", "7",
                DateTime.UnixEpoch, null, null, true, null, null, null));
        IAuthorRecentArticleHistoryPermissionProjectionProvider permissions =
            Substitute.For<IAuthorRecentArticleHistoryPermissionProjectionProvider>();
        permissions.ResolveAsync(Arg.Any<AuthorRecentArticleHistoryPermissionRequest>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                AuthorRecentArticleHistoryPermissionRequest permission = call.Arg<AuthorRecentArticleHistoryPermissionRequest>();
                var snapshot = new AuthorRecentArticleHistoryPermissionSnapshot(
                    AuthorRecentArticleHistoryPermissionSnapshotStatus.Current, permission.Owner,
                    Digest, Digest, Digest, [new(42, true, true, Digest)], string.Empty);
                return Task.FromResult(snapshot with
                {
                    ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
                });
            });
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["SITE_BASEURL"] = "https://site.example/" }).Build();
        var reader = new AuthoringRevisionComparePackageReader(revisionAuthority,
            Substitute.For<IAuthoringRevisionCompareDraftContextAuthority>());
        var adapter = new ArticleVaultAcceptedSourceAdapter(store, reader, permissions, configuration, scenario.Bundle.Plan.SiteIdentity);
        var stage = new ArticleVaultDependencyAcceptedSourceStage(store, adapter,
            new StageTimeProvider(scenario.Bundle.Plan.CreatedAtUnixMs));
        ArticleVaultOperationIdentity operation = ArticleVaultOperationVerifier.Bind(scenario.Bundle.Plan,
            "agent:primary", Digest, Digest, scenario.Bundle.Plan.ExpiresAtUnixMs);
        ArticleVaultDependencyAcceptedSources read = await stage.ReadAsync(scenario.Bundle, scenario.Extension,
            scenario.Request, scenario.Context, scenario.Inputs, s_budgets, operation, result.ResultReference, result.ContentSha256);
        ArticleVaultAcceptedSource source = Assert.Single(read.Sources);
        Assert.Equal(scenario.Inputs[0].SourceBytes.ToArray(), source.Package.RawMarkdown.ToArray());
        Assert.Equal(9, source.Package.RevisionId);
        Assert.Equal(900, source.Package.RevisionNo);
        Assert.Equal(scenario.Extension.ContentSha256, read.DependencyPlanSha256);
        Assert.False(read.CanCommitBase);
        Assert.False(read.HasVerifiedTerminalReceipt);
        await store.DidNotReceiveWithAnyArgs().SaveResultAsync(default!, default);
        await permissions.Received(2).ResolveAsync(Arg.Any<AuthorRecentArticleHistoryPermissionRequest>(), Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RejectedDependencyOrExpiredOperationStopsBeforeReadingAcceptedResult(bool expired)
    {
        Scenario scenario = CreateScenario();
        IArticleVaultExecutionStore store = Substitute.For<IArticleVaultExecutionStore>();
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["SITE_BASEURL"] = "https://site.example/" }).Build();
        var adapter = new ArticleVaultAcceptedSourceAdapter(store, Substitute.For<IRevisionComparePackageReader>(),
            Substitute.For<IAuthorRecentArticleHistoryPermissionProjectionProvider>(), configuration, scenario.Bundle.Plan.SiteIdentity);
        var stage = new ArticleVaultDependencyAcceptedSourceStage(store, adapter,
            new StageTimeProvider(expired ? scenario.Bundle.Plan.ExpiresAtUnixMs + 1 : scenario.Bundle.Plan.CreatedAtUnixMs));
        ArticleVaultOperationIdentity operation = ArticleVaultOperationVerifier.Bind(scenario.Bundle.Plan,
            "agent:primary", Digest, Digest, scenario.Bundle.Plan.ExpiresAtUnixMs);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => stage.ReadAsync(scenario.Bundle,
            expired ? scenario.Extension : scenario.Extension with
            {
                ContentSha256 = Digest
            }, scenario.Request, scenario.Context, scenario.Inputs, s_budgets, operation, "result:exact", Digest));
        await store.DidNotReceiveWithAnyArgs().LoadResultAsync(default!, default);
        await store.DidNotReceiveWithAnyArgs().LoadSealedAsync(default!, default!, default);
    }

    [Fact]
    public async Task ResolutionReadRefusesAnUnboundOriginalPlanBeforeStoreAccess()
    {
        Scenario scenario = CreateScenario();
        IArticleVaultResolutionProposalStore store = Substitute.For<IArticleVaultResolutionProposalStore>();
        var stage = new ArticleVaultDependencyResolutionStage(store, new StageTimeProvider(scenario.Bundle.Plan.CreatedAtUnixMs));
        var current = new ArticleVaultResolutionPlanInput(null!, null!, null!, [], null,
            new VaultResolutionConfirmation("confirmation:unit", "actor:unit", scenario.Bundle.Plan.CreatedAtUnixMs),
            scenario.Bundle.Plan.ExpiresAtUnixMs);
        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() =>
            stage.ReadExactAsync(scenario.Bundle, "resolution-" + Digest, Digest, current));
        Assert.Equal("article_vault_dependency_resolution_original_plan_mismatch", error.ReasonCode);
        await store.DidNotReceiveWithAnyArgs().ReadExactAsync(default!, default!, default);
    }

    [Fact]
    public async Task ResolutionReadLooksUpOnlyTheExactProposalAndNeverFallsBack()
    {
        Scenario scenario = CreateScenario();
        IArticleVaultResolutionProposalStore store = Substitute.For<IArticleVaultResolutionProposalStore>();
        var stage = new ArticleVaultDependencyResolutionStage(store, new StageTimeProvider(scenario.Bundle.Plan.CreatedAtUnixMs));
        var metadata = new ArticleVaultScalarMetadataInput(scenario.Bundle.Plan, scenario.Bundle.RootManifest,
            scenario.Bundle.ArticleManifests, scenario.Bundle.PlannedObservations, scenario.Context, null!,
            ReadOnlyMemory<byte>.Empty, ReadOnlyMemory<byte>.Empty, ReadOnlyMemory<byte>.Empty);
        var current = new ArticleVaultResolutionPlanInput(metadata, null!, null!, [], null,
            new VaultResolutionConfirmation("confirmation:unit", "actor:unit", scenario.Bundle.Plan.CreatedAtUnixMs),
            scenario.Bundle.Plan.ExpiresAtUnixMs);
        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() =>
            stage.ReadExactAsync(scenario.Bundle, "resolution-" + Digest, Digest, current));
        Assert.Equal("article_vault_dependency_resolution_proposal_missing", error.ReasonCode);
        await store.Received(1).ReadExactAsync("resolution-" + Digest, Digest, Arg.Any<CancellationToken>());
        await store.DidNotReceiveWithAnyArgs().SealAsync(default!, default!, default);
    }

    private static ArticleVaultExecutionResult AcceptedResult(ArticleVaultSealedExecutionBundle bundle)
    {
        VaultSyncPlanGroup group = Assert.Single(bundle.Plan.Groups);
        VaultSyncPlanItem item = Assert.Single(group.Items);
        string idempotency = ArticleVaultExecutionIntegrity.ComputeGroupIdempotency(bundle.Plan, group);
        var receipt = new ArticleVaultOperationResultReceipt(ArticleVaultExecutionSchemas.OperationReceipt,
            ArticleVaultExecutionSchemas.Version, bundle.Plan.SiteIdentity, bundle.Plan.VaultIdentity, bundle.PlanSha256,
            group.GroupIdentity, item.OperationIdentity, item.PortableArticleIdentity, item.Decision,
            ArticleVaultOperationOutcome.Executed, 42, 8, 9, "article-service:42:9", "01991e729a2c7b608f47b339f58e4a11", Digest,
            item.DependsOnOperationIdentities, [], idempotency, bundle.Payload.Items[0].SourceSha256, null, string.Empty);
        receipt = receipt with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealOperationReceipt(receipt)
        };
        var groupReceipt = new ArticleVaultGroupResultReceipt(ArticleVaultExecutionSchemas.GroupReceipt,
            ArticleVaultExecutionSchemas.Version, bundle.Plan.SiteIdentity, bundle.Plan.VaultIdentity, bundle.PlanSha256,
            group.GroupIdentity, idempotency, true, [receipt], null, string.Empty);
        groupReceipt = groupReceipt with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealGroupReceipt(groupReceipt)
        };
        var result = new ArticleVaultExecutionResult(ArticleVaultExecutionSchemas.Result, ArticleVaultExecutionSchemas.Version,
            bundle.Plan.ResultCandidateIdentity, bundle.Plan.SiteIdentity, bundle.Plan.VaultIdentity, bundle.PlanReference,
            bundle.PlanSha256, bundle.Plan.IdempotencyKey, ArticleVaultExecutionOutcome.Completed, [groupReceipt], null,
            bundle.Plan.CreatedAtUnixMs, string.Empty);
        result = result with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealResult(result)
        };
        ArticleVaultExecutionIntegrity.VerifyResult(bundle, result);
        return result;
    }

    private sealed class StageTimeProvider(long now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.FromUnixTimeMilliseconds(now);
    }

    [Fact]
    public void ReadyPullUpdateCannotUseGraphOrBytesFromTheSavedServerCoordinate()
    {
        Scenario scenario = CreateScenario();
        VaultArticleCoordinate saved = scenario.Request.ArticleManifests[0].Coordinates.Local;
        var savedCoordinates = new VaultArticleCoordinates(saved, saved, saved);
        ArticleVaultArticleManifest article = scenario.Request.ArticleManifests[0] with
        {
            Coordinates = savedCoordinates,
            State = VaultArticleState.Clean
        };
        article = article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
        ArticleVaultRootManifest root = scenario.Request.RootManifest with
        {
            Articles = [scenario.Request.RootManifest.Articles[0] with
            {
                ManifestSha256 = article.ContentSha256
            }]
        };
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        PortableDependencyManifest oldGraph = PortableDependencyCodec.Seal(scenario.Inputs[0].Manifest with
        {
            SourceSide = VaultDependencySourceSide.Server,
            Coordinates = savedCoordinates
        });
        Assert.True(PortableDependencyVerifier.ValidateStructure(oldGraph).IsValid);

        byte[] freshBytes = Encoding.UTF8.GetBytes("fresh remote source\n");
        VaultArticleCoordinate fresh = Seal(saved with
        {
            ServerRevision = 9,
            Source = ArticleVaultManifestCodec.CaptureSourceBytes(freshBytes)
        });
        PortableDependencyManifest freshGraph = oldGraph with
        {
            Source = fresh.Source!,
            Coordinates = new VaultArticleCoordinates(saved, saved, fresh)
        };
        string graphSha256 = PortableDependencyCodec.GraphDigest(freshGraph);
        fresh = Seal(fresh with
        {
            DependencySha256 = graphSha256
        });
        freshGraph = PortableDependencyCodec.Seal(freshGraph with
        {
            Coordinates = new VaultArticleCoordinates(saved, saved, fresh),
            GraphSha256 = graphSha256
        });
        ArticleVaultServerObservation observation = scenario.Request.ServerObservations[0] with
        {
            ServerCoordinate = fresh
        };
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        ArticleVaultPlanRequest request = scenario.Request with
        {
            RootManifest = root,
            ArticleManifests = [article],
            ServerObservations = [observation],
            Direction = VaultSyncDirection.Pull
        };
        ArticleVaultPlanVerificationContext context = scenario.Context with
        {
            Direction = request.Direction
        };
        ArticleVaultPlanBuildResult built = ArticleVaultSyncPlanner.Build(request);
        Assert.True(built.IsSuccess, string.Join(',', built.Errors));
        ArticleVaultSyncPlan plan = built.Plan!;
        Assert.Equal(VaultSyncPlanStatus.Ready, plan.Status);
        Assert.Equal(VaultSyncDecision.PullUpdate, Assert.Single(Assert.Single(plan.Groups).Items).Decision);
        VaultDependencyPlanInput[] freshInputs = [new(freshGraph, freshBytes, [], [], Digest)];
        VaultDependencyPlanBuildResult freshDependencies = ArticleVaultDependencyPlanner.Build(
            plan, request, context, freshInputs, s_budgets);
        Assert.NotNull(freshDependencies.Plan);
        Assert.True(ArticleVaultDependencyPlanner.VerifyCurrent(freshDependencies.Plan,
            plan, request, context, freshInputs, s_budgets).IsValid);

        VaultDependencyPlanInput[] staleInputs = [new(oldGraph, scenario.Inputs[0].SourceBytes, [], [], Digest)];
        Assert.Null(ArticleVaultDependencyPlanner.Build(plan, request, context, staleInputs, s_budgets).Plan);
        Assert.False(ArticleVaultDependencyPlanner.VerifyCurrent(freshDependencies.Plan,
            plan, request, context, staleInputs, s_budgets).IsValid);

        ArticleVaultDependencyPlan legacy = freshDependencies.Plan! with
        {
            Items = [Assert.Single(freshDependencies.Plan.Items) with
            {
                Manifest = oldGraph
            }],
            ContentSha256 = string.Empty
        };
        legacy = legacy with
        {
            ContentSha256 = PortableDependencyCodec.PlanDigest(legacy)
        };
        Assert.True(ArticleVaultDependencyPlanner.ValidateStructure(legacy).IsValid);
        Assert.False(ArticleVaultDependencyPlanner.VerifyCurrent(legacy,
            plan, request, context, freshInputs, s_budgets).IsValid);
        Assert.False(ArticleVaultDependencyPlanner.VerifyCurrent(legacy,
            plan, request, context, staleInputs, s_budgets).IsValid);
    }

    [Fact]
    public void MissingOrTamperedExtensionNeverAdmitsTheArticlePayload()
    {
        Scenario scenario = CreateScenario();
        Assert.False(ArticleVaultDependencyExecutionPreflight.Verify(scenario.Bundle, null,
            scenario.Request, scenario.Context, scenario.Inputs, s_budgets).IsValid);
        Assert.False(Verify(scenario with
        {
            Extension = scenario.Extension with
            {
                ContentSha256 = Digest
            }
        }).IsValid);
    }

    [Fact]
    public void DifferentBundleMembershipAndStaleSourceAreRejected()
    {
        Scenario scenario = CreateScenario();
        Assert.Equal("article_vault_dependency_bundle_binding_mismatch", Verify(scenario with
        {
            Request = scenario.Request with
            {
                ArticleManifests = []
            }
        }).ReasonCode);
        Assert.False(Verify(scenario with
        {
            Inputs = [scenario.Inputs[0] with
            {
                SourceBytes = Encoding.UTF8.GetBytes("changed\n")
            }]
        }).IsValid);
    }

    [Fact]
    public void ResealedBundleCannotReuseAValidRootDigestForDifferentManifestBytes()
    {
        Scenario scenario = CreateScenario();
        ArticleVaultSealedExecutionBundle tampered = scenario.Bundle with
        {
            RootManifest = scenario.Bundle.RootManifest with
            {
                DeviceIdentity = "device:other"
            }
        };
        tampered = tampered with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(tampered)
        };
        Assert.False(Verify(scenario with
        {
            Bundle = tampered
        }).IsValid);
    }

    [Fact]
    public void ExpiredPlanAndPayloadContentTamperAreRejected()
    {
        Scenario scenario = CreateScenario();
        Assert.False(Verify(scenario with
        {
            Context = scenario.Context with
            {
                NowUnixMs = scenario.Bundle.Plan.ExpiresAtUnixMs + 1
            }
        }).IsValid);
        ArticleVaultExecutionPayloadItem item = scenario.Bundle.Payload.Items[0];
        Assert.False(Verify(scenario with
        {
            Bundle = scenario.Bundle with
            {
                Payload = scenario.Bundle.Payload with
                {
                    Items = [item with
                    {
                        Content = "tampered"
                    }]
                }
            }
        }).IsValid);
    }

    private static ArticleVaultValidationResult Verify(Scenario scenario)
        => ArticleVaultDependencyExecutionPreflight.Verify(scenario.Bundle, scenario.Extension,
            scenario.Request, scenario.Context, scenario.Inputs, s_budgets);

    private static Scenario CreateScenario()
    {
        byte[] bytes = Encoding.UTF8.GetBytes("content\n");
        VaultArticleCoordinate server = Seal(new VaultArticleCoordinate(
            ArticleVaultSchemas.Coordinate, ArticleVaultSchemas.Version, true, false, 8,
            ArticleVaultManifestCodec.CaptureSourceBytes(Encoding.UTF8.GetBytes("base\n")),
            Digest, Digest, "draft", Digest, string.Empty));
        VaultArticleCoordinate local = Seal(server with
        {
            Source = ArticleVaultManifestCodec.CaptureSourceBytes(bytes)
        });
        var binding = new VaultDependencyBinding("site:primary", "vault:primary", Article);
        var graph = new PortableDependencyManifest(PortableDependencySchemas.Manifest, PortableDependencySchemas.Version,
            binding, "042", new VaultArticleCoordinates(server, local, server), VaultDependencySourceSide.Local,
            local.Source!, Digest, [], [], string.Empty, string.Empty);
        string graphSha256 = PortableDependencyCodec.GraphDigest(graph);
        local = Seal(local with
        {
            DependencySha256 = graphSha256
        });
        var coordinates = new VaultArticleCoordinates(server, local, server);
        graph = PortableDependencyCodec.Seal(graph with
        {
            Coordinates = coordinates,
            GraphSha256 = graphSha256
        });
        const string Path = "articles/source.md";
        var article = new ArticleVaultArticleManifest(ArticleVaultSchemas.ArticleManifest, ArticleVaultSchemas.Version,
            binding.SiteIdentity, binding.VaultIdentity, "device:primary", Article, "042",
            new VaultPathProjection(Path, ArticleVaultManifestCodec.ComputeProjectionSha256(Path)), coordinates,
            new VaultOperationWatermarks(0, null, null, null, null, null, null), VaultArticleState.LocalModified, string.Empty);
        article = article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
        var root = new ArticleVaultRootManifest(ArticleVaultSchemas.RootManifest, ArticleVaultSchemas.Version,
            ArticleVaultSchemas.ControlTreeVersion,
            new VaultControlTree(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            binding.SiteIdentity, binding.VaultIdentity, article.DeviceIdentity,
            [new VaultArticleReference(Article, $"{ArticleVaultSchemas.ArticleManifestDirectory}/{Article}.json", article.ContentSha256, Path)], [], string.Empty);
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        var observation = new ArticleVaultServerObservation(ArticleVaultPlanSchemas.ServerObservation, ArticleVaultPlanSchemas.Version,
            binding.SiteIdentity, binding.VaultIdentity, article.DeviceIdentity, Article, "042", server, string.Empty);
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        const long Now = 1_800_000_000_000;
        var request = new ArticleVaultPlanRequest(root, [article], [observation],
            [new VaultPlanGroupRequest("group:primary", [Article], [])], VaultSyncDirection.Sync, Now, Now + 60_000, false);
        var context = new ArticleVaultPlanVerificationContext(Now, request.Direction, false);
        ArticleVaultPlanBuildResult built = ArticleVaultSyncPlanner.Build(request);
        Assert.True(built.IsSuccess, string.Join(',', built.Errors));
        ArticleVaultSyncPlan plan = built.Plan!;
        VaultSyncPlanItem operation = Assert.Single(Assert.Single(plan.Groups).Items);
        Assert.Equal(VaultSyncDecision.PushUpdate, operation.Decision);
        var payloadItem = new ArticleVaultExecutionPayloadItem(operation.OperationIdentity, Article, "042",
            "Title", Encoding.UTF8.GetString(bytes), null, null, 1, [], local.Source!.Sha256, Digest, string.Empty);
        payloadItem = payloadItem with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealPayloadItem(payloadItem)
        };
        var payload = new ArticleVaultExecutionPayload(ArticleVaultExecutionSchemas.Payload, ArticleVaultExecutionSchemas.Version, [payloadItem], string.Empty);
        payload = payload with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealPayload(payload)
        };
        var bundle = new ArticleVaultSealedExecutionBundle(ArticleVaultExecutionSchemas.Bundle, ArticleVaultExecutionSchemas.Version,
            plan.PlanCandidateIdentity, plan.ContentSha256, 7, plan, root, [article], [observation], payload, string.Empty);
        bundle = bundle with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle)
        };
        VaultDependencyPlanInput[] inputs = [new(graph, bytes, [], [], Digest)];
        VaultDependencyPlanBuildResult dependencies = ArticleVaultDependencyPlanner.Build(plan, request, context, inputs, s_budgets);
        Assert.NotNull(dependencies.Plan);
        return new Scenario(bundle, dependencies.Plan!, request, context, inputs);
    }

    private static VaultArticleCoordinate Seal(VaultArticleCoordinate coordinate)
        => coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };

    private sealed record Scenario(
        ArticleVaultSealedExecutionBundle Bundle,
        ArticleVaultDependencyPlan Extension,
        ArticleVaultPlanRequest Request,
        ArticleVaultPlanVerificationContext Context,
        IReadOnlyList<VaultDependencyPlanInput> Inputs);
}
