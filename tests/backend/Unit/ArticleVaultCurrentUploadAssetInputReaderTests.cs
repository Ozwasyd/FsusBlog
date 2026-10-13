using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.ArticleVault.Assets;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Ordinary caller controls with explicit test doubles; no native, database or product acceptance.</summary>
public sealed class ArticleVaultCurrentUploadAssetInputReaderTests
{
    [Fact]
    public async Task CurrentInput_UsesOriginalSupplierAndVerifierWithoutGrantingExecution()
    {
        var fixture = new Fixture();
        ArticleVaultCurrentUploadAssetInput input = await fixture.ReadAsync();
        Assert.Equal(fixture.Operation, input.Operation);
        Assert.Equal(fixture.Dependencies.ContentSha256, input.DependencyPlanSha256);
        Assert.Equal(fixture.Upload.Asset, input.Observation.Asset);
        Assert.Equal(fixture.Upload.AssetVersionSha256, input.Observation.AssetVersionSha256);
        Assert.Equal(fixture.Upload.ReferenceLedgerSha256, input.Observation.ReferenceLedgerSha256);
        Assert.Equal(fixture.Bytes, input.Bytes.ToArray());
        Assert.False(input.CanExecute);
        Assert.False(input.CanMaterialize);
        Assert.False(input.CanUpload);
        Assert.False(input.CanCommitBase);
        fixture.AssertReadOnly();
        fixture.Bytes[0] = 0;
        Assert.Equal(137, input.Bytes[0]);
    }

    [Theory]
    [InlineData("plan")]
    [InlineData("group")]
    [InlineData("item")]
    [InlineData("asset")]
    [InlineData("principal")]
    [InlineData("rights")]
    [InlineData("expiry")]
    [InlineData("blocked")]
    [InlineData("source-side")]
    public async Task InvalidCurrentAdmission_RefusesBeforeOriginalUploadRead(string mutation)
    {
        var fixture = new Fixture(mutation == "blocked", mutation == "source-side");
        fixture.Reference = mutation switch
        {
            "plan" => fixture.Reference with { PlanSha256 = new('f', 64) },
            "group" => fixture.Reference with { GroupIdentity = "other-group" },
            "item" => fixture.Reference with { OperationIdentity = "other-item" },
            "asset" => fixture.Reference with { AssetId = AssetId.New() },
            _ => fixture.Reference
        };
        if (mutation == "principal")
        {
            fixture.Principal = new(new ClaimsIdentity());
        }
        if (mutation == "rights")
        {
            fixture.RevokeDependencyRights();
        }
        if (mutation == "expiry")
        {
            fixture.Clock.Now = DateTimeOffset.FromUnixTimeMilliseconds(fixture.Operation.DeadlineUnixMs + 1);
        }
        ArticleVaultExecutionRejectedException refusal = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(fixture.ReadAsync);
        Assert.False(string.IsNullOrWhiteSpace(refusal.ReasonCode));
        Assert.Empty(fixture.Files.ReceivedCalls());
        if (mutation == "blocked")
        {
            Assert.Equal(VaultSyncPlanStatus.Blocked, fixture.Bundle.Plan.Status);
            Assert.Equal("portable_dependency_sync_plan_blocked", refusal.ReasonCode);
        }
        if (mutation == "source-side")
        {
            Assert.Equal("article_vault_current_upload_input_current_server_source_required", refusal.ReasonCode);
        }
    }

