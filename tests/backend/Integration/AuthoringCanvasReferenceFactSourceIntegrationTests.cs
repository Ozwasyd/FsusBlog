using System.Text.Json;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthoringCanvasReferenceFactSourceIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string BodyCanary = "ARTICLE-BODY-MUST-NOT-ENTER-CANVAS-REFERENCE";
    private static readonly AuthoringCanvasOwner s_owner = new(73, "primary-site");

    [Fact]
    public async Task ProductionArticleReader_BindsServerPermissionGenerationAndReturnsMetadataOnly()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(
                id bigint PRIMARY KEY,
                status varchar(32) NOT NULL,
                isroot boolean NOT NULL,
                permissions text NOT NULL);
            CREATE TABLE article(
                id integer PRIMARY KEY,
                title varchar(256) NOT NULL,
                summary varchar(512) NULL,
                status integer NOT NULL,
                isdeleted boolean NOT NULL,
                current_revision_id bigint NULL);
            CREATE TABLE article_revision(
                id bigint PRIMARY KEY,
                article_id integer NOT NULL,
                title varchar(256) NOT NULL,
                summary varchar(512) NULL,
                body text NULL,
                created_by_admin_principal_id bigint NOT NULL);
            INSERT INTO admin_principal(id, status, isroot, permissions)
            VALUES
                (73, 'active', false, E'article.write\n'),
                (74, 'active', false, E'article.write\n'),
                (75, 'active', true, '');
            INSERT INTO article(id, title, summary, status, isdeleted, current_revision_id)
            VALUES
                (204, 'Current title', 'Current summary', 2, false, 9002),
                (205, 'Other account title', 'Other account summary', 2, false, 9010);
            INSERT INTO article_revision(
                id, article_id, title, summary, body, created_by_admin_principal_id)
            VALUES
                (9001, 204, 'Pinned title', 'Pinned summary', @BodyCanary, 73),
                (9002, 204, 'Current revision title', 'Current revision summary', @BodyCanary, 73),
                (9010, 205, 'Other account revision', 'Other account summary', @BodyCanary, 74);
            """,
            new SugarParameter("@BodyCanary", BodyCanary));
        var reader = new PostgresAuthoringCanvasArticleReferenceReader(db);
        var source = new AuthoringCanvasReferenceFactSource(
            reader,
            new AuthoringCanvasCoordinateFactProvider([]));
        Guid currentNodeId = Guid.CreateVersion7();
        Guid pinnedNodeId = Guid.CreateVersion7();
        Guid headingNodeId = Guid.CreateVersion7();
        AuthoringCanvasReferenceTarget[] targets =
        [
            Target(currentNodeId),
            Target(pinnedNodeId, pinnedRevision: 9001),
            Target(headingNodeId, heading: "heading-a")
        ];

        AuthoringCanvasReferenceAuthorityCoordinate coordinate = await source.ReadAuthorityCoordinateAsync(
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead);
        IReadOnlyList<AuthoringCanvasReferenceFact> facts = await source.ReadBatchAsync(
            Query(coordinate, targets));

        Assert.All(facts, static fact => Assert.Equal(204, fact.TargetArticleId));
        Assert.Equal(9002, facts.Single(fact => fact.NodeId == currentNodeId).ResolvedRevision);
        Assert.Equal(9001, facts.Single(fact => fact.NodeId == pinnedNodeId).ResolvedRevision);
        Assert.Equal(
            AuthoringCanvasReferenceCoordinateState.SourceStale,
            facts.Single(fact => fact.NodeId == headingNodeId).CoordinateState);
        string serialized = JsonSerializer.Serialize(facts);
        Assert.DoesNotContain(BodyCanary, serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("body", serialized, StringComparison.OrdinalIgnoreCase);

        var otherAccount = new AuthoringCanvasOwner(74, "primary-site");
        AuthoringCanvasReferenceAuthorityCoordinate otherAccountCoordinate =
            await source.ReadAuthorityCoordinateAsync(
                otherAccount,
                AuthoringCanvasReferencePermission.ArticleRead);
        IReadOnlyList<AuthoringCanvasReferenceFact> otherAccountFacts = await source.ReadBatchAsync(
            Query(otherAccount, otherAccountCoordinate, [Target(Guid.CreateVersion7())]));
        AuthoringCanvasReferenceFact hiddenFromOtherAccount = Assert.Single(otherAccountFacts);
        Assert.Equal(
            AuthoringCanvasArticleState.PermissionDeniedOrUnknown,
            hiddenFromOtherAccount.ArticleState);
        Assert.Null(hiddenFromOtherAccount.Title);
        Assert.Null(hiddenFromOtherAccount.ContextSnippet);
        Assert.Null(hiddenFromOtherAccount.StableRoute);

        AuthoringCanvasReferenceTarget missingTarget = Target(Guid.CreateVersion7()) with
        {
            TargetArticleId = 999
        };
        AuthoringCanvasReferenceFact missing = Assert.Single(await source.ReadBatchAsync(
            Query(coordinate, [missingTarget])));
        Assert.Equal(AuthoringCanvasArticleState.Missing, missing.ArticleState);
        Assert.Null(missing.Title);
        Assert.Null(missing.ContextSnippet);
        Assert.Null(missing.StableRoute);

        var rootOwner = new AuthoringCanvasOwner(75, "primary-site");
        AuthoringCanvasReferenceAuthorityCoordinate rootCoordinate =
            await source.ReadAuthorityCoordinateAsync(
                rootOwner,
                AuthoringCanvasReferencePermission.ArticleRead);
        AuthoringCanvasReferenceFact rootFact = Assert.Single(await source.ReadBatchAsync(
            Query(rootOwner, rootCoordinate, [Target(Guid.CreateVersion7())])));
        Assert.Equal(AuthoringCanvasArticleState.Current, rootFact.ArticleState);
        Assert.Equal("Current title", rootFact.Title);

        var otherSite = new AuthoringCanvasOwner(73, "other-site");
        AuthoringCanvasReferenceAuthorityCoordinate otherSiteCoordinate =
            await source.ReadAuthorityCoordinateAsync(
                otherSite,
                AuthoringCanvasReferencePermission.ArticleRead);
        IReadOnlyList<AuthoringCanvasReferenceFact> otherSiteFacts = await source.ReadBatchAsync(
            Query(otherSite, otherSiteCoordinate, [Target(Guid.CreateVersion7())]));
        AuthoringCanvasReferenceFact hiddenFromOtherSite = Assert.Single(otherSiteFacts);
        Assert.Equal(
            AuthoringCanvasArticleState.PermissionDeniedOrUnknown,
            hiddenFromOtherSite.ArticleState);
        Assert.Null(hiddenFromOtherSite.Title);
        Assert.Null(hiddenFromOtherSite.ContextSnippet);
        Assert.Null(hiddenFromOtherSite.StableRoute);

        await db.Ado.ExecuteCommandAsync(
            "UPDATE admin_principal SET permissions = '' WHERE id = 73;");
        AuthoringCanvasReferenceAuthorityCoordinate deniedCoordinate = await source.ReadAuthorityCoordinateAsync(
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead);
        Assert.NotEqual(coordinate, deniedCoordinate);
        IReadOnlyList<AuthoringCanvasReferenceFact> denied = await source.ReadBatchAsync(
            Query(deniedCoordinate, targets));
        Assert.All(denied, static fact =>
        {
            Assert.Equal(AuthoringCanvasArticleState.PermissionDeniedOrUnknown, fact.ArticleState);
            Assert.Null(fact.Title);
            Assert.Null(fact.ContextSnippet);
            Assert.Null(fact.StableRoute);
            Assert.Equal(0, fact.CurrentRevision);
            Assert.Equal(0, fact.ResolvedRevision);
        });
        Assert.DoesNotContain(BodyCanary, JsonSerializer.Serialize(denied), StringComparison.Ordinal);
    }

    private static AuthoringCanvasReferenceTarget Target(
        Guid nodeId,
        long? pinnedRevision = null,
        string? heading = null)
        => new(
            nodeId,
            heading is null ? AuthoringCanvasNodeType.ArticleReference : AuthoringCanvasNodeType.HeadingReference,
            204,
            heading,
            null,
            pinnedRevision,
            null);

    private static AuthoringCanvasReferenceFactQuery Query(
        AuthoringCanvasReferenceAuthorityCoordinate coordinate,
        IReadOnlyList<AuthoringCanvasReferenceTarget> targets)
        => Query(s_owner, coordinate, targets);

    private static AuthoringCanvasReferenceFactQuery Query(
        AuthoringCanvasOwner owner,
        AuthoringCanvasReferenceAuthorityCoordinate coordinate,
        IReadOnlyList<AuthoringCanvasReferenceTarget> targets)
        => new(
            Guid.Parse("018f5f93-2997-7c8a-9a47-0242ac120201"),
            7,
            new string('c', 64),
            owner,
            AuthoringCanvasReferencePermission.ArticleRead,
            coordinate,
            targets);
}
