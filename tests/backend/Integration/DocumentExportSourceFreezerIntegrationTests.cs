using System.Runtime.InteropServices;
using System.Security.Claims;
using System.Text.Json;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class DocumentExportSourceFreezerIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task RevisionFreeze_UsesLivePermissionAndExactHistoricalCoordinateWithOwnedBytes()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        RevisionComparePackage package = Package();
        IRevisionComparePackageReader reader = Reader(package);
        var freezer = Freezer(db, reader);
        DocumentExportFrozenSource frozen = await freezer.FreezeAsync(1, 11, Coordinate(), null, Guid.NewGuid());

        await reader.Received(1).ReadAuthorizedAsync(
            Arg.Is<RevisionCompareReadContext>(context => context.AdminPrincipalId == 1 && context.SiteScope == "primary"),
            1, Arg.Is<RevisionCompareSourceSelector>(selector =>
                selector.Kind == RevisionCompareSourceKind.HistoricalRevision && selector.RevisionId == 701),
            Arg.Any<CancellationToken>());
        string digest = frozen.Package.PackageDigest;
        ImmutableCollectionsMarshal.AsArray(package.RawMarkdown)![0] ^= 1;
        ImmutableCollectionsMarshal.AsArray(package.Snapshots[0].Payload)![0] ^= 1;
        await db.Ado.ExecuteCommandAsync("UPDATE article SET current_revision_id = 999 WHERE id = 1;");
        Assert.True(RevisionComparePackageSeal.Verify(frozen.Package));
        Assert.Equal(digest, frozen.Package.PackageDigest);
        Assert.Equal("revision:701:3", frozen.Package.SourceIdentity);
        Assert.NotEmpty(frozen.PermissionDigest);
    }

    [Theory]
    [InlineData("UPDATE admin_session SET revokedatutc = CURRENT_TIMESTAMP;")]
    [InlineData("UPDATE admin_session SET idleexpiresatutc = TIMESTAMP '2000-01-01';")]
    [InlineData("UPDATE admin_principal SET permissions = '';")]
    [InlineData("UPDATE admin_principal SET status = 'disabled';")]
    [InlineData("UPDATE article SET isdeleted = TRUE;")]
    [InlineData("UPDATE article SET status = 3;")]
    public async Task RevokedSessionPermissionOrArticle_RefusesBeforeReadingPrivateSource(string mutation)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await db.Ado.ExecuteCommandAsync(mutation);
        IRevisionComparePackageReader reader = Reader(Package());
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Freezer(db, reader).FreezeAsync(1, 11, Coordinate(), null, Guid.NewGuid()));
        await reader.DidNotReceiveWithAnyArgs().ReadAuthorizedAsync(default!, default, default!, default);
    }

    [Fact]
    public async Task PermissionChangeDuringSourceRead_RefusesTheFrozenPackage()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        IRevisionComparePackageReader reader = Reader(Package());
        reader.ReadAuthorizedAsync(Arg.Any<RevisionCompareReadContext>(), 1,
            Arg.Any<RevisionCompareSourceSelector>(), Arg.Any<CancellationToken>()).Returns(async _ =>
        {
            await db.Ado.ExecuteCommandAsync("UPDATE admin_session SET revokedatutc = CURRENT_TIMESTAMP;");
            return RevisionComparePackageReadResult.Available(Package());
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Freezer(db, reader).FreezeAsync(1, 11, Coordinate(), null, Guid.NewGuid()));
    }

    [Theory]
    [InlineData(2, 11)]
    [InlineData(1, 12)]
    public async Task ForeignPrincipalOrSite_RefusesBeforeReadingSource(long userId, long siteId)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        IRevisionComparePackageReader reader = Reader(Package());
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Freezer(db, reader).FreezeAsync(userId, siteId, Coordinate(), null, Guid.NewGuid()));
        await reader.DidNotReceiveWithAnyArgs().ReadAuthorizedAsync(default!, default, default!, default);
    }

    [Theory]
    [InlineData(801, true)]
    [InlineData(802, false)]
    public async Task PublicationFreeze_RequiresExactImmutableReleaseReference(long publicationId, bool accepted)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var coordinate = Coordinate() with
        {
            Kind = DocumentExportCoordinateKind.Publication,
            PublicationId = publicationId
        };
        var freezer = Freezer(db, Reader(Package(publication: true)));
        if (accepted)
        {
            DocumentExportFrozenSource frozen = await freezer.FreezeAsync(1, 11, coordinate, null, Guid.NewGuid());
            Assert.Equal(801, frozen.Coordinate.PublicationId);
        }
        else
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                freezer.FreezeAsync(1, 11, coordinate, null, Guid.NewGuid()));
        }
    }

    [Theory]
    [InlineData(3, "draft-epoch", "draft-key", true)]
    [InlineData(4, "draft-epoch", "draft-key", false)]
    [InlineData(3, "other-epoch", "draft-key", false)]
    [InlineData(3, "draft-epoch", "other-key", false)]
    public async Task DraftFreeze_RejectsVersionEpochAndKeyDrift(
        long version, string epoch, string key, bool accepted)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var coordinate = new DocumentExportArticleCoordinate(DocumentExportCoordinateKind.Draft, 1, key, null, null, version);
        var freezer = Freezer(db, Reader(Package(draft: true)));
        if (accepted)
        {
            DocumentExportFrozenSource frozen = await freezer.FreezeAsync(1, 11, coordinate, epoch, Guid.NewGuid());
            Assert.True(RevisionComparePackageSeal.Verify(frozen.Package));
        }
        else
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                freezer.FreezeAsync(1, 11, coordinate, epoch, Guid.NewGuid()));
        }
    }

    [Fact]
    public async Task MissingSnapshotsAndTamperedBytes_AreRejectedWithoutMetadataFallback()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        foreach (RevisionComparePackage package in new[] { Package(missing: true), Package() })
        {
            if (!package.Snapshots.Any(snapshot => snapshot.State == RevisionCompareSnapshotState.Missing))
            {
                ImmutableCollectionsMarshal.AsArray(package.RawMarkdown)![0] ^= 1;
            }
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                Freezer(db, Reader(package)).FreezeAsync(1, 11, Coordinate(), null, Guid.NewGuid()));
        }
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(id bigint PRIMARY KEY, status varchar(32) NOT NULL,
                isroot boolean NOT NULL, permissions text NOT NULL);
            INSERT INTO admin_principal VALUES(1, 'active', FALSE, 'article.write');
            CREATE TABLE admin_session(sessionid varchar(64) PRIMARY KEY,
                adminprincipalid bigint NOT NULL REFERENCES admin_principal(id),
                revokedatutc timestamp without time zone NULL,
                idleexpiresatutc timestamp without time zone NOT NULL,
                absoluteexpiresatutc timestamp without time zone NOT NULL);
            INSERT INTO admin_session VALUES('export-session', 1, NULL,
                TIMESTAMP '2099-01-01', TIMESTAMP '2099-01-02');
            CREATE TABLE article(id integer PRIMARY KEY, status integer NOT NULL,
                isdeleted boolean NOT NULL, current_revision_id bigint NULL);
            INSERT INTO article VALUES(1, 0, FALSE, 701);
            """);
        return db;
    }

    private static DocumentExportSourceFreezer Freezer(ISqlSugarClient db, IRevisionComparePackageReader reader)
    {
        var accessor = new HttpContextAccessor
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                [
                    new Claim("identity_kind", "admin_principal"),
                    new Claim("admin_id", "1"),
                    new Claim("admin_sid", "export-session"),
                    new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
                ], "test"))
            }
        };
        IConfiguration config = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["SITE_BASEURL"] = "export-test-site" }).Build();
        return new DocumentExportSourceFreezer(reader,
            new SqlAuthorRecentArticleHistoryPermissionAuthority(db, accessor, config, TimeProvider.System),
            new DocumentExportSiteBinding(11, "export-test-site"));
    }

    private static DocumentExportArticleCoordinate Coordinate()
        => new(DocumentExportCoordinateKind.Revision, 1, null, 701, null, 3);

    private static IRevisionComparePackageReader Reader(RevisionComparePackage package)
    {
        var reader = Substitute.For<IRevisionComparePackageReader>();
        reader.ReadAuthorizedAsync(Arg.Any<RevisionCompareReadContext>(), 1,
            Arg.Any<RevisionCompareSourceSelector>(), Arg.Any<CancellationToken>())
            .Returns(RevisionComparePackageReadResult.Available(package));
        return reader;
    }

    private static RevisionComparePackage Package(bool publication = false, bool draft = false, bool missing = false)
        => RevisionComparePackageSeal.Create(1,
            draft ? RevisionCompareSourceKind.CurrentDraft : RevisionCompareSourceKind.HistoricalRevision,
            draft ? "draft:1:draft-key:3:context-digest" : "revision:701:3",
            draft ? null : 701, draft ? null : 3, draft ? 3 : null, draft ? "draft-epoch" : null,
            "# frozen private source"u8,
            [RevisionCompareMetadataRegistry.String("title", "Frozen")],
            [
                RevisionCompareSnapshot.Present(RevisionCompareSnapshotKind.Rights, "rights:701", 1, "{}"u8),
                missing ? RevisionCompareSnapshot.Missing(RevisionCompareSnapshotKind.Responsibility)
                    : draft ? RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility)
                    : RevisionCompareSnapshot.Present(RevisionCompareSnapshotKind.Responsibility, "responsibility:701:1", 1, "{}"u8),
                publication ? RevisionCompareSnapshot.Present(RevisionCompareSnapshotKind.Release, "release:801:2", 1,
                    JsonSerializer.SerializeToUtf8Bytes(new ArticleRevisionReleaseResponse("801", 2, "publish", DateTime.UnixEpoch)))
                    : RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
            ]);
}