    [Theory]
    [InlineData("bytes")]
    [InlineData("length")]
    [InlineData("owner")]
    [InlineData("revision-reference")]
    [InlineData("ledger")]
    [InlineData("rights-late")]
    [InlineData("principal-late")]
    [InlineData("expiry-late")]
    public async Task CurrentReadDrift_RefusesOriginalInput(string mutation)
    {
        var fixture = new Fixture();
        if (mutation == "bytes")
        {
            fixture.Bytes[^1] ^= 1;
        }
        if (mutation == "length")
        {
            fixture.Bytes = [1];
        }
        if (mutation == "owner")
        {
            fixture.Upload = fixture.Upload with
            {
                Asset = fixture.Upload.Asset with
                {
                    OwnerAdminPrincipalId = 8
                }
            };
        }
        if (mutation == "revision-reference")
        {
            fixture.Upload = fixture.Upload with
            {
                References = []
            };
        }
        fixture.OnObservation = () =>
        {
            if (mutation == "ledger")
            {
                fixture.Upload = fixture.Upload with
                {
                    ReferenceLedgerSha256 = new('f', 64)
                };
            }
            if (mutation == "rights-late")
            {
                fixture.RevokeDependencyRights();
            }
            if (mutation == "principal-late")
            {
                var identity = (ClaimsIdentity)fixture.Principal.Identity!;
                identity.RemoveClaim(identity.FindFirst("admin_id")!);
                identity.AddClaim(new("admin_id", "8"));
            }
            if (mutation == "expiry-late")
            {
                fixture.Clock.Now = DateTimeOffset.FromUnixTimeMilliseconds(fixture.Operation.DeadlineUnixMs + 1);
            }
        };
        ArticleVaultExecutionRejectedException refusal = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(fixture.ReadAsync);
        Assert.False(string.IsNullOrWhiteSpace(refusal.ReasonCode));
        fixture.AssertReadOnly();
        if (mutation == "length")
        {
            Assert.Equal("article_vault_asset_size_mismatch", refusal.ReasonCode);
        }
    }

