using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Globalization;
using System.IO.Compression;
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
using FsusBlog.Server.Services.DocumentExport;
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
/// Complete current-producer to writer controls with real PostgreSQL and native original upload bytes.
/// Only unused mutation dependencies are substitutes; they must receive no calls.
/// </summary>
[Trait("Dependency", "Docker")]
[Trait("Platform", "Unix")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ArticlePackageFrozenExportCurrentAssetsPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Theory]
    [InlineData(68)]
    [InlineData(20_971_520)]
    public async Task RealPgNativeSnapshotExpectedPlanAndZipRoundTrip(int byteLength)
    {
        string root;
        await using (var setup = await CreateAsync(byteLength))
        {
            root = setup.Root;
            var input = await PlannerInputAsync(setup);
            var expected = await ExpectedAsync(setup, input);
            var record = Assert.Single(expected.Assets!).Record;
            var first = await WriteAsync(setup, input, expected);
            Assert.True(first.Result.IsValid, first.Result.ReasonCode);
            var candidate = Assert.IsType<ArticlePackageFrozenExportCandidate>(first.Candidate);
            var second = await WriteAsync(setup, input, expected);
            Assert.True(second.Result.IsValid, second.Result.ReasonCode);
            Assert.Equal(candidate.CopyArchiveBytes(), second.Candidate!.CopyArchiveBytes());
            Assert.Equal(record, Assert.Single(expected.Assets!).Record);
            string assetPath = Assert.Single(expected.Manifest.Assets!.Assets).Metadata.PackagePath;
            Assert.Equal(setup.Bytes, candidate.Candidate.CopyFileBytes(assetPath));
            Assert.Equal(expected.Manifest.SemanticDigest, candidate.Candidate.Manifest.SemanticDigest);
            Assert.True(ArticlePackageImportAssetCandidateValidator.TryReadCandidate(candidate.CopyArchiveBytes(),
                candidate.Candidate.Manifest.Assets, out var read).IsValid);
            Assert.Equal(candidate.Candidate.PackageBytesDigest, read!.Candidate.PackageBytesDigest);
            Assert.False(candidate.RequireExportAuthority().IsValid);
            Assert.False(expected.RequirePackageAuthority().IsValid);
            Assert.False(read.RequireArchiveAuthority().IsValid);
            Assert.False(candidate.Candidate.Manifest.Assets!.RequireAssetAuthority().IsValid);
            string manifest = Encoding.UTF8.GetString(candidate.Candidate.CopyFileBytes(ArticlePackageInventory.ManifestPath));
            Assert.DoesNotContain(setup.Session.UploadToken!, manifest, StringComparison.Ordinal);
            Assert.DoesNotContain(setup.Root, manifest, StringComparison.Ordinal);
            Assert.DoesNotContain(record.StorageKey.Value, manifest, StringComparison.Ordinal);
            using var stream = new MemoryStream(candidate.CopyArchiveBytes(), false);
            using var zip = new ZipArchive(stream, ZipArchiveMode.Read);
            Assert.Equal(4, zip.Entries.Count);
            Assert.Equal(zip.Entries.Select(entry => entry.FullName).Order(StringComparer.Ordinal), zip.Entries.Select(entry => entry.FullName));
            Assert.All(zip.Entries, entry =>
            {
                Assert.Equal(entry.Length, entry.CompressedLength);
                Assert.Equal(new DateTime(1980, 1, 1), entry.LastWriteTime.DateTime);
            });
            Assert.DoesNotContain(candidate.Candidate.FilePaths, path => path.Contains("font", StringComparison.Ordinal));
            Assert.Equal(1, await setup.Db.Queryable<ContentAssetReference>().CountAsync());
            Assert.Equal(0, await setup.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        }
        Assert.False(Directory.Exists(root));
    }

    [Theory]
    [InlineData("storage-key")]
    [InlineData("owner")]
    [InlineData("created")]
    [InlineData("updated")]
    public async Task SameNativeBytesWithDifferentActualLedgerRecordRefuseFrozenExpectation(string field)
    {
        await using var setup = await CreateAsync(68);
        var input = await PlannerInputAsync(setup);
        var expected = await ExpectedAsync(setup, input);
        var original = await WriteAsync(setup, input, expected);
        Assert.True(original.Result.IsValid, original.Result.ReasonCode);
        var record = Assert.Single(expected.Assets!).Record;
        setup.Db.Ado.ExecuteCommand(field switch
        {
            "created" => "UPDATE content_asset SET created_at_utc = created_at_utc - INTERVAL '1 second';",
            "updated" => "UPDATE content_asset SET updated_at_utc = updated_at_utc + INTERVAL '1 second';",
            "owner" => "UPDATE content_asset SET owner_admin_principal_id = owner_admin_principal_id + 1;",
            _ => "UPDATE content_asset SET storage_key = 'content/public/different.png';"
        });
        Assert.Equal(setup.Bytes, await File.ReadAllBytesAsync(setup.AssetPath));
        var row = await setup.Db.Queryable<ContentAsset>().SingleAsync();
        Assert.Equal(record.Sha256, row.Sha256);
        Assert.Equal(record.MimeType, row.MimeType);
        Assert.Equal(record.SizeBytes, row.SizeBytes);
        if (field is "created" or "updated")
        {
            var current = await setup.ReadAsync();
            Assert.Equal(expected.Manifest.Assets!.ComponentDigest, current.Collection.ComponentDigest);
            Assert.NotEqual(record, Assert.Single(current.Sources).Record);
        }
        var refused = await WriteAsync(setup, input, expected);
        Refused(refused);
        if (field is "created" or "updated")
        {
            Assert.Equal("article_package_manifest_asset_record_snapshot_mismatch", refused.Result.ReasonCode);
        }
        setup.Db.Ado.ExecuteCommand(field switch
        {
            "created" => "UPDATE content_asset SET created_at_utc = created_at_utc + INTERVAL '1 second';",
            "updated" => "UPDATE content_asset SET updated_at_utc = updated_at_utc - INTERVAL '1 second';",
            "owner" => "UPDATE content_asset SET owner_admin_principal_id = owner_admin_principal_id - 1;",
            _ => "UPDATE content_asset SET storage_key = @OriginalKey;"
        }, new SugarParameter("@OriginalKey", record.StorageKey.Value));
        var recovered = await WriteAsync(setup, input, expected);
        Assert.True(recovered.Result.IsValid, recovered.Result.ReasonCode);
        Assert.Equal(original.Candidate!.CopyArchiveBytes(), recovered.Candidate!.CopyArchiveBytes());
    }

    [Theory]
    [InlineData("created")]
    [InlineData("updated")]
    [InlineData("permission")]
    [InlineData("cancel")]
    public async Task FinalActualReadAfterZipRefusesDriftOrCancellationAndRecoveryIsStable(string fault)
    {
        await using var setup = await CreateAsync(68);
        var input = await PlannerInputAsync(setup);
        var expected = await ExpectedAsync(setup, input);
        var original = await WriteAsync(setup, input, expected);
        Assert.True(original.Result.IsValid, original.Result.ReasonCode);
        var probe = new ObservedSource(setup.Sources);
        var bound = await ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndBindCandidatePlanAsync(
            expected, [input], [setup.Request], setup.Principal, setup.Inventory, probe, setup.Reader);
        Assert.True(bound.IsValid, bound.ReasonCode);
        int firstPassReads = probe.Reads;
        Assert.True(firstPassReads > 0);
        using var cancellation = new CancellationTokenSource();
        probe.Reads = 0;
        probe.BeforeRead = () =>
        {
            if (probe.Reads != firstPassReads + 1)
            {
                return;
            }
            switch (fault)
            {
                case "created":
                    setup.Db.Ado.ExecuteCommand("UPDATE content_asset SET created_at_utc = created_at_utc - INTERVAL '1 second';");
                    break;
                case "updated":
                    setup.Db.Ado.ExecuteCommand("UPDATE content_asset SET updated_at_utc = updated_at_utc + INTERVAL '1 second';");
                    break;
                case "permission":
                    setup.Db.Ado.ExecuteCommand("UPDATE admin_principal SET permissions = ''; ");
                    break;
                default:
                    cancellation.Cancel();
                    break;
            }
        };
        var result = await WriteAsync(setup, input, expected, probe, cancellation.Token);
        Refused(result);
        Assert.True(probe.Reads >= firstPassReads + 1, "The final original source read must execute after the first bound pass and ZIP creation.");
        if (fault == "cancel")
        {
            Assert.Equal("article_package_export_cancelled", result.Result.ReasonCode);
        }
        if (fault is "created" or "updated")
        {
            Assert.Equal("article_package_manifest_asset_record_snapshot_mismatch", result.Result.ReasonCode);
        }
        probe.BeforeRead = null;
        if (fault == "created")
        {
            setup.Db.Ado.ExecuteCommand("UPDATE content_asset SET created_at_utc = created_at_utc + INTERVAL '1 second';");
        }
        else if (fault == "updated")
        {
            setup.Db.Ado.ExecuteCommand("UPDATE content_asset SET updated_at_utc = updated_at_utc - INTERVAL '1 second';");
        }
        else if (fault == "permission")
        {
            setup.Db.Ado.ExecuteCommand("UPDATE admin_principal SET permissions = @Permission;", new SugarParameter("@Permission", AdminPermissions.ArticleWrite));
        }
        var recovered = fault == "cancel"
            ? await WriteWithFreshRequestScopeAsync(setup, input, expected)
            : await WriteAsync(setup, input, expected);
        Assert.True(recovered.Result.IsValid, recovered.Result.ReasonCode);
        Assert.Equal(original.Candidate!.CopyArchiveBytes(), recovered.Candidate!.CopyArchiveBytes());
    }

    [Theory]
    [InlineData("bytes")]
    [InlineData("symlink")]
    [InlineData("frozen-user")]
    public async Task OriginalNativeGuardOrFrozenUserBindingRejectsTamperWithoutPartialArchive(string fault)
    {
        await using var setup = await CreateAsync(68);
        var input = await PlannerInputAsync(setup);
        var expected = await ExpectedAsync(setup, input);
        var frozen = Frozen(setup, input, expected);
        string backup = setup.AssetPath + ".held";
        if (fault == "bytes")
        {
            byte[] changed = setup.Bytes.ToArray();
            changed[^1] ^= 1;
            await File.WriteAllBytesAsync(setup.AssetPath, changed);
        }
        else if (fault == "symlink")
        {
            File.Move(setup.AssetPath, backup);
            File.CreateSymbolicLink(setup.AssetPath, backup);
        }
        else
        {
            frozen = frozen with
            {
                Input = DocumentExportContractValidator.Seal(frozen.Input with
                {
                    UserId = frozen.Input.UserId + 1
                })
            };
        }
        var result = await ArticlePackageFrozenExportCandidateWriter.ReadCurrentAssetsAndWriteCandidateAsync(
            expected, [input], [setup.Request], setup.Principal, setup.Inventory, setup.Sources, setup.Reader, [frozen]);
        Refused(result);
        if (fault == "frozen-user")
        {
            Assert.Equal("article_package_export_source_binding_mismatch", result.Result.ReasonCode);
        }
        if (fault == "symlink")
        {
            File.Delete(setup.AssetPath);
            File.Move(backup, setup.AssetPath);
        }
        else if (fault == "bytes")
        {
            await File.WriteAllBytesAsync(setup.AssetPath, setup.Bytes);
        }
        var recovered = await WriteAsync(setup, input, expected);
        Assert.True(recovered.Result.IsValid, recovered.Result.ReasonCode);
    }

    private static void Refused((ArticlePackageManifestCandidateResult Result, ArticlePackageFrozenExportCandidate? Candidate) result)
    {
        Assert.False(result.Result.IsValid);
        Assert.NotNull(result.Result.ReasonCode);
        Assert.Null(result.Candidate);
    }

    private static async Task<ArticlePackageManifestCandidatePlan> ExpectedAsync(Setup setup, ArticlePackageManifestCandidateInput input)
    {
        var result = await ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndCreateCandidatePlanAsync(
            [input], [setup.Request], setup.Principal, setup.Inventory, setup.Sources, setup.Reader);
        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Equal(setup.Bytes, Assert.Single(result.Plan!.Assets!).CopySourceBytes());
        return result.Plan;
    }

    private static Task<(ArticlePackageManifestCandidateResult Result, ArticlePackageFrozenExportCandidate? Candidate)> WriteAsync(
        Setup setup, ArticlePackageManifestCandidateInput input, ArticlePackageManifestCandidatePlan expected,
        IAuthoringArticleCurrentSourceReader? source = null, CancellationToken cancellationToken = default)
        => ArticlePackageFrozenExportCandidateWriter.ReadCurrentAssetsAndWriteCandidateAsync(
            expected, [input], [setup.Request], setup.Principal, setup.Inventory, source ?? setup.Sources,
            setup.Reader, [Frozen(setup, input, expected)], cancellationToken);

    // A cancelled SqlSugar request scope retains its cancelled database token. The next
    // request uses fresh original DB/FileService/source instances; no token or grant is reset.
    private static async Task<(ArticlePackageManifestCandidateResult Result, ArticlePackageFrozenExportCandidate? Candidate)>
        WriteWithFreshRequestScopeAsync(Setup setup, ArticlePackageManifestCandidateInput input,
            ArticlePackageManifestCandidatePlan expected)
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(setup.Db.CurrentConnectionConfig.ConnectionString);
        await using ServiceProvider services = new ServiceCollection().AddSingleton<ISqlSugarClient>(db).BuildServiceProvider();
        var files = new FileService(setup.Files.StoragePaths, NullLogger<FileService>.Instance,
            services.GetRequiredService<IServiceScopeFactory>());
        var drafts = new AuthoringDraftLifecycleService(db, setup.Mutations, setup.Publication, setup.Audit);
        var packages = new AuthoringRevisionComparePackageReader(new AuthoringRevisionCompareAuthority(db, drafts),
            new AuthoringRevisionCompareDraftContextAuthority([]));
        var sources = new AuthoringArticleCurrentSourceReader(new PostgresAuthoringCanvasArticleReferenceReader(db), packages);
        var reader = new ArticlePackageCurrentAssetReader(new CurrentArticleUploadAssetBindingReader(sources, files));
        return await ArticlePackageFrozenExportCandidateWriter.ReadCurrentAssetsAndWriteCandidateAsync(
            expected, [input], [setup.Request], setup.Principal, setup.Inventory, sources, reader,
            [Frozen(setup, input, expected)]);
    }

    // Real native bytes from the owned plan enter the original document validator. Opaque document
    // metadata/property coordinates and the declared-font fixture establish no missing authority.
    private static ArticlePackageFrozenExportCandidateInput Frozen(Setup setup, ArticlePackageManifestCandidateInput input,
        ArticlePackageManifestCandidatePlan expected)
    {
        DocumentExportAsset[] fonts = DocumentExportReadingStyleAuthority.RequiredFonts.Select((font, index) =>
        {
            byte[] bytes = Encoding.ASCII.GetBytes($"wOF2-synthetic-{index}");
            return new DocumentExportAsset($"font-{index}", "font/woff2", DocumentExportDigest.ComputeBytes(bytes),
                bytes.ToImmutableArray(), string.Empty, "font", font.Family, font.Weight, font.Style);
        }).ToArray();
        var observed = Assert.Single(expected.Assets!);
        byte[] nativeBytes = observed.CopySourceBytes();
        var image = new DocumentExportAsset(observed.Record.Id.ToString(), observed.Record.MimeType,
            DocumentExportDigest.ComputeBytes(nativeBytes), nativeBytes.ToImmutableArray(), "actual owned upload", "image", string.Empty, 0, "normal");
        DocumentExportAsset[] assets = [.. fonts, image];
        byte[] markdown = expected.Articles.Single().CopySourceBytes();
        string opaqueDigest = DocumentExportDigest.ComputeBytes("synthetic-provider-coordinate"u8);
        var frozen = new DocumentExportFrozenInput(DocumentExportContractCatalog.InputSchema, "actual-current-native-input",
            setup.Session.OwnerAdminPrincipalId, input.PropertySnapshot.Coordinates.SiteScope,
            new(DocumentExportCoordinateKind.Revision, input.Article.ArticleId, null, input.Article.ArticleRevisionId, null, input.Article.RevisionNo!.Value),
            markdown.ToImmutableArray(), DocumentExportDigest.ComputeBytes(markdown), opaqueDigest, opaqueDigest,
            DocumentExportContractValidator.ComputeAssetManifestDigest(assets), DocumentExportContractValidator.ComputeFontManifestDigest(assets),
            "fsusui.markdown-renderer", "current-v1", opaqueDigest, DocumentExportReadingStyleAuthority.LayoutProfile,
            DocumentExportReadingStyleAuthority.LightThemeProfile, "zh-Hant", assets.ToImmutableArray(),
            DocumentExportReadingStyleAuthority.AuthorityDigest, null, string.Empty);
        frozen = DocumentExportContractValidator.Seal(frozen);
        DocumentExportContractValidator.Validate(frozen);
        return new(input.TitleBinding.PortableArticle, frozen);
    }

    // Counts/delegates actual source reads; it creates no source facts or permission observations.
    private sealed class ObservedSource(IAuthoringArticleCurrentSourceReader inner) : IAuthoringArticleCurrentSourceReader
    {
        internal int Reads
        {
            get; set;
        }
        internal Action? BeforeRead
        {
            get; set;
        }

        public Task<AuthoringArticleCurrentSourceReadResult> ReadCurrentAuthorizedAsync(
            AuthoringCanvasOwner owner, int articleId, Guid requestId, CancellationToken cancellationToken = default)
        {
            Reads++;
            BeforeRead?.Invoke();
            return inner.ReadCurrentAuthorizedAsync(owner, articleId, requestId, cancellationToken);
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

    private async Task<Setup> CreateAsync(int byteLength)
    {
        Assert.True(OperatingSystem.IsLinux() && RuntimeInformation.ProcessArchitecture is Architecture.X64 or Architecture.Arm64,
            "Native qualification requires Linux x64/arm64; unsupported platforms must remain UNRUN.");
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        string root = Path.Combine(Path.GetTempPath(), "fsus-writer-native-chain-" + Guid.NewGuid().ToString("N"));
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
            try
            {
                Assert.Empty(Mutations.ReceivedCalls());
                Assert.Empty(Publication.ReceivedCalls());
                Assert.Empty(Audit.ReceivedCalls());
            }
            finally
            {
                await Services.DisposeAsync();
                Db.Dispose();
                Directory.Delete(Root, recursive: true);
            }
        }
    }
}
