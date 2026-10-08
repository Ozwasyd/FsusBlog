using System.Security.Claims;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

using NSubstitute;

namespace FsusBlog.Server.Tests;

/// <summary>Controlled authority inputs test binding, never confer production Vault permission.</summary>
public sealed class ArticleVaultUploadAssetBindingTests
{
    [Fact]
    public async Task Observe_BindsOriginalAuthoritiesWithoutGrantingVaultOperations()
    {
        var setup = Create();
        ArticleVaultCurrentUploadAssetObservation result = await setup.ReadAsync();
        Assert.Equal(setup.Reference, result.Reference);
        Assert.Equal(42, result.ArticleId);
        Assert.Equal(4, result.SourceRevision);
        Assert.Equal(7, result.AdminPrincipalId);
        Assert.Equal(setup.Upload.Asset, result.Asset);
        Assert.Equal(setup.Upload.AssetVersionSha256, result.AssetVersionSha256);
        Assert.Equal(setup.Upload.ReferenceLedgerSha256, result.ReferenceLedgerSha256);
        Assert.Equal("4", result.RevisionReferenceSourceKey);
        Assert.False(result.CanExecute);
        Assert.False(result.CanUpload);
        Assert.False(result.CanMaterialize);
        Assert.False(result.CanCommitBase);
        Assert.Equal(ArticleVaultExecutionIntegrity.Digest(result with
        {
            ContentSha256 = string.Empty
        }), result.ContentSha256);
        string serialized = System.Text.Json.JsonSerializer.Serialize(result);
        Assert.DoesNotContain("private-upload-token", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("publicUrl", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(2, setup.Files.ReceivedCalls().Count());
        Assert.Equal(2, setup.Observer.ReceivedCalls().Count());
    }

    [Fact]
    public async Task SharedAssetReader_BindsFactsWithoutASecondVaultOrWriterAuthority()
    {
        var setup = Create();
        var reference = new CurrentArticleUploadAssetReference(42, 4, setup.Package.SourceDigest, setup.Reference.AssetId);
        var observed = await setup.Assets.ObserveCurrentRevisionAsync(reference, setup.Principal, setup.Session, setup.Sha256);
        Assert.Equal(reference, observed.Reference);
        Assert.Equal(setup.Upload.Asset, observed.Asset);
        Assert.Equal(setup.Upload.ReferenceLedgerSha256, observed.ReferenceLedgerSha256);
        Assert.Equal(setup.Package.PackageDigest, observed.RevisionPackageSha256);
        Assert.False(observed.CanExecute);
        Assert.False(observed.CanUpload);
        Assert.False(observed.CanMaterialize);
        Assert.False(observed.CanCommitBase);
        Assert.Empty(setup.Observer.ReceivedCalls());
        setup.Upload = setup.Upload with
        {
            References = []
        };
        var failure = await Assert.ThrowsAsync<CurrentArticleUploadAssetObservationRejectedException>(() =>
            setup.Assets.ObserveCurrentRevisionAsync(reference, setup.Principal, setup.Session, setup.Sha256));
        Assert.Equal("upload_or_revision_reference_unavailable", failure.ReasonCode);
    }

    [Theory]
    [InlineData("principal")]
    [InlineData("plan")]
    [InlineData("group")]
    [InlineData("operation")]
    [InlineData("asset")]
    [InlineData("owner")]
    [InlineData("revision-reference")]
    [InlineData("upload-unknown")]
    [InlineData("permission")]
    [InlineData("source")]
    public async Task Observe_RefusesMismatchedBindings(string mutation)
    {
        var setup = Create();
        if (mutation == "principal")
        {
            setup.Principal = new ClaimsPrincipal(new ClaimsIdentity());
        }
        if (mutation == "plan")
        {
            setup.Reference = setup.Reference with
            {
                PlanSha256 = new('f', 64)
            };
        }
        if (mutation == "group")
        {
            setup.Reference = setup.Reference with
            {
                GroupIdentity = "other-group"
            };
        }
        if (mutation == "operation")
        {
            setup.Reference = setup.Reference with
            {
                OperationIdentity = "other-operation"
            };
        }
        if (mutation == "asset")
        {
            setup.Reference = setup.Reference with
            {
                AssetId = AssetId.New()
            };
        }
        if (mutation == "owner")
        {
            setup.Upload = setup.Upload with
            {
                Asset = setup.Upload.Asset with
                {
                    OwnerAdminPrincipalId = 8
                }
            };
        }
        if (mutation == "revision-reference")
        {
            setup.Upload = setup.Upload with
            {
                References = []
            };
        }
        if (mutation == "upload-unknown")
        {
            setup.UploadFailure = true;
        }
        if (mutation == "permission")
        {
            setup.Current = setup.Current with
            {
                Permitted = false
            };
        }
        if (mutation == "source")
        {
            setup.Package = Package("changed\n");
        }
        ArticleVaultExecutionRejectedException rejection = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(setup.ReadAsync);
        string expected = mutation switch
        {
            "principal" => "article_vault_upload_asset_input_invalid",
            "plan" => "article_vault_upload_asset_plan_context_mismatch",
            "group" => "article_vault_upload_asset_group_missing",
            "operation" => "article_vault_upload_asset_operation_missing",
            "permission" => "article_vault_current_observation_drift",
            "source" => "article_vault_upload_asset_source_unavailable_or_changed",
            _ => "article_vault_upload_asset_upload_or_revision_reference_unavailable"
        };
        Assert.Equal(expected, rejection.ReasonCode);
    }

    [Theory]
    [InlineData("rights")]
    [InlineData("ledger")]
    [InlineData("article-permission")]
    [InlineData("principal-late")]
    [InlineData("expiry")]
    [InlineData("cancel")]
    public async Task Observe_RefusesChangesDuringOriginalReads(string mutation)
    {
        var setup = Create();
        int reads = 0;
        setup.BeforeUpload = () =>
        {
            if (++reads != 2)
            {
                return;
            }
            if (mutation == "rights")
            {
                setup.Current = setup.Current with
                {
                    RightsBoundarySha256 = new('f', 64)
                };
            }
            if (mutation == "ledger")
            {
                setup.Upload = setup.Upload with
                {
                    ReferenceLedgerSha256 = new('f', 64)
                };
            }
            if (mutation == "article-permission")
            {
                setup.ArticleAuthority = setup.ArticleAuthority with
                {
                    PermissionFingerprint = new('f', 64)
                };
            }
            if (mutation == "principal-late")
            {
                ((ClaimsIdentity)setup.Principal.Identity!).RemoveClaim(setup.Principal.FindFirst("admin_id")!);
            }
            if (mutation == "expiry")
            {
                setup.Clock.Now = DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_060_001);
            }
            if (mutation == "cancel")
            {
                setup.Cancellation.Cancel();
            }
        };
        if (mutation == "cancel")
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(setup.ReadAsync);
        }
        else
        {
            var refusal = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(setup.ReadAsync);
            Assert.Equal(mutation == "expiry" ? "article_vault_upload_asset_plan_expired_or_cancelled"
                : "article_vault_upload_asset_current_facts_changed", refusal.ReasonCode);
        }
    }

