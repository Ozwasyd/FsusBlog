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

    [Fact]
    public async Task ProductionCoordinateAuthority_ResolvesStableAnchorCoordinatesWithoutLeaks()
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
                markdown_content text NOT NULL DEFAULT '',
                content_block_id bigint NULL,
                created_by_admin_principal_id bigint NOT NULL);
            CREATE TABLE article_revision_content_block(
                id bigint PRIMARY KEY,
                content_hash varchar(64) NOT NULL,
                markdown_content text NOT NULL,
                byte_length integer NOT NULL);
            INSERT INTO admin_principal(id, status, isroot, permissions)
            VALUES
                (73, 'active', false, E'article.write\n'),
                (74, 'active', false, E'article.write\n');
            INSERT INTO article(id, title, summary, status, isdeleted, current_revision_id)
            VALUES
                (204, 'Current title', 'Current summary', 2, false, 9002),
                (205, 'Other account title', 'Other account summary', 2, false, 9010);
            INSERT INTO article_revision_content_block(id, content_hash, markdown_content, byte_length)
            VALUES
                (1, 'a', @CurrentMarkdown, 1),
                (2, 'b', @PinnedMarkdown, 1),
                (3, 'c', 'no anchors', 1);
            INSERT INTO article_revision(
                id, article_id, title, summary, content_block_id, created_by_admin_principal_id)
            VALUES
                (9001, 204, 'Pinned title', 'Pinned summary', 2, 73),
                (9002, 204, 'Current revision title', 'Current revision summary', 1, 73),
                (9010, 205, 'Other account revision', 'Other account summary', 3, 74);
            """,
            new SugarParameter("@CurrentMarkdown", string.Join(
                '\n',
                "# Overview ^doc-head",
                "",
                "Intro paragraph ^intro-block",
                "",
                "First claim ^dup-block",
                "Second claim ^dup-block",
                "",
                "```",
                "var x = 1;",
                "```",
                "^code-block")),
            new SugarParameter("@PinnedMarkdown", "# Old head ^doc-head\n\nOld para ^intro-block\n"));
        var authority = new PostgresAuthoringCanvasCoordinateAuthority(db);
        var source = new AuthoringCanvasReferenceFactSource(
            new PostgresAuthoringCanvasArticleReferenceReader(db),
            new AuthoringCanvasCoordinateFactProvider([authority]));
        AuthoringCanvasReferenceAuthorityCoordinate coordinate = await source.ReadAuthorityCoordinateAsync(
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead);

        Guid headingNode = Guid.CreateVersion7();
        Guid blockNode = Guid.CreateVersion7();
        Guid pinnedHeadingNode = Guid.CreateVersion7();
        Guid missingNode = Guid.CreateVersion7();
        Guid duplicateNode = Guid.CreateVersion7();
        Guid invalidNode = Guid.CreateVersion7();
        Guid wrongKindNode = Guid.CreateVersion7();
        AuthoringCanvasReferenceTarget[] targets =
        [
            Target(headingNode, heading: "doc-head"),
            BlockTarget(blockNode, "intro-block"),
            Target(pinnedHeadingNode, pinnedRevision: 9001, heading: "doc-head"),
            BlockTarget(missingNode, "absent-anchor"),
            BlockTarget(duplicateNode, "dup-block"),
            BlockTarget(invalidNode, "NOT-CANONICAL"),
            Target(wrongKindNode, heading: "intro-block")
        ];

        IReadOnlyList<AuthoringCanvasReferenceFact> facts = await source.ReadBatchAsync(
            Query(coordinate, targets));

        Assert.Equal(targets.Length, facts.Count);
        AuthoringCanvasReferenceFact heading = facts.Single(fact => fact.NodeId == headingNode);
        Assert.Equal(AuthoringCanvasReferenceCoordinateState.Current, heading.CoordinateState);
        Assert.Equal(9002, heading.ResolvedRevision);
        Assert.Equal("Overview", heading.ContextSnippet);
        AuthoringCanvasReferenceFact block = facts.Single(fact => fact.NodeId == blockNode);
        Assert.Equal(AuthoringCanvasReferenceCoordinateState.Current, block.CoordinateState);
        Assert.Equal("Intro paragraph", block.ContextSnippet);
        AuthoringCanvasReferenceFact pinned = facts.Single(fact => fact.NodeId == pinnedHeadingNode);
        Assert.Equal(9001, pinned.ResolvedRevision);
        Assert.Equal(AuthoringCanvasReferenceCoordinateState.Current, pinned.CoordinateState);
        Assert.Equal("Old head", pinned.ContextSnippet);
        Assert.Equal(
            AuthoringCanvasReferenceCoordinateState.Missing,
            facts.Single(fact => fact.NodeId == missingNode).CoordinateState);
        Assert.Equal(
            AuthoringCanvasReferenceCoordinateState.Duplicate,
            facts.Single(fact => fact.NodeId == duplicateNode).CoordinateState);
        Assert.Equal(
            AuthoringCanvasReferenceCoordinateState.Invalid,
            facts.Single(fact => fact.NodeId == invalidNode).CoordinateState);
        // The anchor exists on a paragraph, so no heading coordinate carries that identity.
        Assert.Equal(
            AuthoringCanvasReferenceCoordinateState.Missing,
            facts.Single(fact => fact.NodeId == wrongKindNode).CoordinateState);

        string serialized = JsonSerializer.Serialize(facts);
        Assert.DoesNotContain("var x = 1;", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("```", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("First claim", serialized, StringComparison.Ordinal);

        // A principal without access to the article receives no coordinate facts at all.
        var otherAccount = new AuthoringCanvasOwner(74, "primary-site");
        IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact> denied =
            await authority.ReadBatchAsync(new AuthoringCanvasCoordinateFactQuery(
                Guid.CreateVersion7(),
                7,
                new string('c', 64),
                otherAccount,
                [Target(headingNode, heading: "doc-head")]));

        Assert.Empty(denied);
    }

    private static AuthoringCanvasReferenceTarget BlockTarget(Guid nodeId, string block)
        => new(
            nodeId,
            AuthoringCanvasNodeType.BlockReference,
            204,
            null,
            block,
            null,
            null);

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
