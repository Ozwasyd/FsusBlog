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
                body text NULL);
            INSERT INTO admin_principal(id, status, isroot, permissions)
            VALUES (73, 'active', false, E'article.write\n');
            INSERT INTO article(id, title, summary, status, isdeleted, current_revision_id)
            VALUES (204, 'Current title', 'Current summary', 2, false, 9002);
            INSERT INTO article_revision(id, article_id, title, summary, body)
            VALUES
                (9001, 204, 'Pinned title', 'Pinned summary', @BodyCanary),
                (9002, 204, 'Current revision title', 'Current revision summary', @BodyCanary);
            """,
            new SugarParameter("@BodyCanary", BodyCanary));
        var reader = new PostgresAuthoringCanvasArticleReferenceReader(db);
        var source = new AuthoringCanvasReferenceFactSource(reader, []);
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
        => new(
            Guid.Parse("018f5f93-2997-7c8a-9a47-0242ac120201"),
            7,
            new string('c', 64),
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead,
            coordinate,
            targets);
}
