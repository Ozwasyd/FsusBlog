using System.Buffers.Binary;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests;

/// <summary>
/// Real source, permission, content-block, upload-session, native-file and ledger producers.
/// Only unused mutation dependencies are substitutes; they must receive no calls.
/// </summary>
[Trait("Dependency", "Docker")]
[Trait("Platform", "Unix")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ArticlePackageManifestCandidatePlannerCurrentAssetsPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Theory]
    [InlineData(68)]
    [InlineData(20_971_520)]
    public async Task RealObserverFeedsCreateAndBindWithIndependentOwnedBytesAndNoAuthority(int length)
    {
        string root;
        await using (var setup = await CreateAsync(length))
        {
            root = setup.Root;
            var input = await PlannerInputAsync(setup);
            var before = (await setup.Files.ObserveCommittedUploadAsync(setup.Session, setup.Request.Sha256)).Value!;
            var created = await CreatePlanAsync(setup, [input]);
            Assert.True(created.IsValid, created.ReasonCode);
            var plan = created.Plan!;
            var observed = Assert.Single(created.Observations!);
            Assert.Equal(input.TitleBinding.SourceRevisionId, observed.Observation.Reference.SourceRevision);
            Assert.Equal(setup.Request.Article.Source, observed.Observation.Source);
            var asset = Assert.Single(plan.Assets!);
            Assert.Equal(setup.Bytes, asset.CopySourceBytes());
            Assert.Equal(setup.Bytes.Length, asset.Record.SizeBytes);
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(setup.Bytes)), asset.RawByteSha256);
            Assert.Equal(setup.Request.Article.Source.Sha256, Assert.Single(plan.Articles).Manifest.SourceBytes.Sha256);
            byte[] detached = asset.CopySourceBytes();
            detached[0] ^= 1;
            Assert.Equal(setup.Bytes, asset.CopySourceBytes());
            var bound = await ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndBindCandidatePlanAsync(
                plan, [input], [setup.Request], setup.Principal, setup.Inventory, setup.Sources, setup.Reader);
            Assert.True(bound.IsValid, bound.ReasonCode);
            Assert.Equal(plan.Manifest.SemanticDigest, bound.Plan!.Manifest.SemanticDigest);
            Assert.Equal(created.Observations, bound.Observations);
            byte[] encoded = ArticlePackageManifestCandidateCodec.WriteCandidate(plan.Manifest, plan.Manifest.Assets, plan.Inventory);
            string document = Encoding.UTF8.GetString(encoded);
            Assert.DoesNotContain(setup.Session.UploadToken!, document, StringComparison.Ordinal);
            Assert.DoesNotContain(setup.Root, document, StringComparison.Ordinal);
            Assert.DoesNotContain(asset.Record.StorageKey.Value, document, StringComparison.Ordinal);
            Assert.Equal("article_package_manifest_authority_unavailable", plan.RequirePackageAuthority().ReasonCode);
            Assert.False(plan.Manifest.Assets!.RequireAssetAuthority().IsValid);
            var after = (await setup.Files.ObserveCommittedUploadAsync(setup.Session, setup.Request.Sha256)).Value!;
            Assert.Equal(before.AssetVersionSha256, after.AssetVersionSha256);
            Assert.Equal(before.ReferenceLedgerSha256, after.ReferenceLedgerSha256);
            Assert.Equal(1, await setup.Db.Queryable<ContentAssetReference>().CountAsync());
            Assert.Equal(0, await setup.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
            Assert.Empty(setup.Mutations.ReceivedCalls());
            Assert.Empty(setup.Publication.ReceivedCalls());
            Assert.Empty(setup.Audit.ReceivedCalls());
        }
        Assert.False(Directory.Exists(root));
    }

    [Theory]
    [InlineData("revision-number")]
    [InlineData("revision-id")]
    [InlineData("article-id")]
    [InlineData("title")]
    [InlineData("summary")]
    [InlineData("category")]
    [InlineData("tags")]
    [InlineData("source-newlines")]
    [InlineData("site")]
    [InlineData("owner")]
    [InlineData("request-portable")]
    [InlineData("request-kind")]
    [InlineData("request-package")]
    [InlineData("request-byte-facts")]
    [InlineData("missing-session")]
    [InlineData("duplicate-request")]
    [InlineData("omitted-request")]
    public async Task RealBridgeRefusesCoordinateMetadataRawByteAndClosureFaults(string fault)
    {
        await using var setup = await CreateAsync(68);
        var original = await PlannerInputAsync(setup);
        var valid = await CreatePlanAsync(setup, [original]);
        Assert.True(valid.IsValid, valid.ReasonCode);
        var input = original;
        ArticlePackageCurrentAssetRequest[] requests = [setup.Request];
        switch (fault)
        {
            case "revision-number":
                input = RebindInput(original, original.Article with
                {
                    RevisionNo = original.Article.RevisionNo + 1
                });
                break;
            case "revision-id":
                input = RebindInput(original, original.Article with
                {
                    ArticleRevisionId = original.Article.ArticleRevisionId + 1
                });
                break;
            case "article-id":
                input = RebindInput(original, original.Article with
                {
                    ArticleId = original.Article.ArticleId + 1000
                });
                break;
            case "title":
                input = RebindInput(original, original.Article with
                {
                    Title = "forged title"
                });
                break;
            case "summary":
                input = RebindInput(original, original.Article with
                {
                    Summary = "forged summary"
                });
                break;
            case "category":
                input = RebindInput(original, original.Article with
                {
                    CategoryId = 2
                });
                break;
            case "tags":
                input = RebindInput(original, original.Article with
                {
                    TagIds = [1]
                });
                break;
            case "source-newlines":
                input = RebindInput(original, original.Article with
                {
                    MarkdownContent = original.Article.MarkdownContent.Replace("\r\n", "\n", StringComparison.Ordinal)
                }, replaceBytes: true);
                break;
            case "site":
                input = RebindInput(original, original.Article, site: "foreign-site");
                break;
            case "owner":
                input = RebindInput(original, original.Article, owner: setup.Session.OwnerAdminPrincipalId + 1);
                break;
            case "request-portable":
                requests[0] = requests[0] with
                {
                    Article = requests[0].Article with
                    {
                        PortableArticle = ArticlePackageCurrentAssetReaderTests.Identity(ArticlePackageIdentityKind.Article, 99)
                    }
                };
                break;
            case "request-kind":
                requests[0] = requests[0] with
                {
                    Article = requests[0].Article with
                    {
                        SourceKind = RevisionCompareSourceKind.HistoricalRevision
                    }
                };
                break;
            case "request-package":
                requests[0] = requests[0] with
                {
                    Article = requests[0].Article with
                    {
                        RevisionPackageSha256 = new string('f', 64)
                    }
                };
                break;
            case "request-byte-facts":
                requests[0] = requests[0] with
                {
                    Article = requests[0].Article with
                    {
                        Source = requests[0].Article.Source with
                        {
                            HasUtf8Bom = false
                        }
                    }
                };
                break;
            case "missing-session":
                requests[0] = requests[0] with
                {
                    Session = null
                };
                break;
            case "duplicate-request":
                requests = [setup.Request, setup.Request];
                break;
            case "omitted-request":
                requests = [];
                break;
        }
        await RefusedAsync(() => ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndCreateCandidatePlanAsync(
            [input], requests, setup.Principal, setup.Inventory, setup.Sources, setup.Reader));
        await RefusedAsync(() => ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndBindCandidatePlanAsync(
            valid.Plan!, [input], requests, setup.Principal, setup.Inventory, setup.Sources, setup.Reader));
    }

    [Theory]
    [InlineData("permission")]
    [InlineData("head")]
    [InlineData("source")]
    [InlineData("ledger")]
    [InlineData("bytes")]
    [InlineData("native-link")]
    public async Task RealDatabaseNativeAndAuthorizationDriftAfterFreezeExposesNoPlan(string mutation)
    {
        await using var setup = await CreateAsync(68);
        var input = await PlannerInputAsync(setup);
        bool changed = false;
        var instrumented = new ObservedReader(setup.Sources, () =>
        {
            if (changed)
            {
                return;
            }
            changed = true;
            switch (mutation)
            {
                case "permission":
                    setup.Db.Ado.ExecuteCommand("UPDATE admin_principal SET permissions = '';");
                    break;
                case "head":
                    setup.Db.Ado.ExecuteCommand("UPDATE article SET current_revision_id = current_revision_id + 1;");
                    break;
                case "source":
                    setup.Db.Ado.ExecuteCommand("UPDATE article_revision_content_block SET markdown_content = 'changed';");
                    break;
                case "ledger":
                    setup.Db.Ado.ExecuteCommand("DELETE FROM content_asset_reference;");
                    break;
                case "bytes":
                    File.WriteAllBytes(setup.AssetPath, new byte[setup.Bytes.Length]);
                    break;
                case "native-link":
                    string outside = Path.Combine(setup.Root, "outside.png");
                    File.Move(setup.AssetPath, outside);
                    File.CreateSymbolicLink(setup.AssetPath, outside);
                    break;
            }
        }, beforeRead: false);
        await RefusedAsync(() => ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndCreateCandidatePlanAsync(
            [input], [setup.Request], setup.Principal, setup.Inventory, instrumented, setup.Reader));
        Assert.True(changed);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FinalOriginalArticleReadRejectsPermissionRevocationAfterBothAssetPasses(bool bind)
    {
        await using var setup = await CreateAsync(68);
        var input = await PlannerInputAsync(setup);
        var original = await CreatePlanAsync(setup, [input]);
        Assert.True(original.IsValid, original.ReasonCode);
        int calls = 0;
        var instrumented = new ObservedReader(setup.Sources, () =>
        {
            calls++;
            if (calls == 2)
            {
                setup.Db.Ado.ExecuteCommand("UPDATE admin_principal SET permissions = '';");
            }
        }, beforeRead: true);
        var result = bind
            ? await ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndBindCandidatePlanAsync(original.Plan!,
                [input], [setup.Request], setup.Principal, setup.Inventory, instrumented, setup.Reader)
            : await ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndCreateCandidatePlanAsync(
                [input], [setup.Request], setup.Principal, setup.Inventory, instrumented, setup.Reader);
        Assert.Equal(2, calls);
        Assert.False(result.IsValid);
        Assert.Equal("article_package_manifest_current_asset_source_changed", result.ReasonCode);
        Assert.Null(result.Plan);
        Assert.Null(result.Observations);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CancellationAfterActualNativeReadOrFinalArticleReadCannotPublish(bool finalRead)
    {
        await using var setup = await CreateAsync(68);
        var input = await PlannerInputAsync(setup);
        using var cancellation = new CancellationTokenSource();
        int calls = 0;
        bool native = false;
        setup.Db.Aop.OnLogExecuting = (sql, _) =>
        {
            if (sql.Contains("pg_advisory_xact_lock", StringComparison.Ordinal))
            {
                native = true;
            }
        };
        var instrumented = new ObservedReader(setup.Sources, () =>
        {
            calls++;
            if (finalRead && calls == 2)
            {
                cancellation.Cancel();
            }
        }, beforeRead: false);
        void RequireCurrent()
        {
            if (!finalRead && native)
            {
                cancellation.Cancel();
            }
        }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndCreateCandidatePlanAsync(
                [input], [setup.Request], setup.Principal, setup.Inventory, instrumented, setup.Reader,
                cancellation.Token, RequireCurrent));
        Assert.True(native);
        Assert.True(cancellation.IsCancellationRequested);
    }

    [Fact]
    public async Task CallerCollectionsCannotReplaceFrozenMappingsDuringRealReads()
    {
        await using var setup = await CreateAsync(68);
        var input = await PlannerInputAsync(setup);
        ArticlePackageManifestCandidateInput[] inputs = [input];
        ArticlePackageCurrentAssetRequest[] requests = [setup.Request];
        var expected = await CreatePlanAsync(setup, inputs);
        bool changed = false;
        var instrumented = new ObservedReader(setup.Sources, () =>
        {
            changed = true;
            inputs[0] = RebindInput(input, input.Article with
            {
                Title = "caller drift"
            });
            requests[0] = setup.Request with
            {
                Session = null
            };
        }, beforeRead: true);
        var result = await ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndCreateCandidatePlanAsync(
            inputs, requests, setup.Principal, setup.Inventory, instrumented, setup.Reader);
        Assert.True(changed);
        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Equal(expected.Plan!.Manifest.SemanticDigest, result.Plan!.Manifest.SemanticDigest);
    }

    [Fact]
    public async Task ActualCurrentObserversDoNotBlessAValidButForeignRoot()
    {
        await using var setup = await CreateAsync(68);
        var input = await PlannerInputAsync(setup);
        var original = await CreatePlanAsync(setup, [input]);
        Assert.True(original.IsValid, original.ReasonCode);
        var row = Assert.Single(original.Plan!.Manifest.Articles) with
        {
            Title = "foreign root title"
        };
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate([row], original.Plan.Manifest.Assets,
            setup.Inventory, out var foreign).IsValid);
        var bound = await ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndBindCandidatePlanAsync(
            new ArticlePackageManifestCandidatePlan(foreign!, original.Plan.Articles.ToArray(), original.Plan.Assets!.ToArray()), [input], [setup.Request], setup.Principal, setup.Inventory, setup.Sources, setup.Reader);
        Assert.False(bound.IsValid);
        Assert.Null(bound.Plan);
        Assert.Null(bound.Observations);
    }

    [Theory]
    [InlineData("created")]
    [InlineData("updated")]
    [InlineData("owner")]
    [InlineData("storage-key")]
    public async Task RealLedgerRecordDriftCannotRebindFrozenBackendPlan(string field)
    {
        await using var setup = await CreateAsync(68);
        var input = await PlannerInputAsync(setup);
        var original = await CreatePlanAsync(setup, [input]);
        Assert.True(original.IsValid, original.ReasonCode);
        string sql = field switch
        {
            "created" => "UPDATE content_asset SET created_at_utc = created_at_utc - INTERVAL '1 second';",
            "updated" => "UPDATE content_asset SET updated_at_utc = updated_at_utc + INTERVAL '1 second';",
            "owner" => "UPDATE content_asset SET owner_admin_principal_id = owner_admin_principal_id + 1;",
            _ => "UPDATE content_asset SET storage_key = 'content/public/different.png';"
        };
        setup.Db.Ado.ExecuteCommand(sql);
        if (field is "created" or "updated")
        {
            var observed = await setup.ReadAsync();
            Assert.Equal(original.Plan!.Manifest.Assets!.ComponentDigest, observed.Collection.ComponentDigest);
            Assert.NotEqual(Assert.Single(original.Plan.Assets!).Record, Assert.Single(observed.Sources).Record);
            var result = await ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndBindCandidatePlanAsync(
                original.Plan, [input], [setup.Request], setup.Principal, setup.Inventory, setup.Sources, setup.Reader);
            Assert.False(result.IsValid);
            Assert.Equal("article_package_manifest_asset_record_snapshot_mismatch", result.ReasonCode);
            Assert.Null(result.Plan);
            Assert.Null(result.Observations);
        }
        else
        {
            await RefusedAsync(() => ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndBindCandidatePlanAsync(
                original.Plan!, [input], [setup.Request], setup.Principal, setup.Inventory, setup.Sources, setup.Reader));
        }
    }

    [Fact]
    public async Task TwoRealCurrentRevisionsShareOneAssetThroughCreateAndStrictBind()
    {
        await using var setup = await CreateAsync(68);
        var first = setup.Request;
        var firstInput = await PlannerInputAsync(setup);
        int articleId = await setup.Db.Insertable(new Article { Title = "Second", CategoryId = 1 }).ExecuteReturnIdentityAsync();
        long blockId = await ArticleRevisionContentBlockStore.GetOrCreateAsync(setup.Db, "second\r\n", DateTime.UtcNow, default);
        long revisionId = await setup.Db.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = 1,
            Title = "Second",
            CategoryId = 1,
            ContentBlockId = blockId,
            CreatedByAdminPrincipalId = setup.Session.OwnerAdminPrincipalId
        }).ExecuteReturnBigIdentityAsync();
        await setup.Db.Updateable<Article>().SetColumns(row => row.CurrentRevisionId == revisionId).Where(row => row.Id == articleId).ExecuteCommandAsync();
        await new ArticleAssetReferenceStore(setup.Db).ReplaceRevisionAsync(revisionId, articleId, [new(first.AssetId, 1, null)]);
        var source = (await setup.Sources.ReadCurrentAuthorizedAsync(new(setup.Session.OwnerAdminPrincipalId, "primary-site"),
            articleId, Guid.CreateVersion7())).Source!;
        var coordinate = new ArticlePackageCurrentAssetArticle(ArticlePackageCurrentAssetReaderTests.Identity(ArticlePackageIdentityKind.Article, 3),
            articleId, RevisionCompareSourceKind.CurrentRevision, revisionId,
            ArticleVaultManifestCodec.CaptureSourceBytes(source.Package.RawMarkdown.AsSpan()), source.Package.PackageDigest);
        var second = first with
        {
            Article = coordinate
        };
        setup.Request = second;
        var secondInput = await PlannerInputAsync(setup);
        setup.Request = first;
        var inventory = setup.Inventory.Append(new ArticlePackageInventoryEntry("articles/" + coordinate.PortableArticle.FileNameToken + ".md",
            ArticlePackageEntryKind.RegularFile, coordinate.Source.ByteLength, coordinate.Source.ByteLength)).ToArray();
        var created = await ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndCreateCandidatePlanAsync(
            [secondInput, firstInput], [second, first], setup.Principal, inventory, setup.Sources, setup.Reader);
        Assert.True(created.IsValid, created.ReasonCode);
        Assert.Equal(2, created.Plan!.Articles.Count);
        Assert.Single(created.Plan.Assets!);
        Assert.Equal(2, created.Plan.Manifest.Assets!.References.Count);
        Assert.Equal(2, created.Observations!.Count);
        var bound = await ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndBindCandidatePlanAsync(
            created.Plan, [firstInput, secondInput], [first, second], setup.Principal, inventory.Reverse().ToArray(), setup.Sources, setup.Reader);
        Assert.True(bound.IsValid, bound.ReasonCode);
        Assert.Equal(created.Plan.Manifest.SemanticDigest, bound.Plan!.Manifest.SemanticDigest);
        Assert.Equal(2, await setup.Db.Queryable<ContentAssetReference>().CountAsync());
        Assert.False(bound.Plan.RequirePackageAuthority().IsValid);
    }

    private static Task<ArticlePackageCurrentAssetPlanResult> CreatePlanAsync(Setup setup,
        ArticlePackageManifestCandidateInput[] inputs)
        => ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndCreateCandidatePlanAsync(
            inputs, [setup.Request], setup.Principal, setup.Inventory, setup.Sources, setup.Reader);

    private static async Task RefusedAsync(Func<Task<ArticlePackageCurrentAssetPlanResult>> action)
    {
        try
        {
            var result = await action();
            Assert.False(result.IsValid);
            Assert.Null(result.Plan);
            Assert.Null(result.Observations);
        }
        catch (ArticlePackageCurrentAssetRejectedException)
        {
        }
        catch (CurrentArticleUploadAssetObservationRejectedException)
        {
        }
    }

    private static async Task<ArticlePackageManifestCandidateInput> PlannerInputAsync(Setup setup)
    {
        var revision = await setup.Db.Queryable<ArticleRevision>().Where(row => row.Id == setup.Request.Article.RevisionId).SingleAsync();
        var source = (await setup.Sources.ReadCurrentAuthorizedAsync(new(setup.Session.OwnerAdminPrincipalId, "primary-site"),
            setup.Request.Article.ArticleId, Guid.CreateVersion7())).Source!;
        byte[] bytes = source.Package.RawMarkdown.ToArray();
        ReadOnlySpan<byte> content = bytes.AsSpan().StartsWith(new byte[] { 0xef, 0xbb, 0xbf }) ? bytes.AsSpan(3) : bytes;
        var article = new ArticleCanonicalInput(revision.ArticleId, revision.Id, revision.RevisionNo, null,
            revision.Title, revision.Summary, revision.CoverImageUrl, revision.CategoryId, [],
            ArticleStatusValues.Draft, null, null, Encoding.UTF8.GetString(content));
        var title = new ArticlePackageTitleSummaryBinding(article.ArticleId, revision.Id, revision.RevisionNo,
            ArticleCanonicalHashV1.ComputeHashHex(article), setup.Request.Article.PortableArticle);
        // The property subset is an explicit candidate, not a fabricated persisted property observation.
        var coordinates = new ArticlePropertySnapshotCoordinates(setup.Session.OwnerAdminPrincipalId, "primary-site", article.ArticleId, 1, revision.Id);
        var snapshot = new ArticlePropertyValueSnapshot(1, coordinates, [], ArticlePropertyValueDigest.ComputeSnapshot(coordinates, []));
        return new(article, title, snapshot, new(coordinates, snapshot.ContentDigest, [], [], []), bytes);
    }

    private static ArticlePackageManifestCandidateInput RebindInput(ArticlePackageManifestCandidateInput input,
        ArticleCanonicalInput article, string? site = null, long? owner = null, bool replaceBytes = false)
    {
        var coordinates = input.PropertySnapshot.Coordinates with
        {
            ArticleId = article.ArticleId,
            ArticleRevisionId = article.ArticleRevisionId!.Value,
            SiteScope = site ?? input.PropertySnapshot.Coordinates.SiteScope,
            DefinitionOwnerUserId = owner ?? input.PropertySnapshot.Coordinates.DefinitionOwnerUserId
        };
        var snapshot = new ArticlePropertyValueSnapshot(1, coordinates, [], ArticlePropertyValueDigest.ComputeSnapshot(coordinates, []));
        var title = new ArticlePackageTitleSummaryBinding(article.ArticleId, article.ArticleRevisionId!.Value, article.RevisionNo!.Value,
            ArticleCanonicalHashV1.ComputeHashHex(article), input.TitleBinding.PortableArticle);
        byte[] bytes = replaceBytes ? Encoding.UTF8.GetBytes(article.MarkdownContent) : input.SourceBytes.ToArray();
        return new(article, title, snapshot, new(coordinates, snapshot.ContentDigest, [], [], []), bytes);
    }

    // Instrumentation delegates to the actual original PG reader and never creates an observation.
    private sealed class ObservedReader(IAuthoringArticleCurrentSourceReader inner, Action onRead, bool beforeRead)
        : IAuthoringArticleCurrentSourceReader
    {
        public async Task<AuthoringArticleCurrentSourceReadResult> ReadCurrentAuthorizedAsync(AuthoringCanvasOwner owner,
            int articleId, Guid requestId, CancellationToken cancellationToken = default)
        {
            if (beforeRead)
            {
                onRead();
            }
            var result = await inner.ReadCurrentAuthorizedAsync(owner, articleId, requestId, cancellationToken);
            if (!beforeRead)
            {
                onRead();
            }
            return result;
        }
    }

    private async Task<Setup> CreateAsync(int byteLength)
    {
        Assert.True(OperatingSystem.IsLinux() && RuntimeInformation.ProcessArchitecture is Architecture.X64 or Architecture.Arm64,
            "Native qualification requires Linux x64/arm64; unsupported platforms must remain UNRUN.");
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        string root = Path.Combine(Path.GetTempPath(), "fsus-planner-current-asset-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        ServiceProvider services = new ServiceCollection().AddSingleton<ISqlSugarClient>(db).BuildServiceProvider();
        try
        {
            PostgresSqlSugarTestClient.InitTables(db, typeof(AdminPrincipal), typeof(Article), typeof(ArticleRevision),
                typeof(ArticleRevisionContentBlock), typeof(ArticleRightsSnapshot), typeof(ArticleResponsibilitySnapshot),
                typeof(ArticlePublicationRecord), typeof(ContentAsset), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem));
            long adminId = await db.Insertable(new AdminPrincipal { Handle = "task-owner", Permissions = AdminPermissions.ArticleWrite }).ExecuteReturnBigIdentityAsync();
            int articleId = await db.Insertable(new Article { Title = "Source", CategoryId = 1 }).ExecuteReturnIdentityAsync();
            long blockId = await ArticleRevisionContentBlockStore.GetOrCreateAsync(db, "\ufeffsource  \r\n末尾\n", DateTime.UtcNow, default);
            long revisionId = await db.Insertable(new ArticleRevision
            {
                ArticleId = articleId,
                RevisionNo = 1,
                Title = "Source",
                CategoryId = 1,
                ContentBlockId = blockId,
                CreatedByAdminPrincipalId = adminId
            }).ExecuteReturnBigIdentityAsync();
            await db.Updateable<Article>().SetColumns(row => row.CurrentRevisionId == revisionId).Where(row => row.Id == articleId).ExecuteCommandAsync();
            byte[] bytes = PngBytes(byteLength);
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
            var files = new FileService(ReleaseStorageTestPaths.Create(root), NullLogger<FileService>.Instance,
                services.GetRequiredService<IServiceScopeFactory>());
            var initialized = await files.InitUploadSessionAsync(adminId, new UploadInitRequestDto
            {
                FileName = "asset.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = bytes.Length,
                ChunkSize = 512 * 1024,
                Sha256 = sha256
            });
            Assert.True(initialized.IsSuccess, initialized.Error.Message);
            var session = new UploadSessionAccess(initialized.Value!.UploadId, adminId, initialized.Value.UploadToken);
            for (int offset = 0, part = 0; offset < bytes.Length; offset += initialized.Value.ChunkSize, part++)
            {
                int count = Math.Min(initialized.Value.ChunkSize, bytes.Length - offset);
                using var stream = new MemoryStream(bytes, offset, count);
                var uploaded = await files.UploadPartAsync(session, part, offset, new FormFile(stream, 0, count, "file", "asset.png"),
                    Convert.ToHexStringLower(SHA256.HashData(bytes.AsSpan(offset, count))));
                Assert.True(uploaded.IsSuccess, uploaded.Error.Message);
            }
            var completed = await files.CompleteUploadAsync(session, sha256);
            Assert.True(completed.IsSuccess, completed.Error.Message);
            AssetId assetId = AssetId.FromGuid(Guid.ParseExact(session.UploadId, "N"));
            await new ArticleAssetReferenceStore(db).ReplaceRevisionAsync(revisionId, articleId, [new(assetId, 1, null)]);
            var mutations = Substitute.For<IArticleCoreService>();
            var publication = Substitute.For<IArticlePublicationValidator>();
            var audit = Substitute.For<IAuthoringAuditWriter>();
            var authoring = new AuthoringDraftLifecycleService(db, mutations, publication, audit);
            var packages = new AuthoringRevisionComparePackageReader(new AuthoringRevisionCompareAuthority(db, authoring),
                new AuthoringRevisionCompareDraftContextAuthority([]));
            var sources = new AuthoringArticleCurrentSourceReader(new PostgresAuthoringCanvasArticleReferenceReader(db), packages);
            var sourceRead = await sources.ReadCurrentAuthorizedAsync(new(adminId, "primary-site"), articleId, Guid.CreateVersion7());
            Assert.Equal(RevisionComparePackageReadStatus.Available, sourceRead.Status);
            var source = sourceRead.Source!;
            var article = new ArticlePackageCurrentAssetArticle(ArticlePackageCurrentAssetReaderTests.Identity(ArticlePackageIdentityKind.Article, 1),
                articleId, RevisionCompareSourceKind.CurrentRevision, revisionId,
                ArticleVaultManifestCodec.CaptureSourceBytes(source.Package.RawMarkdown.AsSpan()), source.Package.PackageDigest);
            var request = new ArticlePackageCurrentAssetRequest(article,
                ArticlePackageCurrentAssetReaderTests.Identity(ArticlePackageIdentityKind.Asset, 2), assetId, sha256, session);
            ArticlePackageInventoryEntry[] inventory =
            [
                new("manifest.json", ArticlePackageEntryKind.RegularFile, 1, 1),
                new("checksums.json", ArticlePackageEntryKind.RegularFile, 1, 1),
                new("articles/" + article.PortableArticle.FileNameToken + ".md", ArticlePackageEntryKind.RegularFile, article.Source.ByteLength, article.Source.ByteLength),
                new("assets/" + request.PortableAsset.FileNameToken + ".png", ArticlePackageEntryKind.RegularFile, bytes.Length, bytes.Length)
            ];
            return new(root, db, services, files, session, bytes, request, inventory, new(new(sources, files)), sources, mutations, publication, audit);
        }
        catch
        {
            await services.DisposeAsync();
            db.Dispose();
            Directory.Delete(root, recursive: true);
            throw;
        }
    }

    // Valid test input: preserve the PNG image and add a bounded ancillary text chunk before IEND.
    private static byte[] PngBytes(int byteLength)
    {
        byte[] png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB14AAAAASUVORK5CYII=");
        if (byteLength == png.Length)
        {
            return png;
        }
        byte[] bytes = new byte[byteLength];
        int offset = png.Length - 12;
        png.AsSpan(0, offset).CopyTo(bytes);
        int textLength = byteLength - png.Length - 12;
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(offset), textLength);
        "tEXt"u8.CopyTo(bytes.AsSpan(offset + 4));
        "fsus\0"u8.CopyTo(bytes.AsSpan(offset + 8));
        bytes.AsSpan(offset + 13, textLength - 5).Fill((byte)'a');
        uint crc = uint.MaxValue;
        foreach (byte value in bytes.AsSpan(offset + 4, textLength + 4))
        {
            crc ^= value;
            for (int bit = 0; bit < 8; bit++)
            {
                crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xedb88320u : crc >> 1;
            }
        }
        BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(offset + 8 + textLength), ~crc);
        png.AsSpan(png.Length - 12).CopyTo(bytes.AsSpan(bytes.Length - 12));
        return bytes;
    }

    private sealed record Setup(string Root, SqlSugarClient Db, ServiceProvider Services, FileService Files,
        UploadSessionAccess Session, byte[] Bytes, ArticlePackageCurrentAssetRequest InitialRequest,
        ArticlePackageInventoryEntry[] Inventory, ArticlePackageCurrentAssetReader Reader,
        IAuthoringArticleCurrentSourceReader Sources,
        IArticleCoreService Mutations, IArticlePublicationValidator Publication, IAuthoringAuditWriter Audit) : IAsyncDisposable
    {
        internal ArticlePackageCurrentAssetRequest Request { get; set; } = InitialRequest;
        internal ClaimsPrincipal Principal
        {
            get;
        } = new(new ClaimsIdentity(
            [new("admin_id", Session.OwnerAdminPrincipalId.ToString(CultureInfo.InvariantCulture)),
                new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind)], "isolated-native-test"));
        internal string AssetPath => Path.Combine(Files.StoragePaths.PublicAssetRoot, "illustration", Session.UploadId + ".png");

        internal Task<ArticlePackageCurrentAssetInput> ReadAsync()
            => Reader.ReadCurrentRevisionInputAsync([Request], Principal, Inventory);

        public async ValueTask DisposeAsync()
        {
            await Services.DisposeAsync();
            Db.Dispose();
            Directory.Delete(Root, recursive: true);
        }
    }
}