    [Theory]
    [InlineData("none")]
    [InlineData("owner")]
    [InlineData("revision-reference")]
    [InlineData("source")]
    [InlineData("ledger")]
    [InlineData("principal-late")]
    [InlineData("cancel")]
    public async Task InputRead_UsesSameOriginalFactsAndRefusals(string mutation)
    {
        var setup = Create();
        if (mutation == "owner")
        {
            setup.Upload = setup.Upload with
            {
                Asset = setup.Upload.Asset with
                {
                    OwnerAdminPrincipalId = 8
                }
            };
        }
        if (mutation == "revision-reference")
        {
            setup.Upload = setup.Upload with
            {
                References = []
            };
        }
        if (mutation == "source")
        {
            setup.Package = Package("changed\n");
        }
        int reads = 0;
        setup.BeforeUpload = () =>
        {
            if (++reads != 2)
            {
                return;
            }
            if (mutation == "ledger")
            {
                setup.Upload = setup.Upload with
                {
                    ReferenceLedgerSha256 = new('f', 64)
                };
            }
            if (mutation == "principal-late")
            {
                var identity = (ClaimsIdentity)setup.Principal.Identity!;
                identity.RemoveClaim(identity.FindFirst("admin_id")!);
                identity.AddClaim(new("admin_id", "8"));
            }
            if (mutation == "cancel")
            {
                setup.Cancellation.Cancel();
            }
        };
        if (mutation == "none")
        {
            var input = await setup.ReadInputAsync();
            Assert.Equal(setup.Upload.Asset, input.Observation.Asset);
            Assert.Equal(setup.InputBytes, input.Bytes.ToArray());
            Assert.False(input.Observation.CanExecute);
            Assert.False(input.Observation.CanCommitBase);
            Assert.Equal(2, setup.Files.ReceivedCalls().Count());
            return;
        }
        if (mutation == "cancel")
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(setup.ReadInputAsync);
            return;
        }
        var refusal = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(setup.ReadInputAsync);
        Assert.Equal("article_vault_upload_asset_" + (mutation switch
        {
            "source" => "source_unavailable_or_changed",
            "ledger" or "principal-late" => "current_facts_changed",
            _ => "upload_or_revision_reference_unavailable"
        }), refusal.ReasonCode);
    }

    internal static Setup Create(IFileService? actualFiles = null, UploadSessionAccess? actualSession = null, string? actualSha256 = null)
        => new(actualFiles, actualSession, actualSha256);

    internal sealed class Setup
    {
        internal Setup(IFileService? actualFiles, UploadSessionAccess? actualSession, string? actualSha256)
        {
            Session = actualSession ?? new("0123456789abcdef0123456789abcdef", 7, "private-upload-token");
            Sha256 = actualSha256 ?? new string('a', 64);
            Bundle = BundleForCurrent();
            VaultSyncPlanItem item = Bundle.Plan.Groups[0].Items[0];
            Reference = new(Bundle.PlanReference, Bundle.PlanSha256, item.GroupIdentity, item.OperationIdentity,
                AssetId.FromGuid(Guid.ParseExact(Session.UploadId, "N")));
            Current = new(item.PortableArticleIdentity, item.ServerArticleIdentity, 4, "draft", true,
                item.Preconditions.ExpectedPermissionSha256, item.Server.DependencySha256, new('b', 64), new('c', 64),
                item.Server.Source!.Sha256, item.Preconditions.ServerObservationSha256);
            var asset = new AssetRecord(Reference.AssetId, "public", AssetStorageKey.Parse("illustration/" + Session.UploadId + ".png"),
                "image/png", ".png", 67, Sha256, 1, 1, 7, ContentAssetState.Active, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch);
            Upload = new("fsusblog.upload-asset-observation.v1", Session.UploadId, asset, "/display-url-is-not-authority",
                [new(Reference.AssetId, ContentAssetSourceKinds.Revision, "4", 42, 1, null, DateTimeOffset.UnixEpoch)],
                new('d', 64), new('e', 64));
            Files = actualFiles ?? Substitute.For<IFileService>();
            if (actualFiles is null)
            {
                Files.ReadCommittedUploadInputAsync(Session, Sha256, Arg.Any<CancellationToken>()).Returns(_ =>
                {
                    BeforeUpload?.Invoke();
                    return UploadFailure ? Result<UploadAssetPreview>.Failure(ErrorCode.NotFound, "UPLOAD_SESSION_NOT_FOUND")
                        : Result<UploadAssetPreview>.Success(new(Upload, InputBytes));
                });
                Files.ObserveCommittedUploadAsync(Session, Sha256, Arg.Any<CancellationToken>()).Returns(_ =>
                {
                    BeforeUpload?.Invoke();
                    return UploadFailure ? Result<UploadAssetObservation>.Failure(ErrorCode.NotFound, "UPLOAD_SESSION_NOT_FOUND")
                        : Result<UploadAssetObservation>.Success(Upload);
                });
            }
            var store = Substitute.For<IArticleVaultExecutionStore>();
            store.LoadSealedAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(_ => Bundle);
            Observer = Substitute.For<IArticleVaultCurrentObservationAuthority>();
            Observer.ObserveGroupAsync(Arg.Any<ArticleVaultSealedExecutionBundle>(), Arg.Any<VaultSyncPlanGroup>(), Arg.Any<CancellationToken>())
                .Returns(_ => new[] { Current });
            var articles = Substitute.For<IAuthoringCanvasArticleReferenceReader>();
            articles.ReadAuthorityAsync(Arg.Any<AuthoringCanvasOwner>(), Arg.Any<AuthoringCanvasReferencePermission>(), Arg.Any<CancellationToken>())
                .Returns(_ => ArticleAuthority);
            articles.ReadCurrentArticleAsync(Arg.Any<AuthoringCanvasOwner>(), Arg.Any<AuthoringCanvasReferencePermission>(), 42, Arg.Any<CancellationToken>())
                .Returns(_ => new AuthoringCanvasArticleReferenceRecord(42, AuthoringCanvasArticleState.Current, 4,
                    new(4, "Current", null), new Dictionary<long, AuthoringCanvasArticleRevisionDisplayFact>()));
            var packages = Substitute.For<IRevisionComparePackageReader>();
            packages.ReadAuthorizedAsync(Arg.Any<RevisionCompareReadContext>(), 42, Arg.Any<RevisionCompareSourceSelector>(), Arg.Any<CancellationToken>())
                .Returns(_ => RevisionComparePackageReadResult.Available(Package));
            var sourceReader = new AuthoringArticleCurrentSourceReader(articles, packages);
            Assets = new(sourceReader, Files);
            Reader = new(store, Observer, sourceReader, Files, Clock, "site-primary");
        }

        internal CurrentArticleUploadAssetBindingReader Assets
        {
            get;
        }

        internal ArticleVaultSealedExecutionBundle Bundle
        {
            get;
        }
        internal ArticleVaultUploadAssetReference Reference
        {
            get; set;
        }
        internal ClaimsPrincipal Principal
        {
            get; set;
        } = new(new ClaimsIdentity(
            [new("admin_id", "7"), new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind)], "controlled-unit-identity"));
        internal UploadSessionAccess Session
        {
            get;
        }
        internal string Sha256
        {
            get;
        }
        internal IFileService Files
        {
            get;
        }
        internal IArticleVaultCurrentObservationAuthority Observer
        {
            get;
        }
        internal ArticleVaultCurrentArticleObservation Current
        {
            get; set;
        }
        internal AuthoringCanvasArticleReadAuthority ArticleAuthority { get; set; } = new(1, 1, 1, 1, new('a', 64), true);
        internal RevisionComparePackage Package { get; set; } = ArticleVaultUploadAssetBindingTests.Package("source\n");
        internal UploadAssetObservation Upload
        {
            get; set;
        }
        internal byte[] InputBytes { get; } = new byte[67];
        internal bool UploadFailure
        {
            get; set;
        }
        internal Action? BeforeUpload
        {
            get; set;
        }
        internal MutableClock Clock { get; } = new();
        internal CancellationTokenSource Cancellation { get; } = new();
        internal ArticleVaultUploadAssetBindingReader Reader
        {
            get;
        }
        internal Task<ArticleVaultCurrentUploadAssetObservation> ReadAsync()
            => Reader.ObserveCurrentRevisionUploadAsync(Reference, Principal, Session, Sha256, Cancellation.Token);
        internal Task<(ArticleVaultCurrentUploadAssetObservation Observation, ReadOnlyMemory<byte> Bytes)> ReadInputAsync()
            => Reader.ReadCurrentRevisionUploadInputAsync(Reference, Principal, Session, Sha256, Cancellation.Token);
    }

    internal sealed class MutableClock : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_001);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static RevisionComparePackage Package(string source)
        => RevisionComparePackageSeal.Create(42, RevisionCompareSourceKind.CurrentRevision, "revision:4:1", 4, 1, null, null,
            Encoding.UTF8.GetBytes(source), [RevisionCompareMetadataRegistry.String("title", "Current")],
            [RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Rights),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)]);

    private static ArticleVaultSealedExecutionBundle BundleForCurrent()
    {
        var coordinate = new VaultArticleCoordinate(ArticleVaultSchemas.Coordinate, 1, true, false, 4,
            ArticleVaultManifestCodec.CaptureSourceBytes(Encoding.UTF8.GetBytes("source\n")), new('b', 64), new('c', 64), "draft", new('d', 64), string.Empty);
        coordinate = coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };
        var article = new ArticleVaultArticleManifest(ArticleVaultSchemas.ArticleManifest, 1, "site-primary", "vault-primary", "device-primary",
            "portable-article", "042", new("articles/one.md", ArticleVaultManifestCodec.ComputeProjectionSha256("articles/one.md")),
            new(coordinate, coordinate, coordinate), new(0, null, null, null, null, null, null), VaultArticleState.Synced, string.Empty);
        article = article with
        {
            State = ArticleVaultStateMachine.Derive(article)
        };
        article = article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
        var observation = new ArticleVaultServerObservation(ArticleVaultPlanSchemas.ServerObservation, 1,
            article.SiteIdentity, article.VaultIdentity, article.DeviceIdentity, article.PortableArticleIdentity, article.ServerArticleIdentity, coordinate, string.Empty);
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        var root = new ArticleVaultRootManifest(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            article.SiteIdentity, article.VaultIdentity, article.DeviceIdentity,
            [new(article.PortableArticleIdentity, $"{ArticleVaultSchemas.ArticleManifestDirectory}/{article.PortableArticleIdentity}.json",
                article.ContentSha256, article.PathProjection.RelativePath)], [], string.Empty);
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        var built = ArticleVaultSyncPlanner.Build(new(root, [article], [observation],
            [new("group-primary", [article.PortableArticleIdentity], [])], VaultSyncDirection.Sync,
            1_800_000_000_000, 1_800_000_060_000, false));
        Assert.True(built.IsSuccess, string.Join(',', built.Errors));
        ArticleVaultSyncPlan plan = built.Plan!;
        var payload = new ArticleVaultExecutionPayload(ArticleVaultExecutionSchemas.Payload, 1, [], string.Empty);
        payload = payload with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealPayload(payload)
        };
        var bundle = new ArticleVaultSealedExecutionBundle(ArticleVaultExecutionSchemas.Bundle, 1, plan.PlanCandidateIdentity,
            plan.ContentSha256, 7, plan, root, [article], [observation], payload, string.Empty);
        return bundle with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle)
        };
    }
}
