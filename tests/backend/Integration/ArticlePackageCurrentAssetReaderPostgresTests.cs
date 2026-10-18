using System.Buffers.Binary;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

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
public sealed class ArticlePackageCurrentAssetReaderPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Theory]
    [InlineData(68)]
    [InlineData(20_971_520)]
    public async Task RealProducersFeedOriginalMapperWithoutChangingRowsOrGrantingRights(int byteLength)
    {
        string root;
        await using (var setup = await CreateAsync(byteLength))
        {
            root = setup.Root;
            UploadAssetObservation before = (await setup.Files.ObserveCommittedUploadAsync(setup.Session, setup.Request.Sha256)).Value!;
            var input = await setup.ReadAsync();
            var observed = Assert.Single(input.Observations).Observation;
            Assert.Equal(before.Asset, observed.Asset);
            Assert.Equal(before.ReferenceLedgerSha256, observed.ReferenceLedgerSha256);
            Assert.Equal(setup.Request.Article.RevisionPackageSha256, observed.RevisionPackageSha256);
            Assert.Equal(setup.Request.Article.Source, observed.Source);
            Assert.Equal(setup.Bytes, Assert.Single(input.Sources).SourceBytes.ToArray());
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(setup.Bytes)), Assert.Single(input.Collection.Assets).Metadata.Sha256);
            Assert.Equal(setup.Request.Article.RevisionId.ToString(CultureInfo.InvariantCulture), observed.RevisionReferenceSourceKey);
            Assert.NotEqual(setup.Request.AssetId.ToString(), setup.Request.PortableAsset.FileNameToken);
            var repeated = await setup.ReadAsync();
            Assert.Equal(ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(input.Collection),
                ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(repeated.Collection));
            UploadAssetObservation after = (await setup.Files.ObserveCommittedUploadAsync(setup.Session, setup.Request.Sha256)).Value!;
            Assert.Equal(before.AssetVersionSha256, after.AssetVersionSha256);
            Assert.Equal(before.ReferenceLedgerSha256, after.ReferenceLedgerSha256);
            Assert.Single(after.References);
            Assert.Equal(1, await setup.Db.Queryable<ContentAsset>().CountAsync());
            Assert.Equal(1, await setup.Db.Queryable<ContentAssetReference>().CountAsync());
            Assert.Equal(0, await setup.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
            Assert.False(input.Collection.RequireAssetAuthority().IsValid);
            string package = Encoding.UTF8.GetString(ArticlePackageManifestCandidateCodec.WriteAssetCollectionCandidate(input.Collection));
            Assert.DoesNotContain(setup.Session.UploadToken!, package, StringComparison.Ordinal);
            Assert.DoesNotContain(setup.Root, package, StringComparison.Ordinal);
            Assert.DoesNotContain(before.Asset.StorageKey.Value, package, StringComparison.Ordinal);
            Assert.Empty(setup.Mutations.ReceivedCalls());
            Assert.Empty(setup.Publication.ReceivedCalls());
            Assert.Empty(setup.Audit.ReceivedCalls());
        }
        Assert.False(Directory.Exists(root));
    }

    [Theory]
    [InlineData("wrong-token")]
    [InlineData("wrong-owner")]
    [InlineData("wrong-hash")]
    [InlineData("missing-ledger")]
    [InlineData("missing-reference")]
    [InlineData("pending-delete")]
    [InlineData("owner-drift")]
    [InlineData("bytes-drift")]
    [InlineData("symlink")]
    [InlineData("permission")]
    [InlineData("source")]
    [InlineData("revision")]
    public async Task RealNativeAndPostgresNegativeControlsExposeNoCandidate(string mutation)
    {
        await using var setup = await CreateAsync(68);
        Guid assetId = setup.Request.AssetId.Value;
        switch (mutation)
        {
            case "wrong-token":
                setup.Request = setup.Request with
                {
                    Session = setup.Session with
                    {
                        UploadToken = "wrong-token"
                    }
                };
                break;
            case "wrong-owner":
                setup.Request = setup.Request with
                {
                    Session = setup.Session with
                    {
                        OwnerAdminPrincipalId = setup.Session.OwnerAdminPrincipalId + 1
                    }
                };
                break;
            case "wrong-hash":
                setup.Request = setup.Request with
                {
                    Sha256 = new string('f', 64)
                };
                break;
            case "missing-ledger":
                await setup.Db.Deleteable<ContentAsset>().Where(row => row.AssetId == assetId).ExecuteCommandAsync();
                break;
            case "missing-reference":
                await setup.Db.Deleteable<ContentAssetReference>().Where(row => row.AssetId == assetId).ExecuteCommandAsync();
                break;
            case "pending-delete":
                await setup.Db.Updateable<ContentAsset>().SetColumns(row => row.State == ContentAssetStates.PendingDelete)
                    .Where(row => row.AssetId == assetId).ExecuteCommandAsync();
                break;
            case "owner-drift":
                await setup.Db.Updateable<ContentAsset>().SetColumns(row => row.OwnerAdminPrincipalId == setup.Session.OwnerAdminPrincipalId + 1)
                    .Where(row => row.AssetId == assetId).ExecuteCommandAsync();
                break;
            case "bytes-drift":
                byte[] changed = (byte[])setup.Bytes.Clone();
                changed[^1] ^= 1;
                await File.WriteAllBytesAsync(setup.AssetPath, changed);
                break;
            case "symlink":
                string outside = Path.Combine(setup.Root, "outside.png");
                File.Move(setup.AssetPath, outside);
                File.CreateSymbolicLink(setup.AssetPath, outside);
                break;
            case "permission":
                await setup.Db.Updateable<AdminPrincipal>().SetColumns(row => row.Permissions == "")
                    .Where(row => row.Id == setup.Session.OwnerAdminPrincipalId).ExecuteCommandAsync();
                break;
            case "source":
                long contentBlockId = await setup.Db.Queryable<ArticleRevision>()
                    .Where(row => row.Id == setup.Request.Article.RevisionId).Select(row => row.ContentBlockId).FirstAsync();
                await setup.Db.Updateable<ArticleRevisionContentBlock>().SetColumns(row => row.MarkdownContent == "changed\n")
                    .Where(row => row.Id == contentBlockId)
                    .ExecuteCommandAsync();
                break;
            case "revision":
                await setup.Db.Updateable<Article>().SetColumns(row => row.CurrentRevisionId == setup.Request.Article.RevisionId + 1)
                    .Where(row => row.Id == setup.Request.Article.ArticleId).ExecuteCommandAsync();
                break;
        }
        if (mutation == "wrong-owner")
        {
            var error = await Assert.ThrowsAsync<ArticlePackageCurrentAssetRejectedException>(() => setup.ReadAsync());
            Assert.Equal("article_package_current_asset_input_invalid", error.ReasonCode);
        }
        else
        {
            var error = await Assert.ThrowsAsync<CurrentArticleUploadAssetObservationRejectedException>(() => setup.ReadAsync());
            Assert.Equal(mutation is "permission" or "source" or "revision"
                ? "source_unavailable_or_changed" : "upload_or_revision_reference_unavailable", error.ReasonCode);
        }
    }

    [Fact]
    public async Task RealPermissionRevocationAfterNativeReadFailsTheOriginalSourceReread()
    {
        await using var setup = await CreateAsync(68);
        bool nativeReadStarted = false;
        bool permissionRevoked = false;
        setup.Db.Aop.OnLogExecuting = (sql, _) =>
        {
            if (sql.Contains("pg_advisory_xact_lock", StringComparison.Ordinal))
            {
                nativeReadStarted = true;
            }
        };
        void RevokeAfterUploadRead()
        {
            if (nativeReadStarted && !permissionRevoked)
            {
                permissionRevoked = true;
                setup.Db.Ado.ExecuteCommand("UPDATE admin_principal SET permissions = '';");
            }
        }
        var error = await Assert.ThrowsAsync<CurrentArticleUploadAssetObservationRejectedException>(() =>
            setup.Reader.ReadCurrentRevisionInputAsync([setup.Request], setup.Principal, setup.Inventory,
                requireCurrent: RevokeAfterUploadRead));
        Assert.True(nativeReadStarted);
        Assert.True(permissionRevoked);
        Assert.Equal("source_unavailable_or_changed", error.ReasonCode);
    }

    [Fact]
    public async Task RealTwoArticleRevisionLedgerProducesOneSharedAssetWithTwoEdges()
    {
        await using var setup = await CreateAsync(68);
        int articleId = await setup.Db.Insertable(new Article { Title = "Second" }).ExecuteReturnIdentityAsync();
        long blockId = await ArticleRevisionContentBlockStore.GetOrCreateAsync(setup.Db, "second\n", DateTime.UtcNow, default);
        long revisionId = await setup.Db.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = 1,
            Title = "Second",
            ContentBlockId = blockId,
            CreatedByAdminPrincipalId = setup.Session.OwnerAdminPrincipalId
        }).ExecuteReturnBigIdentityAsync();
        await setup.Db.Updateable<Article>().SetColumns(row => row.CurrentRevisionId == revisionId).Where(row => row.Id == articleId).ExecuteCommandAsync();
        await new ArticleAssetReferenceStore(setup.Db).ReplaceRevisionAsync(revisionId, articleId, [new(setup.Request.AssetId, 1, null)]);
        var sourceRead = await setup.Sources.ReadCurrentAuthorizedAsync(new(setup.Session.OwnerAdminPrincipalId, "primary-site"), articleId, Guid.CreateVersion7());
        Assert.Equal(RevisionComparePackageReadStatus.Available, sourceRead.Status);
        var source = sourceRead.Source!;
        var secondArticle = new ArticlePackageCurrentAssetArticle(ArticlePackageCurrentAssetReaderTests.Identity(ArticlePackageIdentityKind.Article, 3),
            articleId, RevisionCompareSourceKind.CurrentRevision, revisionId,
            ArticleVaultManifestCodec.CaptureSourceBytes(source.Package.RawMarkdown.AsSpan()), source.Package.PackageDigest);
        var second = setup.Request with
        {
            Article = secondArticle
        };
        var inventory = setup.Inventory.Append(new ArticlePackageInventoryEntry("articles/" + secondArticle.PortableArticle.FileNameToken + ".md",
            ArticlePackageEntryKind.RegularFile, secondArticle.Source.ByteLength, secondArticle.Source.ByteLength)).ToArray();
        var input = await setup.Reader.ReadCurrentRevisionInputAsync([second, setup.Request], setup.Principal, inventory);
        Assert.Single(input.Sources);
        Assert.Single(input.Collection.Assets);
        Assert.Equal(2, input.Collection.References.Count);
        Assert.Equal(2, input.Observations.Count);
        Assert.Contains(input.Observations, item => item.Observation.Reference.ArticleId == articleId
            && item.Observation.Reference.SourceRevision == revisionId);
        Assert.Contains(input.Observations, item => item.Observation.Reference == new CurrentArticleUploadAssetReference(
            setup.Request.Article.ArticleId, setup.Request.Article.RevisionId, setup.Request.Article.Source.Sha256, setup.Request.AssetId));
        Assert.Equal(2, await setup.Db.Queryable<ContentAssetReference>().CountAsync());
        Assert.False(input.Collection.RequireAssetAuthority().IsValid);
    }

    private async Task<Setup> CreateAsync(int byteLength)
    {
        Assert.True(OperatingSystem.IsLinux() && RuntimeInformation.ProcessArchitecture is Architecture.X64 or Architecture.Arm64,
            "Native qualification requires Linux x64/arm64; unsupported platforms must remain UNRUN.");
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        string root = Path.Combine(Path.GetTempPath(), "fsus-package-current-asset-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        ServiceProvider services = new ServiceCollection().AddSingleton<ISqlSugarClient>(db).BuildServiceProvider();
        try
        {
            PostgresSqlSugarTestClient.InitTables(db, typeof(AdminPrincipal), typeof(Article), typeof(ArticleRevision),
                typeof(ArticleRevisionContentBlock), typeof(ArticleRightsSnapshot), typeof(ArticleResponsibilitySnapshot),
                typeof(ArticlePublicationRecord), typeof(ContentAsset), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem));
            long adminId = await db.Insertable(new AdminPrincipal { Handle = "task-owner", Permissions = AdminPermissions.ArticleWrite }).ExecuteReturnBigIdentityAsync();
            int articleId = await db.Insertable(new Article { Title = "Source" }).ExecuteReturnIdentityAsync();
            long blockId = await ArticleRevisionContentBlockStore.GetOrCreateAsync(db, "\ufeffsource  \r\n末尾\n", DateTime.UtcNow, default);
            long revisionId = await db.Insertable(new ArticleRevision
            {
                ArticleId = articleId,
                RevisionNo = 1,
                Title = "Source",
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