    [Fact]
    public async Task CancelledRead_LeavesNoWriteAndNewReadReobservesOriginalFacts()
    {
        var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        fixture.OnObservation = cancellation.Cancel;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.ReadAsync(cancellation.Token));
        fixture.OnObservation = null;
        ArticleVaultCurrentUploadAssetInput first = await fixture.ReadAsync();
        ArticleVaultCurrentUploadAssetInput second = await fixture.ReadAsync();
        Assert.NotSame(first, second);
        Assert.Equal(first.Bytes.ToArray(), second.Bytes.ToArray());
        Assert.False(second.CanExecute);
        fixture.AssertReadOnly();
        Assert.Equal(3, fixture.Files.ReceivedCalls().Count(call => call.GetMethodInfo().Name == nameof(IFileService.ReadCommittedUploadInputAsync)));
    }

    [Fact]
    public void ExplicitComposition_RequiresOriginalOwnersAndSharesScopedReaders()
    {
        var services = new ServiceCollection();
        Assert.Equal("article_vault_current_upload_input_owner_missing", Assert.Throws<InvalidOperationException>(() =>
            services.AddFsusArticleVaultCurrentUploadAssetInputs("site-primary")).Message);
        Assert.Empty(services);
        services.AddSingleton(Substitute.For<IArticleVaultExecutionStore>());
        services.AddSingleton(Substitute.For<IArticleVaultCurrentObservationAuthority>());
        services.AddSingleton(Substitute.For<IAuthoringArticleCurrentSourceReader>());
        services.AddSingleton(Substitute.For<IFileService>());
        services.AddSingleton<TimeProvider>(TimeProvider.System);
        services.AddFsusArticleVaultCurrentUploadAssetInputs("site-primary");
        Assert.Throws<InvalidOperationException>(() => services.AddFsusArticleVaultCurrentUploadAssetInputs("other-site"));
        using ServiceProvider provider = services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true, ValidateOnBuild = true });
        using IServiceScope first = provider.CreateScope();
        using IServiceScope second = provider.CreateScope();
        Assert.Same(first.ServiceProvider.GetRequiredService<ArticleVaultCurrentUploadAssetInputReader>(),
            first.ServiceProvider.GetRequiredService<ArticleVaultCurrentUploadAssetInputReader>());
        Assert.NotSame(first.ServiceProvider.GetRequiredService<ArticleVaultCurrentUploadAssetInputReader>(),
            second.ServiceProvider.GetRequiredService<ArticleVaultCurrentUploadAssetInputReader>());
        Assert.Single(services, descriptor => descriptor.ServiceType == typeof(IArticleVaultExecutionStore));
        Assert.Single(services, descriptor => descriptor.ServiceType == typeof(IFileService));
        Assert.DoesNotContain(services, descriptor => descriptor.ServiceType == typeof(IArticleVaultSyncPlanExecutor));
    }

    [Fact]
    public void DomainComposition_UsesOriginalSourceReaderWithoutEnablingUnboundUploadReads()
    {
        var services = new ServiceCollection();
        services.AddFsusRuntimeDomainServices();
        ServiceDescriptor source = Assert.Single(services, descriptor => descriptor.ServiceType == typeof(IAuthoringArticleCurrentSourceReader));
        Assert.Equal(typeof(AuthoringArticleCurrentSourceReader), source.ImplementationType);
        Assert.Equal(ServiceLifetime.Scoped, source.Lifetime);
        Assert.DoesNotContain(services, descriptor => descriptor.ServiceType == typeof(ArticleVaultCurrentUploadAssetInputReader));
    }

    private sealed class Fixture
    {
        internal Fixture(bool blocked = false, bool localSource = false)
        {
            string digest = Convert.ToHexStringLower(SHA256.HashData(Bytes));
            var binding = new VaultDependencyBinding("site-primary", "vault-primary", "article:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
            var admission = new VaultDependencyAdmission(ArticleEmbedPermissionStatus.Allowed,
                VaultDependencyRight.Read | VaultDependencyRight.Materialize,
                VaultDependencyRight.Read | VaultDependencyRight.Materialize, new('a', 64), new('b', 64), new('c', 64));
            AssetId assetId = AssetId.FromGuid(Guid.ParseExact(Session.UploadId, "N"));
            var asset = new VaultAssetDependency(binding, admission, assetId.Value, digest, "image/png", ".png", Bytes.Length, 1, 1, 7, 4);
            VaultSourceByteIdentity source = ArticleVaultManifestCodec.CaptureSourceBytes("source\n"u8);
            VaultSourceByteIdentity oldSource = ArticleVaultManifestCodec.CaptureSourceBytes("old\n"u8);
            var coordinate = new VaultArticleCoordinate(ArticleVaultSchemas.Coordinate, 1, true, false, 3,
                oldSource, new('b', 64), new('c', 64), "draft", new('d', 64), string.Empty);
            var manifest = new PortableDependencyManifest(PortableDependencySchemas.Manifest, 1, binding, "042",
                new(coordinate, coordinate, coordinate), VaultDependencySourceSide.Server, source, new('a', 64), [asset], [], string.Empty, string.Empty);
            coordinate = coordinate with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
            };
            VaultArticleCoordinate server = coordinate with
            {
                ServerRevision = 4,
                Source = source,
                DependencySha256 = PortableDependencyCodec.GraphDigest(manifest),
                ContentSha256 = string.Empty
            };
            server = server with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(server)
            };
            VaultArticleCoordinate local = localSource ? server : blocked ? coordinate with
            {
                Source = ArticleVaultManifestCodec.CaptureSourceBytes("local\n"u8),
                ContentSha256 = string.Empty
            } : coordinate;
            local = local with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(local)
            };
            if (localSource)
            {
                coordinate = server;
            }
            var article = new ArticleVaultArticleManifest(ArticleVaultSchemas.ArticleManifest, 1,
                binding.SiteIdentity, binding.VaultIdentity, "device-primary", binding.PortableArticleIdentity, "042",
                new("articles/one.md", ArticleVaultManifestCodec.ComputeProjectionSha256("articles/one.md")),
                new(coordinate, local, coordinate), new(0, null, null, null, null, null, null), VaultArticleState.Synced, string.Empty);
            article = article with
            {
                State = ArticleVaultStateMachine.Derive(article)
            };
            article = article with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
            };
            var root = new ArticleVaultRootManifest(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
                new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
                binding.SiteIdentity, binding.VaultIdentity, article.DeviceIdentity,
                [new(article.PortableArticleIdentity, $".fsus/articles/{article.PortableArticleIdentity}.json", article.ContentSha256, article.PathProjection.RelativePath)], [], string.Empty);
            root = root with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
            };
            var observation = new ArticleVaultServerObservation(ArticleVaultPlanSchemas.ServerObservation, 1,
                binding.SiteIdentity, binding.VaultIdentity, article.DeviceIdentity, binding.PortableArticleIdentity, "042", server, string.Empty);
            observation = observation with
            {
                ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
            };
            Request = new(root, [article], [observation], [new("group-primary", [article.PortableArticleIdentity], [])],
                localSource ? VaultSyncDirection.Sync : VaultSyncDirection.Pull, 1_800_000_000_000, 1_800_000_060_000, false);
            ArticleVaultPlanBuildResult planBuild = ArticleVaultSyncPlanner.Build(Request);
            Assert.True(planBuild.IsSuccess, string.Join(',', planBuild.Errors));
            ArticleVaultSyncPlan plan = planBuild.Plan!;
            manifest = PortableDependencyCodec.Seal(manifest with
            {
                Coordinates = new(coordinate, local, server),
                SourceSide = localSource ? VaultDependencySourceSide.Local : VaultDependencySourceSide.Server,
                GraphSha256 = server.DependencySha256!
            });
            Inputs = [new(manifest, "source\n"u8.ToArray(), manifest.Nodes, manifest.Edges, manifest.RelationSha256)];
            var budgets = new ArticleEmbedResolutionBudgetLimits(8, 100, 1_000_000, 10_000, 100);
            VaultDependencyPlanBuildResult dependencyBuild = blocked ? new(new Fixture().Dependencies, null)
                : ArticleVaultDependencyPlanner.Build(plan, Request,
                    new(Request.CreatedAtUnixMs, Request.Direction, false), Inputs, budgets, Clock);
            Assert.True(dependencyBuild.Plan is not null, dependencyBuild.ReasonCode);
            Dependencies = dependencyBuild.Plan!;
            var payload = new ArticleVaultExecutionPayload(ArticleVaultExecutionSchemas.Payload, 1, [], string.Empty);
            payload = payload with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealPayload(payload)
            };
            Bundle = new(ArticleVaultExecutionSchemas.Bundle, 1, plan.PlanCandidateIdentity, plan.ContentSha256, 7,
                plan, root, [article], [observation], payload, string.Empty);
            Bundle = Bundle with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(Bundle)
            };
            Operation = ArticleVaultOperationVerifier.Bind(plan, "agent-primary", new('a', 64), new('b', 64), plan.ExpiresAtUnixMs);
            VaultSyncPlanItem item = plan.Groups[0].Items[0];
            Reference = new(Bundle.PlanReference, Bundle.PlanSha256, item.GroupIdentity, item.OperationIdentity, assetId);
            Upload = new("fsusblog.upload-asset-observation.v1", Session.UploadId,
                new(assetId, "public", AssetStorageKey.Parse("illustration/" + Session.UploadId + ".png"),
                    "image/png", ".png", Bytes.Length, digest, 1, 1, 7, ContentAssetState.Active, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch),
                "/display-only", [new(assetId, ContentAssetSourceKinds.Revision, "4", 42, 1, null, DateTimeOffset.UnixEpoch)], new('d', 64), new('e', 64));
            Files.ReadCommittedUploadInputAsync(Session, digest, Arg.Any<CancellationToken>())
                .Returns(_ => Result<UploadAssetPreview>.Success(new(Upload, Bytes)));
            Files.ObserveCommittedUploadAsync(Session, digest, Arg.Any<CancellationToken>()).Returns(_ =>
            {
                OnObservation?.Invoke();
                return Result<UploadAssetObservation>.Success(Upload);
            });
            var plans = Substitute.For<IArticleVaultExecutionStore>();
            plans.LoadSealedAsync(Bundle.PlanReference, Bundle.PlanSha256, Arg.Any<CancellationToken>()).Returns(Bundle);
            var groups = Substitute.For<IArticleVaultCurrentObservationAuthority>();
            groups.ObserveGroupAsync(Arg.Any<ArticleVaultSealedExecutionBundle>(), Arg.Any<VaultSyncPlanGroup>(), Arg.Any<CancellationToken>())
                .Returns([new(item.PortableArticleIdentity, item.ServerArticleIdentity, item.Server.ServerRevision, "draft", true,
                    item.Preconditions.ExpectedPermissionSha256, item.Server.DependencySha256, new('b', 64), new('c', 64),
                    source.Sha256, item.Preconditions.ServerObservationSha256)]);
            var articles = Substitute.For<IAuthoringCanvasArticleReferenceReader>();
            articles.ReadAuthorityAsync(Arg.Any<AuthoringCanvasOwner>(), Arg.Any<AuthoringCanvasReferencePermission>(), Arg.Any<CancellationToken>())
                .Returns(new AuthoringCanvasArticleReadAuthority(1, 1, 1, 1, new('a', 64), true));
            articles.ReadCurrentArticleAsync(Arg.Any<AuthoringCanvasOwner>(), Arg.Any<AuthoringCanvasReferencePermission>(), 42, Arg.Any<CancellationToken>())
                .Returns(new AuthoringCanvasArticleReferenceRecord(42, AuthoringCanvasArticleState.Current, 4, new(4, "Current", null),
                    new Dictionary<long, AuthoringCanvasArticleRevisionDisplayFact>()));
            var packages = Substitute.For<IRevisionComparePackageReader>();
            packages.ReadAuthorizedAsync(Arg.Any<RevisionCompareReadContext>(), 42, Arg.Any<RevisionCompareSourceSelector>(), Arg.Any<CancellationToken>())
                .Returns(RevisionComparePackageReadResult.Available(RevisionComparePackageSeal.Create(42,
                    RevisionCompareSourceKind.CurrentRevision, "revision:4:1", 4, 1, null, null, "source\n"u8.ToArray(),
                    [RevisionCompareMetadataRegistry.String("title", "Current")],
                    [RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Rights),
                        RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                        RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)])));
            var sources = new AuthoringArticleCurrentSourceReader(articles, packages);
            Reader = new(plans, new(plans, groups, sources, Files, Clock, "site-primary"), Clock, "site-primary");
        }

        internal ArticleVaultCurrentUploadAssetInputReader Reader
        {
            get;
        }
        internal ArticleVaultSealedExecutionBundle Bundle
        {
            get;
        }
        internal ArticleVaultOperationIdentity Operation
        {
            get;
        }
        internal ArticleVaultDependencyPlan Dependencies
        {
            get;
        }
        internal ArticleVaultPlanRequest Request
        {
            get;
        }
        internal VaultDependencyPlanInput[] Inputs
        {
            get;
        }
        internal ArticleVaultUploadAssetReference Reference
        {
            get; set;
        }
        internal UploadAssetObservation Upload
        {
            get; set;
        }
        internal byte[] Bytes { get; set; } = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWkAAAAASUVORK5CYII=");
        internal ClaimsPrincipal Principal
        {
            get; set;
        } = new(new ClaimsIdentity(
            [new("admin_id", "7"), new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind)], "unit-test-only"));
        internal UploadSessionAccess Session { get; } = new("0123456789abcdef0123456789abcdef", 7, "unit-test-token");
        internal IFileService Files { get; } = Substitute.For<IFileService>();
        internal MutableClock Clock { get; } = new();
        internal Action? OnObservation
        {
            get; set;
        }

        internal Task<ArticleVaultCurrentUploadAssetInput> ReadAsync() => ReadAsync(CancellationToken.None);

        internal Task<ArticleVaultCurrentUploadAssetInput> ReadAsync(CancellationToken cancellationToken)
            => Reader.ReadAsync(Operation, Dependencies, Request, Inputs, Reference, Principal, Session, cancellationToken);

        internal void RevokeDependencyRights()
        {
            VaultAssetDependency asset = (VaultAssetDependency)Inputs[0].CurrentAuthorityNodes[0];
            Inputs[0] = Inputs[0] with
            {
                CurrentAuthorityNodes = [asset with
            {
                Admission = asset.Admission with { GrantedRights = VaultDependencyRight.Read }
            }]
            };
        }

        internal void AssertReadOnly() => Assert.All(Files.ReceivedCalls(), call =>
            Assert.Contains(call.GetMethodInfo().Name, new[] { nameof(IFileService.ReadCommittedUploadInputAsync), nameof(IFileService.ObserveCommittedUploadAsync) }));
    }

    private sealed class MutableClock : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_001);
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
