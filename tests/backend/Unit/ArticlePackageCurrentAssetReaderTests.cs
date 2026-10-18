using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

using NSubstitute;

namespace FsusBlog.Server.Tests;

/// <summary>Controlled source/session oracles exercise adapter binding, never production permission.</summary>
public sealed class ArticlePackageCurrentAssetReaderTests
{
    [Fact]
    public async Task OriginalSupplierBytesAndRecordReachOriginalCollectionMapper()
    {
        var setup = new Setup();
        ArticlePackageCurrentAssetInput input = await setup.ReadAsync();
        var source = Assert.Single(input.Sources);
        Assert.Same(setup.Upload.Asset, source.Record);
        Assert.Equal(setup.Bytes, source.SourceBytes.ToArray());
        Assert.Equal(setup.Request.PortableAsset, source.PortableAsset);
        var observation = Assert.Single(input.Observations);
        Assert.Equal(setup.Request.Article, observation.Article);
        Assert.Equal(setup.Package.PackageDigest, observation.Observation.RevisionPackageSha256);
        Assert.Equal(setup.Upload.ReferenceLedgerSha256, observation.Observation.ReferenceLedgerSha256);
        Assert.Equal(setup.Request.Article.Source, observation.Observation.Source);
        Assert.Equal(setup.Upload.Asset.Sha256, Assert.Single(input.Collection.Assets).Metadata.Sha256);
        Assert.True(ArticlePackageAssetCollectionMapper.ValidateCandidate(input.Collection, input.Sources,
            [new(setup.Request.Article.PortableArticle, setup.Request.PortableAsset)], setup.Inventory).IsValid);
        Assert.Equal(2, setup.Files.ReceivedCalls().Count());
        Assert.False(input.Collection.RequireAssetAuthority().IsValid);
        Assert.Equal("article_package_manifest_asset_rights_retention_authority_unavailable",
            input.Collection.RequireAssetAuthority().ReasonCode);
        string package = Encoding.UTF8.GetString(ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(input.Collection));
        Assert.DoesNotContain(setup.Request.Session!.Value.UploadToken!, package, StringComparison.Ordinal);
        Assert.DoesNotContain(setup.Upload.Asset.StorageKey.Value, package, StringComparison.Ordinal);
        Assert.DoesNotContain("permission", package, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("publicUrl", package, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(RevisionCompareSourceKind.HistoricalRevision)]
    [InlineData(RevisionCompareSourceKind.CurrentDraft)]
    [InlineData((RevisionCompareSourceKind)255)]
    public async Task OtherSourcesAreExplicitlyUnsupportedBeforeAnyAuthorityRead(RevisionCompareSourceKind kind)
    {
        var setup = new Setup();
        setup.Request = setup.Request with
        {
            Article = setup.Request.Article with
            {
                SourceKind = kind
            }
        };
        await RejectAsync(setup, "source_unsupported");
        Assert.Empty(setup.Files.ReceivedCalls());
        Assert.Empty(setup.Sources.ReceivedCalls());
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("empty-id")]
    [InlineData("missing-token")]
    public async Task NoSessionNeverBecomesACanonicalAssetOrUrlFallback(string mutation)
    {
        var setup = new Setup();
        setup.Request = setup.Request with
        {
            Session = mutation switch
            {
                "missing" => null,
                "empty-id" => setup.Request.Session!.Value with { UploadId = "" },
                _ => setup.Request.Session!.Value with { UploadToken = null }
            }
        };
        await RejectAsync(setup, "upload_session_unsupported");
        Assert.Empty(setup.Files.ReceivedCalls());
        Assert.Empty(setup.Sources.ReceivedCalls());
    }

    [Theory]
    [InlineData("portable-article")]
    [InlineData("portable-asset")]
    [InlineData("article-id")]
    [InlineData("revision-id")]
    [InlineData("digest")]
    [InlineData("owner")]
    [InlineData("anonymous")]
    public async Task InvalidExplicitBindingsNeverReadBytes(string mutation)
    {
        var setup = new Setup();
        setup.Request = mutation switch
        {
            "portable-article" => setup.Request with { Article = setup.Request.Article with { PortableArticle = default } },
            "portable-asset" => setup.Request with { PortableAsset = default },
            "article-id" => setup.Request with { Article = setup.Request.Article with { ArticleId = 0 } },
            "revision-id" => setup.Request with { Article = setup.Request.Article with { RevisionId = 0 } },
            "digest" => setup.Request with { Sha256 = new string('A', 64) },
            "owner" => setup.Request with { Session = setup.Request.Session!.Value with { OwnerAdminPrincipalId = 8 } },
            _ => setup.Request
        };
        if (mutation == "anonymous")
        {
            setup.Principal = new(new ClaimsIdentity());
        }
        await RejectAsync(setup, "input_invalid");
        Assert.Empty(setup.Files.ReceivedCalls());
    }

    [Theory]
    [InlineData("package")]
    [InlineData("bom")]
    [InlineData("newlines")]
    [InlineData("trailing")]
    [InlineData("final-newline")]
    public async Task WholeSourceBindingMustEqualReobservedFacts(string mutation)
    {
        var setup = new Setup();
        var article = setup.Request.Article;
        article = mutation switch
        {
            "package" => article with { RevisionPackageSha256 = new string('f', 64) },
            "bom" => article with { Source = article.Source with { HasUtf8Bom = true } },
            "newlines" => article with { Source = article.Source with { NewlineStyle = VaultNewlineStyle.CrLf } },
            "trailing" => article with { Source = article.Source with { TrailingWhitespaceLineCount = 9 } },
            _ => article with { Source = article.Source with { HasFinalNewline = false } }
        };
        setup.Request = setup.Request with
        {
            Article = article
        };
        await RejectAsync(setup, "source_binding_mismatch");
    }

    [Theory]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("source")]
    [InlineData("asset")]
    [InlineData("reference")]
    [InlineData("permission")]
    [InlineData("session")]
    public async Task OriginalSupplierRefusalsPropagateWithoutPartialCandidate(string mutation)
    {
        var setup = new Setup();
        setup.Request = mutation switch
        {
            "article" => setup.Request with { Article = setup.Request.Article with { ArticleId = 43 } },
            "revision" => setup.Request with { Article = setup.Request.Article with { RevisionId = 5 } },
            "source" => setup.Request with { Article = setup.Request.Article with { Source = setup.Request.Article.Source with { Sha256 = new string('f', 64) } } },
            "asset" => setup.Request with { AssetId = AssetId.New() },
            _ => setup.Request
        };
        if (mutation == "reference")
        {
            setup.Upload = setup.Upload with
            {
                References = []
            };
        }
        if (mutation == "permission")
        {
            setup.Authorized = false;
        }
        if (mutation == "session")
        {
            setup.UploadAvailable = false;
        }
        var error = await Assert.ThrowsAsync<CurrentArticleUploadAssetObservationRejectedException>(() => setup.ReadAsync());
        Assert.Equal(mutation is "article" or "revision" or "source" or "permission"
            ? "source_unavailable_or_changed" : "upload_or_revision_reference_unavailable", error.ReasonCode);
    }

    [Theory]
    [InlineData("bytes", "article_package_manifest_asset_byte_binding_mismatch")]
    [InlineData("size", "article_package_manifest_asset_byte_binding_mismatch")]
    [InlineData("mime", "article_package_manifest_asset_media_binding_mismatch")]
    [InlineData("dimensions", "article_package_manifest_asset_media_binding_mismatch")]
    public async Task ActualOriginalMapperStillRejectsRecordAndByteDrift(string mutation, string reason)
    {
        var setup = new Setup();
        if (mutation == "bytes")
        {
            setup.Bytes[^1] ^= 1;
        }
        setup.Upload = setup.Upload with
        {
            Asset = mutation switch
            {
                "size" => setup.Upload.Asset with { SizeBytes = 69 },
                "mime" => setup.Upload.Asset with { MimeType = "image/gif" },
                "dimensions" => setup.Upload.Asset with { WidthPixels = 2 },
                _ => setup.Upload.Asset
            }
        };
        var error = await Assert.ThrowsAsync<ArticlePackageCurrentAssetRejectedException>(() => setup.ReadAsync());
        Assert.Equal(reason, error.ReasonCode);
    }

    [Theory]
    [InlineData("duplicate")]
    [InlineData("asset-alias")]
    [InlineData("article-alias")]
    [InlineData("revision-alias")]
    public async Task PortableAndServerMappingsAreOneToOne(string mutation)
    {
        var setup = new Setup();
        var second = mutation switch
        {
            "asset-alias" => setup.Request with { PortableAsset = Identity(ArticlePackageIdentityKind.Asset, 3) },
            "article-alias" => setup.Request with { Article = setup.Request.Article with { PortableArticle = Identity(ArticlePackageIdentityKind.Article, 3) } },
            "revision-alias" => setup.Request with { PortableAsset = Identity(ArticlePackageIdentityKind.Asset, 3), AssetId = AssetId.New(), Article = setup.Request.Article with { RevisionId = 5 } },
            _ => setup.Request
        };
        var inventory = setup.Inventory.Concat(new[] { new ArticlePackageInventoryEntry(
            "articles/" + Identity(ArticlePackageIdentityKind.Article, 3).FileNameToken + ".md", ArticlePackageEntryKind.RegularFile, 7, 7) }).ToArray();
        var error = await Assert.ThrowsAsync<ArticlePackageCurrentAssetRejectedException>(() =>
            setup.Reader.ReadCurrentRevisionInputAsync([setup.Request, second], setup.Principal, inventory));
        Assert.Equal("article_package_current_asset_" + (mutation == "duplicate" ? "duplicate_reference" : "binding_mismatch"), error.ReasonCode);
        Assert.Empty(setup.Files.ReceivedCalls());
    }

    [Fact]
    public async Task SharedAssetHasOneOriginalSourceAndDistinctExactArticleEdges()
    {
        var setup = new Setup();
        var second = setup.Request with
        {
            Article = setup.Request.Article with
            {
                ArticleId = 43,
                RevisionId = 5,
                PortableArticle = Identity(ArticlePackageIdentityKind.Article, 3)
            }
        };
        setup.AddArticle(43);
        setup.Upload = setup.Upload with
        {
            References = [.. setup.Upload.References, new(setup.Request.AssetId,
            ContentAssetSourceKinds.Revision, "5", 43, 1, null, DateTimeOffset.UnixEpoch)]
        };
        var inventory = setup.Inventory.Concat(new[] { new ArticlePackageInventoryEntry(
            "articles/" + second.Article.PortableArticle.FileNameToken + ".md", ArticlePackageEntryKind.RegularFile, 7, 7) }).ToArray();
        second = second with
        {
            Article = second.Article with
            {
                RevisionPackageSha256 = setup.Packages[43].PackageDigest
            }
        };
        var input = await setup.Reader.ReadCurrentRevisionInputAsync([second, setup.Request], setup.Principal, inventory);
        Assert.Single(input.Sources);
        Assert.Single(input.Collection.Assets);
        Assert.Equal(2, input.Collection.References.Count);
        Assert.Equal(2, input.Observations.Count);
        var repeated = await setup.Reader.ReadCurrentRevisionInputAsync([setup.Request, second], setup.Principal, inventory);
        Assert.Equal(ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(input.Collection),
            ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(repeated.Collection));
        int reads = 0;
        setup.BeforeUpload = () =>
        {
            if (++reads == 3)
            {
                setup.Upload = setup.Upload with
                {
                    ReferenceLedgerSha256 = new string('f', 64)
                };
            }
        };
        var error = await Assert.ThrowsAsync<ArticlePackageCurrentAssetRejectedException>(() =>
            setup.Reader.ReadCurrentRevisionInputAsync([setup.Request, second], setup.Principal, inventory));
        Assert.Equal("article_package_current_asset_current_facts_changed", error.ReasonCode);
    }

    [Theory]
    [InlineData("ledger")]
    [InlineData("permission")]
    [InlineData("principal")]
    [InlineData("cancel")]
    public async Task OriginalLateRechecksAndCancellationRemainEffective(string mutation)
    {
        var setup = new Setup();
        using var cancellation = new CancellationTokenSource();
        int count = 0;
        setup.BeforeUpload = () =>
        {
            if (++count != 2)
            {
                return;
            }
            if (mutation == "ledger")
            {
                setup.Upload = setup.Upload with
                {
                    ReferenceLedgerSha256 = new string('f', 64)
                };
            }
            if (mutation == "permission")
            {
                setup.Authorized = false;
            }
            if (mutation == "principal")
            {
                ((ClaimsIdentity)setup.Principal.Identity!).RemoveClaim(setup.Principal.FindFirst("admin_id")!);
            }
            if (mutation == "cancel")
            {
                cancellation.Cancel();
            }
        };
        if (mutation == "cancel")
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => setup.ReadAsync(cancellation.Token));
        }
        else
        {
            await Assert.ThrowsAsync<CurrentArticleUploadAssetObservationRejectedException>(() => setup.ReadAsync(cancellation.Token));
        }
    }

    [Fact]
    public async Task LifetimeGuardAndPrecancelledCallsDoNotReadAuthorities()
    {
        var setup = new Setup();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => setup.ReadAsync(cancellation.Token));
        await Assert.ThrowsAsync<InvalidOperationException>(() => setup.Reader.ReadCurrentRevisionInputAsync(
            [setup.Request], setup.Principal, setup.Inventory, requireCurrent: () => throw new InvalidOperationException("plan_expired")));
        Assert.Empty(setup.Sources.ReceivedCalls());
        Assert.Empty(setup.Files.ReceivedCalls());
    }

    private static async Task RejectAsync(Setup setup, string reason)
    {
        var error = await Assert.ThrowsAsync<ArticlePackageCurrentAssetRejectedException>(() => setup.ReadAsync());
        Assert.Equal("article_package_current_asset_" + reason, error.ReasonCode);
    }

    internal static ArticlePackageIdentity Identity(ArticlePackageIdentityKind kind, int number)
    {
        string prefix = kind == ArticlePackageIdentityKind.Article ? "article:" : "portable-asset:";
        Assert.True(ArticlePackageIdentity.TryCreate(kind, prefix + $"{number:00000000}-0000-4000-8000-000000000001", out var identity).IsValid);
        return identity;
    }

    private sealed class Setup
    {
        internal Setup()
        {
            AddArticle(42);
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(Bytes));
            var session = new UploadSessionAccess("0123456789abcdef0123456789abcdef", 7, "controlled-upload-secret");
            AssetId id = AssetId.FromGuid(Guid.ParseExact(session.UploadId, "N"));
            var record = new AssetRecord(id, "public", AssetStorageKey.Parse("illustration/" + session.UploadId + ".png"),
                "image/png", ".png", Bytes.Length, sha256, 1, 1, 7, ContentAssetState.Active, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch);
            Upload = new("fsusblog.upload-asset-observation.v1", session.UploadId, record, "/never-an-authority",
                [new(id, ContentAssetSourceKinds.Revision, "4", 42, 1, null, DateTimeOffset.UnixEpoch)], new('d', 64), new('e', 64));
            Request = new(new(Identity(ArticlePackageIdentityKind.Article, 1), 42, RevisionCompareSourceKind.CurrentRevision,
                4, ArticleVaultManifestCodec.CaptureSourceBytes(Package.RawMarkdown.AsSpan()), Package.PackageDigest),
                Identity(ArticlePackageIdentityKind.Asset, 2), id, sha256, session);
            Inventory =
            [
                new("manifest.json", ArticlePackageEntryKind.RegularFile, 1, 1),
                new("checksums.json", ArticlePackageEntryKind.RegularFile, 1, 1),
                new("articles/" + Request.Article.PortableArticle.FileNameToken + ".md", ArticlePackageEntryKind.RegularFile, 7, 7),
                new("assets/" + Request.PortableAsset.FileNameToken + ".png", ArticlePackageEntryKind.RegularFile, Bytes.Length, Bytes.Length)
            ];
            Sources.ReadCurrentAuthorizedAsync(Arg.Any<AuthoringCanvasOwner>(), Arg.Any<int>(), Arg.Any<Guid>(), Arg.Any<CancellationToken>())
                .Returns(call => new AuthoringArticleCurrentSourceReadResult(RevisionComparePackageReadStatus.Available,
                    new(call.ArgAt<AuthoringCanvasOwner>(0), call.ArgAt<Guid>(2), new(1, 1, 1, 1, new('a', 64), Authorized),
                        new(call.ArgAt<int>(1), AuthoringCanvasArticleState.Current,
                            Packages.GetValueOrDefault(call.ArgAt<int>(1), Package).RevisionId!.Value, new(4, "Current", null),
                            new Dictionary<long, AuthoringCanvasArticleRevisionDisplayFact>()), Packages.GetValueOrDefault(call.ArgAt<int>(1), Package)), "controlled"));
            Files.ReadCommittedUploadInputAsync(Arg.Any<UploadSessionAccess>(), Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(_ =>
            {
                BeforeUpload?.Invoke();
                return UploadAvailable ? Result<UploadAssetPreview>.Success(new(Upload, Bytes))
                    : Result<UploadAssetPreview>.Failure(ErrorCode.NotFound, "UPLOAD_SESSION_NOT_FOUND");
            });
            Files.ObserveCommittedUploadAsync(Arg.Any<UploadSessionAccess>(), Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(_ =>
            {
                BeforeUpload?.Invoke();
                return UploadAvailable ? Result<UploadAssetObservation>.Success(Upload)
                    : Result<UploadAssetObservation>.Failure(ErrorCode.NotFound, "UPLOAD_SESSION_NOT_FOUND");
            });
            Reader = new(new(Sources, Files));
        }

        internal byte[] Bytes { get; } = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB14AAAAASUVORK5CYII=");
        internal Dictionary<int, RevisionComparePackage> Packages { get; } = [];
        internal RevisionComparePackage Package => Packages[42];
        internal bool Authorized { get; set; } = true;
        internal bool UploadAvailable { get; set; } = true;
        internal Action? BeforeUpload
        {
            get; set;
        }
        internal ClaimsPrincipal Principal
        {
            get; set;
        } = new(new ClaimsIdentity(
            [new("admin_id", "7"), new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind)], "controlled-unit"));
        internal IAuthoringArticleCurrentSourceReader Sources { get; } = Substitute.For<IAuthoringArticleCurrentSourceReader>();
        internal IFileService Files { get; } = Substitute.For<IFileService>();
        internal UploadAssetObservation Upload
        {
            get; set;
        }
        internal ArticlePackageCurrentAssetRequest Request
        {
            get; set;
        }
        internal ArticlePackageInventoryEntry[] Inventory
        {
            get;
        }
        internal ArticlePackageCurrentAssetReader Reader
        {
            get;
        }

        internal void AddArticle(int articleId)
            => Packages.Add(articleId, RevisionComparePackageSeal.Create(articleId, RevisionCompareSourceKind.CurrentRevision,
                articleId == 42 ? "revision:4:1" : "revision:5:1", articleId == 42 ? 4 : 5, 1, null, null,
                "source\n"u8, [RevisionCompareMetadataRegistry.String("title", "Current")],
                [RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Rights),
                    RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                    RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)]));

        internal Task<ArticlePackageCurrentAssetInput> ReadAsync(CancellationToken cancellationToken = default)
            => Reader.ReadCurrentRevisionInputAsync([Request], Principal, Inventory, cancellationToken);
    }
}
