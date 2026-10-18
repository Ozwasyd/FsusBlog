using System.Collections;
using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

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

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ProductionResolver_RejectsCommittedTargetDriftAndKeepsExactPinnedRevision(bool warmCache)
    {
        using SqlSugarClient db = await CreateResolverDatabaseAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        AuthoringCanvasNode[] nodes = [ReferenceNode(), ReferenceNode(pinned: 9001, order: 1)];
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db, s_owner, nodes);
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolver resolver = Resolver(db, cache);
        if (warmCache)
        {
            Assert.Equal(2, (await resolver.ResolveAsync(request)).Projections.Count);
        }
        int previousEntries = cache.EntryCount;

        AuthoringCanvasValidationException failure = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(() =>
            AtSqlBoundaryAsync(db, warmCache ? IsAuthorityRead : IsArticleMetadataRead, 1,
                () => resolver.ResolveAsync(request), async () =>
                {
                    await writer.Ado.ExecuteCommandAsync(
                        """
                        INSERT INTO article_revision_content_block(id, content_hash, markdown_content, byte_length)
                        VALUES (4, 'new-revision', E'# New head ^doc-head\n\nNew block ^intro-block', 55);
                        INSERT INTO article_revision(id, article_id, title, summary, content_block_id, created_by_admin_principal_id)
                        VALUES (9003, 204, 'New revision title', 'New revision summary', 4, 73);
                        UPDATE article SET current_revision_id = 9003, title = 'New article title' WHERE id = 204;
                        """);
                    Assert.Equal(9003, await writer.Ado.GetLongAsync(
                        "SELECT current_revision_id FROM article WHERE id = 204;"));
                }));

        Assert.Equal("canvas_reference_authority_changed", failure.Code);
        Assert.Equal(previousEntries, cache.EntryCount);
        AuthoringCanvasReferenceResolutionBatch fresh = await resolver.ResolveAsync(request);
        Assert.Equal(9003, fresh.Projections[0].TargetRevision);
        Assert.Equal("New block", fresh.Projections[0].ContextSnippet);
        Assert.Equal(AuthoringCanvasReferenceProjectionStatus.Current, fresh.Projections[0].Status);
        Assert.Equal(9001, fresh.Projections[1].TargetRevision);
        Assert.Equal("Old block", fresh.Projections[1].ContextSnippet);
        Assert.Equal(9001, fresh.Projections[1].OpenIntent!.Revision);
        Assert.Equal(AuthoringCanvasReferenceProjectionStatus.PinnedStale, fresh.Projections[1].Status);
        Assert.True((await resolver.VerifyAsync(request, fresh)).Valid);
        Assert.True((await new AuthoringCanvasDocumentStore(db, TimeProvider.System)
            .VerifyAsync(s_owner, request.CanvasId)).Valid);
    }

    [Theory]
    [InlineData(false, "permission")]
    [InlineData(true, "permission")]
    [InlineData(false, "principal-status")]
    [InlineData(true, "principal-status")]
    [InlineData(false, "article-owner")]
    [InlineData(true, "article-owner")]
    public async Task ProductionResolver_RejectsCommittedPermissionDriftWithoutLeakingWarmFacts(
        bool warmCache, string change)
    {
        using SqlSugarClient db = await CreateResolverDatabaseAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db, s_owner, [ReferenceNode()]);
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolver resolver = Resolver(db, cache);
        if (warmCache)
        {
            Assert.Equal("Current block", Assert.Single((await resolver.ResolveAsync(request)).Projections).ContextSnippet);
        }
        int previousEntries = cache.EntryCount;
        string mutation = change switch
        {
            "permission" => "UPDATE admin_principal SET permissions = '' WHERE id = 73;",
            "principal-status" => "UPDATE admin_principal SET status = 'disabled' WHERE id = 73;",
            "article-owner" => "UPDATE article_revision SET created_by_admin_principal_id = 74 WHERE article_id = 204;",
            _ => throw new ArgumentOutOfRangeException(nameof(change))
        };

        AuthoringCanvasValidationException failure = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(() =>
            AtSqlBoundaryAsync(db, IsAuthorityRead, warmCache ? 1 : 3,
                () => resolver.ResolveAsync(request), async () =>
                {
                    Assert.True(await writer.Ado.ExecuteCommandAsync(mutation) > 0);
                }));

        Assert.Equal("canvas_reference_authority_changed", failure.Code);
        Assert.Equal(previousEntries, cache.EntryCount);
        AuthoringCanvasReferenceResolutionBatch denied = await resolver.ResolveAsync(request);
        AssertDenied(Assert.Single(denied.Projections));
        Assert.DoesNotContain("Current block", JsonSerializer.Serialize(denied), StringComparison.Ordinal);
        Assert.DoesNotContain("Owner 73 title", JsonSerializer.Serialize(denied), StringComparison.Ordinal);
        Assert.True((await resolver.VerifyAsync(request, denied)).Valid);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task ProductionResolver_RechecksCanvasAfterTheFinalRealAuthorityRead(
        bool warmCache, bool tamperDigest)
    {
        using SqlSugarClient db = await CreateResolverDatabaseAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db, s_owner, [ReferenceNode()]);
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolver resolver = Resolver(db, cache);
        if (warmCache)
        {
            await resolver.ResolveAsync(request);
        }
        int previousEntries = cache.EntryCount;
        Task<AuthoringCanvasReferenceResolutionBatch> RunAsync() => AtSqlBoundaryAsync(
            db, IsAuthorityRead, warmCache ? 2 : 4, () => resolver.ResolveAsync(request), async () =>
            {
                if (tamperDigest)
                {
                    // Test-owned persisted tamper is distinct from the legal CAS positive below.
                    Assert.Equal(1, await writer.Ado.ExecuteCommandAsync(
                        "UPDATE authoring_canvas_document SET content_digest = @Digest WHERE id = @CanvasId;",
                        new SugarParameter("@Digest", new string('f', 64)),
                        new SugarParameter("@CanvasId", request.CanvasId)));
                }
                else
                {
                    AuthoringCanvasWriteReceipt changed = await new AuthoringCanvasDocumentStore(writer, TimeProvider.System)
                        .UpdateMetadataAsync(new UpdateAuthoringCanvasMetadataCommand(
                            request.CanvasId, s_owner, request.CanvasRevision, Guid.CreateVersion7(),
                            "Committed canvas change", new AuthoringCanvasViewport(0, 0, 1)));
                    Assert.Equal(request.CanvasRevision + 1, changed.Revision);
                }
            });

        if (tamperDigest)
        {
            AuthoringCanvasValidationException failure = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(RunAsync);
            Assert.Equal("canvas_reference_content_digest_stale", failure.Code);
        }
        else
        {
            await Assert.ThrowsAsync<AuthoringCanvasRevisionConflictException>(RunAsync);
        }
        Assert.Equal(previousEntries, cache.EntryCount);
    }

    [Fact]
    public async Task ProductionResolver_LateRequestCannotPublishOverTheNewTargetRequest()
    {
        using SqlSugarClient db = await CreateResolverDatabaseAsync();
        using SqlSugarClient newerDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        AuthoringCanvasNode node = ReferenceNode();
        AuthoringCanvasReferenceResolutionRequest oldRequest = await CreateRequestAsync(db, s_owner, [node]);
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolver newerResolver = Resolver(newerDb, cache);
        AuthoringCanvasReferenceResolutionBatch? newer = null;
        AuthoringCanvasReferenceResolutionRequest? newRequest = null;

        await Assert.ThrowsAsync<AuthoringCanvasRevisionConflictException>(() => AtSqlBoundaryAsync(
            db, IsArticleMetadataRead, 1, () => Resolver(db, cache).ResolveAsync(oldRequest), async () =>
            {
                var store = new AuthoringCanvasDocumentStore(newerDb, TimeProvider.System);
                await store.PutNodeAsync(new PutAuthoringCanvasNodeCommand(
                    oldRequest.CanvasId, s_owner, oldRequest.CanvasRevision, Guid.CreateVersion7(),
                    node with
                    {
                        TargetArticleId = 206
                    }));
                newRequest = await ReadRequestAsync(store, s_owner, oldRequest.CanvasId);
                newer = await newerResolver.ResolveAsync(newRequest);
                AuthoringCanvasReferenceProjection projection = Assert.Single(newer.Projections);
                Assert.Equal(206, projection.TargetArticleId);
                Assert.Equal("Replacement block", projection.ContextSnippet);
                Assert.Equal(1, cache.EntryCount);
            }));

        Assert.NotNull(newRequest);
        Assert.NotNull(newer);
        Assert.Equal(1, cache.EntryCount);
        AuthoringCanvasReferenceResolutionBatch cached = await newerResolver.ResolveAsync(newRequest);
        Assert.Equal(1, cached.Receipt.CacheHitCount);
        Assert.Equal(newer.ContentDigest, cached.ContentDigest);
        Assert.Equal(206, Assert.Single(cached.Projections).TargetArticleId);
        Assert.True((await newerResolver.VerifyAsync(newRequest, cached)).Valid);
    }

    [Fact]
    public async Task ProductionResolver_SharedCachePreservesOwnerAndSitePrivacy()
    {
        using SqlSugarClient db = await CreateResolverDatabaseAsync();
        AuthoringCanvasNode node = ReferenceNode();
        var otherOwner = new AuthoringCanvasOwner(74, "primary-site");
        var otherSite = new AuthoringCanvasOwner(73, "other-site");
        AuthoringCanvasReferenceResolutionRequest allowed = await CreateRequestAsync(db, s_owner, [node]);
        AuthoringCanvasReferenceResolutionRequest foreignOwner = await CreateRequestAsync(db, otherOwner, [node]);
        AuthoringCanvasReferenceResolutionRequest foreignSite = await CreateRequestAsync(db, otherSite, [node]);
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolver resolver = Resolver(db, cache);

        AuthoringCanvasReferenceResolutionBatch warm = await resolver.ResolveAsync(allowed);
        Assert.Equal("Current block", Assert.Single(warm.Projections).ContextSnippet);
        foreach (AuthoringCanvasReferenceResolutionRequest deniedRequest in new[] { foreignOwner, foreignSite })
        {
            AuthoringCanvasReferenceResolutionBatch denied = await resolver.ResolveAsync(deniedRequest);
            Assert.Equal(0, denied.Receipt.CacheHitCount);
            AssertDenied(Assert.Single(denied.Projections));
            Assert.True((await resolver.VerifyAsync(deniedRequest, denied)).Valid);
        }
        await Assert.ThrowsAsync<AuthoringCanvasAccessDeniedException>(() =>
            resolver.ResolveAsync(allowed with
            {
                Owner = otherOwner
            }));
        await Assert.ThrowsAsync<AuthoringCanvasAccessDeniedException>(() =>
            resolver.ResolveAsync(allowed with
            {
                Owner = otherSite
            }));
        AuthoringCanvasReferenceResolutionBatch again = await resolver.ResolveAsync(allowed);
        Assert.Equal(1, again.Receipt.CacheHitCount);
        Assert.Equal(warm.ContentDigest, again.ContentDigest);
        Assert.Equal("Current block", Assert.Single(again.Projections).ContextSnippet);
        Assert.Equal(3, cache.EntryCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ProductionResolver_CancelsRealAuthorityReadWithoutPublishingFacts(bool warmCache)
    {
        using SqlSugarClient db = await CreateResolverDatabaseAsync();
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db, s_owner, [ReferenceNode()]);
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolver resolver = Resolver(db, cache);
        if (warmCache)
        {
            await resolver.ResolveAsync(request);
        }
        int previousEntries = cache.EntryCount;
        using var cancellation = new CancellationTokenSource();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => AtSqlBoundaryAsync(
            db, IsAuthorityRead, warmCache ? 1 : 3,
            () => resolver.ResolveAsync(request, cancellation.Token), () =>
            {
                cancellation.Cancel();
                return Task.CompletedTask;
            }));
        Assert.Equal(previousEntries, cache.EntryCount);
        Assert.True((await new AuthoringCanvasDocumentStore(db, TimeProvider.System)
            .VerifyAsync(s_owner, request.CanvasId)).Valid);
        AuthoringCanvasReferenceResolutionBatch positive = await resolver.ResolveAsync(request);
        Assert.Equal("Current block", Assert.Single(positive.Projections).ContextSnippet);
    }

    [Fact]
    public async Task ProductionCoordinateAuthority_CancelsTheRealBlockedNativeCommand()
    {
        using SqlSugarClient db = await CreateResolverDatabaseAsync();
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        db.CurrentConnectionConfig.IsAutoCloseConnection = false;
        await db.Ado.OpenAsync();
        int readerPid = await db.Ado.GetIntAsync("SELECT pg_backend_pid();");
        await using var blocker = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await blocker.OpenAsync();
        await using NpgsqlTransaction blockerTransaction = await blocker.BeginTransactionAsync();
        await using (NpgsqlCommand command = blocker.CreateCommand())
        {
            command.Transaction = blockerTransaction;
            command.CommandText = "LOCK TABLE article_revision_content_block IN ACCESS EXCLUSIVE MODE;";
            await command.ExecuteNonQueryAsync();
        }
        using var cancellation = new CancellationTokenSource();
        Task<IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact>> reading = Task.Run(() =>
            new PostgresAuthoringCanvasCoordinateAuthority(db).ReadBatchAsync(
                new AuthoringCanvasCoordinateFactQuery(Guid.CreateVersion7(), 1, new string('c', 64),
                    s_owner, [BlockTarget(Guid.CreateVersion7(), "intro-block")]), cancellation.Token));
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            while (await observer.Ado.GetIntAsync(
                """
                SELECT COUNT(*) FROM pg_stat_activity
                WHERE pid = @Pid AND state = 'active' AND wait_event_type = 'Lock'
                  AND query LIKE '%COALESCE(block.markdown_content, revision.markdown_content)%';
                """, new SugarParameter("@Pid", readerPid)) == 0)
            {
                await Task.Delay(10, deadline.Token);
            }
            Assert.False(reading.IsCompleted);
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reading.WaitAsync(TimeSpan.FromSeconds(30)));
            // The table lock is still held: completing cancellation cannot be an accidental unlock/read success.
            Assert.NotNull(blockerTransaction.Connection);
            Assert.Equal(ConnectionState.Open, ((DbConnection)db.Ado.Connection).State);
            Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1;"));
        }
        finally
        {
            cancellation.Cancel();
            await blockerTransaction.RollbackAsync();
            try
            {
                await reading.WaitAsync(TimeSpan.FromSeconds(30));
            }
            catch (OperationCanceledException)
            {
                // Expected native cancellation has already been asserted before releasing the blocker.
            }
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task ProductionCoordinateAuthority_AwaitsRealReaderAndCommandCleanupWithoutOwningTheTransaction(int cancelAt)
    {
        using SqlSugarClient db = await CreateResolverDatabaseAsync();
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await db.Ado.ExecuteCommandAsync("CREATE TABLE canvas_reference_io_probe(id integer PRIMARY KEY);");
        db.CurrentConnectionConfig.IsAutoCloseConnection = false;
        await db.Ado.BeginTranAsync();
        await db.Ado.ExecuteCommandAsync("INSERT INTO canvas_reference_io_probe VALUES (1);");
        var nativeConnection = Assert.IsType<NpgsqlConnection>(db.Ado.Connection);
        var nativeTransaction = Assert.IsType<NpgsqlTransaction>(db.Ado.Transaction);
        using var cancellation = new CancellationTokenSource();
        var io = new NativeIoObservation(cancellation, cancelAt);
        var observedConnection = new ObservedConnection(nativeConnection, io);
        db.Aop.OnLogExecuted = (sql, _) =>
        {
            if (sql.Contains("SELECT article.id, article.current_revision_id", StringComparison.Ordinal))
            {
                // SqlSugar executed its real scope query first. Only the subsequent native command is observed.
                db.Ado.Connection = observedConnection;
            }
        };
        Task<IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact>> reading = Task.Run(() =>
            new PostgresAuthoringCanvasCoordinateAuthority(db).ReadBatchAsync(
                new AuthoringCanvasCoordinateFactQuery(Guid.CreateVersion7(), 1, new string('c', 64),
                    s_owner, [BlockTarget(Guid.CreateVersion7(), "intro-block")]), cancellation.Token));
        try
        {
            await io.CleanupEntered.Task.WaitAsync(TimeSpan.FromSeconds(30));
            Assert.False(reading.IsCompleted);
            Assert.Equal(1, io.ExecuteCount);
            Assert.Equal(1, io.EofCount);
            Assert.True(io.CharactersRead > 0);
            Assert.Equal(CommandBehavior.SequentialAccess, io.Behavior);
            Assert.Equal(cancellation.Token, io.Token);
            Assert.Same(nativeTransaction, io.Transaction);
            io.CleanupReleased.TrySetResult();
            if (cancelAt == 0)
            {
                AuthoringCanvasCoordinateFact fact = Assert.Single((await reading.WaitAsync(TimeSpan.FromSeconds(30))).Values);
                Assert.Equal("Current block", fact.ContextSnippet);
                Assert.Equal(AuthoringCanvasReferenceCoordinateState.Current, fact.State);
            }
            else
            {
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reading.WaitAsync(TimeSpan.FromSeconds(30)));
            }
            Assert.True(io.ReaderDisposed);
            Assert.True(io.CommandDisposed);
            Assert.Equal(1, io.TextDisposed);
            Assert.Equal(0, io.ConnectionCloseCount);
            Assert.Equal(0, io.ConnectionDisposeCount);
            Assert.Same(nativeConnection, nativeTransaction.Connection);
            db.Ado.Connection = nativeConnection;
            Assert.Equal(1, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM canvas_reference_io_probe;"));
            Assert.Equal(0, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM canvas_reference_io_probe;"));
        }
        finally
        {
            io.CleanupReleased.TrySetResult();
            try
            {
                await reading.WaitAsync(TimeSpan.FromSeconds(30));
            }
            catch (Exception) when (reading.IsCompleted)
            {
                // Drain the original request before returning its borrowed connection to the fixture owner.
            }
            db.Aop.OnLogExecuted = null;
            db.Ado.Connection = nativeConnection;
            await db.Ado.RollbackTranAsync();
        }
        Assert.Equal(0, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM canvas_reference_io_probe;"));
    }

    [Fact]
    public async Task ProductionSessionRevocation_UsesOriginalPgProjectionAdmissionWithAWarmReferenceCache()
    {
        using SqlSugarClient db = await CreateResolverDatabaseAsync();
        await db.Ado.ExecuteCommandAsync("ALTER TABLE admin_principal ADD COLUMN validationversion bigint NOT NULL DEFAULT 1;");
        PostgresSqlSugarTestClient.InitTables(db, typeof(AdminSession));
        TestTemporalContext temporal = TestTemporalContext.FromEnvironment();
        TimeProvider clock = temporal.BusinessClock;
        DateTime now = clock.GetUtcNow().UtcDateTime;
        const string AccessToken = "task-owned-canvas-session-token";
        const string SessionId = "task-owned-canvas-session";
        await db.Insertable(new AdminSession
        {
            SessionId = SessionId,
            AdminPrincipalId = s_owner.AdminPrincipalId,
            AccessTokenHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(AccessToken))),
            ValidationVersion = 1,
            CreatedAtUtc = now.AddHours(-1),
            IdleExpiresAtUtc = now.AddHours(1),
            AbsoluteExpiresAtUtc = now.AddHours(2)
        }).ExecuteCommandAsync();
        AdminSessionProjectionRuntimeOptions options = AdminSessionProjectionRuntimeOptions.FromConfiguration(
            new ConfigurationBuilder().Build());
        var projection = new AdminSessionProjection(options.ProjectionLimits, clock);
        var authority = new AdminSessionProjectionAuthorityReader(db, projection, options, clock);
        Assert.True(projection.MarkReady(await authority.LoadColdStartAsync()));
        using ServiceProvider services = new ServiceCollection().BuildServiceProvider();
        using var touches = new AdminSessionTouchScheduler(services.GetRequiredService<IServiceScopeFactory>(),
            options, clock, NullLogger<AdminSessionTouchScheduler>.Instance);
        var admission = new AdminSessionValidationService(projection, touches);
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
        [
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", "73"),
            new Claim("admin_sid", SessionId)
        ], "task-owned-session"));
        Assert.True((await admission.ValidateAsync(principal, AccessToken, CancellationToken.None)).IsValid);
        AuthoringCanvasReferenceResolutionRequest request = await CreateRequestAsync(db, s_owner, [ReferenceNode()]);
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolver resolver = Resolver(db, cache);
        Assert.Equal("Current block", Assert.Single((await resolver.ResolveAsync(request)).Projections).ContextSnippet);
        Assert.Equal(1, (await resolver.ResolveAsync(request)).Receipt.CacheHitCount);
        long touchesBeforeRevocation = touches.Snapshot().EnqueuedCount;

        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(1, await writer.Updateable<AdminSession>()
            .SetColumns(session => new AdminSession { RevokedAtUtc = now, ValidationVersion = 2 })
            .Where(session => session.SessionId == SessionId).ExecuteCommandAsync());
        Assert.True(await authority.RefreshSessionAsync(SessionId));
        AdminSessionValidationResult rejected = await admission.ValidateAsync(principal, AccessToken, CancellationToken.None);
        Assert.False(rejected.IsValid);
        Assert.Equal(AdminSessionProjectionReasons.Revoked, rejected.Reason);
        Assert.Equal(touchesBeforeRevocation, touches.Snapshot().EnqueuedCount);
        Assert.Equal(1, cache.EntryCount);
        // This proves the original PG-backed session admission, not an invented session gate in the resolver.
        // Reference requests have no SessionId; in-flight session-to-request cancellation remains a caller-owned gap.
    }

    private sealed class NativeIoObservation(CancellationTokenSource cancellation, int cancelAt)
    {
        public TaskCompletionSource CleanupEntered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource CleanupReleased { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int ExecuteCount
        {
            get; set;
        }
        public int EofCount
        {
            get; set;
        }
        public long CharactersRead
        {
            get; set;
        }
        public int TextDisposed
        {
            get; set;
        }
        public bool ReaderDisposed
        {
            get; set;
        }
        public bool CommandDisposed
        {
            get; set;
        }
        public int ConnectionCloseCount
        {
            get; set;
        }
        public int ConnectionDisposeCount
        {
            get; set;
        }
        public CommandBehavior Behavior
        {
            get; set;
        }
        public CancellationToken Token
        {
            get; set;
        }
        public DbTransaction? Transaction
        {
            get; set;
        }

        public void ObserveCancellation(int boundary)
        {
            if (cancelAt == boundary)
            {
                cancellation.Cancel();
            }
        }
    }

    // These observers delegate every command, row, text read and disposal to the real Npgsql objects.
    // They introduce only a cleanup barrier/cancellation notification; no source facts or EOF values are synthesized.
    private sealed class ObservedConnection(DbConnection inner, NativeIoObservation io) : DbConnection
    {
        [AllowNull]
        public override string ConnectionString
        {
            get => inner.ConnectionString;
            set => inner.ConnectionString = value;
        }
        public override string Database => inner.Database;
        public override string DataSource => inner.DataSource;
        public override string ServerVersion => inner.ServerVersion;
        public override ConnectionState State => inner.State;
        public override void ChangeDatabase(string databaseName) => inner.ChangeDatabase(databaseName);
        public override void Open() => inner.Open();
        public override Task OpenAsync(CancellationToken cancellationToken) => inner.OpenAsync(cancellationToken);
        public override void Close()
        {
            io.ConnectionCloseCount++;
            inner.Close();
        }
        protected override void Dispose(bool disposing)
        {
            io.ConnectionDisposeCount++;
            if (disposing)
            {
                inner.Dispose();
            }
            base.Dispose(disposing);
        }
        protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel) => inner.BeginTransaction(isolationLevel);
        protected override DbCommand CreateDbCommand() => new ObservedCommand(inner.CreateCommand(), io);
    }

    private sealed class ObservedCommand(DbCommand inner, NativeIoObservation io) : DbCommand
    {
        [AllowNull]
        public override string CommandText
        {
            get => inner.CommandText;
            set => inner.CommandText = value;
        }
        public override int CommandTimeout
        {
            get => inner.CommandTimeout;
            set => inner.CommandTimeout = value;
        }
        public override CommandType CommandType
        {
            get => inner.CommandType;
            set => inner.CommandType = value;
        }
        public override bool DesignTimeVisible
        {
            get => inner.DesignTimeVisible;
            set => inner.DesignTimeVisible = value;
        }
        public override UpdateRowSource UpdatedRowSource
        {
            get => inner.UpdatedRowSource;
            set => inner.UpdatedRowSource = value;
        }
        protected override DbConnection? DbConnection
        {
            get => inner.Connection;
            set => inner.Connection = value;
        }
        protected override DbTransaction? DbTransaction
        {
            get => inner.Transaction;
            set => inner.Transaction = value;
        }
        protected override DbParameterCollection DbParameterCollection => inner.Parameters;
        public override void Cancel() => inner.Cancel();
        public override int ExecuteNonQuery() => inner.ExecuteNonQuery();
        public override object? ExecuteScalar() => inner.ExecuteScalar();
        public override void Prepare() => inner.Prepare();
        protected override DbParameter CreateDbParameter() => inner.CreateParameter();
        protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior)
            => new ObservedReader(inner.ExecuteReader(behavior), io);
        protected override async Task<DbDataReader> ExecuteDbDataReaderAsync(CommandBehavior behavior, CancellationToken cancellationToken)
        {
            DbDataReader reader = await inner.ExecuteReaderAsync(behavior, cancellationToken);
            io.ExecuteCount++;
            io.Behavior = behavior;
            io.Token = cancellationToken;
            io.Transaction = inner.Transaction;
            return new ObservedReader(reader, io);
        }
        public override async ValueTask DisposeAsync()
        {
            await inner.DisposeAsync();
            io.CommandDisposed = true;
            io.ObserveCancellation(3);
        }
    }

    private sealed class ObservedReader(DbDataReader inner, NativeIoObservation io) : DbDataReader
    {
        public override int Depth => inner.Depth;
        public override int FieldCount => inner.FieldCount;
        public override bool HasRows => inner.HasRows;
        public override bool IsClosed => inner.IsClosed;
        public override int RecordsAffected => inner.RecordsAffected;
        public override object this[int ordinal] => inner[ordinal];
        public override object this[string name] => inner[name];
        public override bool GetBoolean(int ordinal) => inner.GetBoolean(ordinal);
        public override byte GetByte(int ordinal) => inner.GetByte(ordinal);
        public override long GetBytes(int ordinal, long dataOffset, byte[]? buffer, int bufferOffset, int length)
            => inner.GetBytes(ordinal, dataOffset, buffer, bufferOffset, length);
        public override char GetChar(int ordinal) => inner.GetChar(ordinal);
        public override long GetChars(int ordinal, long dataOffset, char[]? buffer, int bufferOffset, int length)
            => inner.GetChars(ordinal, dataOffset, buffer, bufferOffset, length);
        public override string GetDataTypeName(int ordinal) => inner.GetDataTypeName(ordinal);
        public override DateTime GetDateTime(int ordinal) => inner.GetDateTime(ordinal);
        public override decimal GetDecimal(int ordinal) => inner.GetDecimal(ordinal);
        public override double GetDouble(int ordinal) => inner.GetDouble(ordinal);
        public override Type GetFieldType(int ordinal) => inner.GetFieldType(ordinal);
        public override float GetFloat(int ordinal) => inner.GetFloat(ordinal);
        public override Guid GetGuid(int ordinal) => inner.GetGuid(ordinal);
        public override short GetInt16(int ordinal) => inner.GetInt16(ordinal);
        public override int GetInt32(int ordinal) => inner.GetInt32(ordinal);
        public override long GetInt64(int ordinal) => inner.GetInt64(ordinal);
        public override string GetName(int ordinal) => inner.GetName(ordinal);
        public override int GetOrdinal(string name) => inner.GetOrdinal(name);
        public override string GetString(int ordinal) => inner.GetString(ordinal);
        public override object GetValue(int ordinal) => inner.GetValue(ordinal);
        public override int GetValues(object[] values) => inner.GetValues(values);
        public override bool IsDBNull(int ordinal) => inner.IsDBNull(ordinal);
        public override IEnumerator GetEnumerator() => ((IEnumerable)inner).GetEnumerator();
        public override bool NextResult() => inner.NextResult();
        public override bool Read() => inner.Read();
        public override TextReader GetTextReader(int ordinal) => new ObservedTextReader(inner.GetTextReader(ordinal), io);
        public override async Task<bool> ReadAsync(CancellationToken cancellationToken)
        {
            bool row = await inner.ReadAsync(cancellationToken);
            if (!row)
            {
                io.EofCount++;
                io.ObserveCancellation(1);
            }
            return row;
        }
        public override async ValueTask DisposeAsync()
        {
            io.CleanupEntered.TrySetResult();
            await io.CleanupReleased.Task.WaitAsync(TimeSpan.FromSeconds(30));
            await inner.DisposeAsync();
            io.ReaderDisposed = true;
            io.ObserveCancellation(2);
        }
    }

    private sealed class ObservedTextReader(TextReader inner, NativeIoObservation io) : TextReader
    {
        public override async ValueTask<int> ReadAsync(Memory<char> buffer, CancellationToken cancellationToken = default)
        {
            int count = await inner.ReadAsync(buffer, cancellationToken);
            io.CharactersRead += count;
            return count;
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                inner.Dispose();
                io.TextDisposed++;
            }
            base.Dispose(disposing);
        }
    }

    private async Task<SqlSugarClient> CreateResolverDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(id bigint PRIMARY KEY, status text NOT NULL, isroot boolean NOT NULL, permissions text NOT NULL);
            INSERT INTO admin_principal VALUES (73, 'active', false, E'article.write\n'), (74, 'active', false, E'article.write\n');
            CREATE TABLE article(id integer PRIMARY KEY, title varchar(256) NOT NULL, summary varchar(512), status integer NOT NULL,
                isdeleted boolean NOT NULL, current_revision_id bigint);
            CREATE TABLE article_revision(id bigint PRIMARY KEY, article_id integer NOT NULL, title varchar(256) NOT NULL,
                summary varchar(512), markdown_content text NOT NULL DEFAULT '', content_block_id bigint,
                created_by_admin_principal_id bigint NOT NULL);
            CREATE TABLE article_revision_content_block(id bigint PRIMARY KEY, content_hash varchar(64) NOT NULL,
                markdown_content text NOT NULL, byte_length integer NOT NULL);
            INSERT INTO article VALUES
                (204, 'Owner 73 title', 'Private summary', 2, false, 9002),
                (205, 'Owner 74 title', 'Other summary', 2, false, 9010),
                (206, 'Replacement title', 'Replacement summary', 2, false, 9020);
            INSERT INTO article_revision_content_block VALUES
                (1, 'current', E'# Current head ^doc-head\n\nCurrent block ^intro-block', 52),
                (2, 'pinned', E'# Old head ^doc-head\n\nOld block ^intro-block', 44),
                (3, 'replacement', 'Replacement block ^intro-block', 30);
            INSERT INTO article_revision VALUES
                (9001, 204, 'Old title', 'Old summary', '', 2, 73),
                (9002, 204, 'Owner 73 title', 'Private summary', '', 1, 73),
                (9010, 205, 'Owner 74 title', 'Other summary', '', 3, 74),
                (9020, 206, 'Replacement title', 'Replacement summary', '', 3, 73);
            """);
        ISchemaMigrationDescriptor migration = AuthoringCanvasDocumentMigrationDefinitions.BuildMigration();
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        return db;
    }

    private static AuthoringCanvasReferenceResolver Resolver(SqlSugarClient db, AuthoringCanvasReferenceProjectionCache cache)
        => new(new AuthoringCanvasDocumentStore(db, TimeProvider.System),
            new AuthoringCanvasReferenceFactSource(new PostgresAuthoringCanvasArticleReferenceReader(db),
                new AuthoringCanvasCoordinateFactProvider([new PostgresAuthoringCanvasCoordinateAuthority(db)])),
            cache, TimeProvider.System);

    private static AuthoringCanvasNode ReferenceNode(long? pinned = null, int order = 0)
        => new(Guid.CreateVersion7(), AuthoringCanvasNodeType.BlockReference, order,
            new AuthoringCanvasGeometry(0, 0, 100, 100), TargetArticleId: 204,
            TargetBlockIdentity: "intro-block", PinnedTargetRevision: pinned,
            ReferenceState: pinned is null ? AuthoringCanvasReferenceState.Current : AuthoringCanvasReferenceState.Pinned);

    private static async Task<AuthoringCanvasReferenceResolutionRequest> CreateRequestAsync(
        SqlSugarClient db, AuthoringCanvasOwner owner, IReadOnlyList<AuthoringCanvasNode> nodes)
    {
        var store = new AuthoringCanvasDocumentStore(db, TimeProvider.System);
        Guid canvasId = Guid.CreateVersion7();
        AuthoringCanvasWriteReceipt receipt = await store.CreateAsync(new CreateAuthoringCanvasCommand(
            canvasId, owner, "Native reference fixture", new AuthoringCanvasViewport(0, 0, 1), Guid.CreateVersion7()));
        foreach (AuthoringCanvasNode node in nodes)
        {
            receipt = await store.PutNodeAsync(new PutAuthoringCanvasNodeCommand(
                canvasId, owner, receipt.Revision, Guid.CreateVersion7(), node));
        }
        return await ReadRequestAsync(store, owner, canvasId);
    }

    private static async Task<AuthoringCanvasReferenceResolutionRequest> ReadRequestAsync(
        IAuthoringCanvasDocumentStore store, AuthoringCanvasOwner owner, Guid canvasId)
    {
        AuthoringCanvasDocumentHeader header = await store.GetAsync(owner, canvasId)
            ?? throw new InvalidOperationException("native fixture canvas missing");
        AuthoringCanvasPage<AuthoringCanvasNode> page = await store.ReadNodesAsync(owner, canvasId, null, 256);
        return new AuthoringCanvasReferenceResolutionRequest(Guid.CreateVersion7(), canvasId, header.Revision,
            header.ContentDigest, owner, AuthoringCanvasReferencePermission.ArticleRead, page.Items);
    }

    private static bool IsAuthorityRead(string sql)
        => sql.Contains("WITH principal AS", StringComparison.Ordinal);

    private static bool IsArticleMetadataRead(string sql)
        => sql.Contains("SELECT id, title, summary, status, isdeleted, current_revision_id", StringComparison.Ordinal);

    private static void AssertDenied(AuthoringCanvasReferenceProjection projection)
    {
        Assert.Equal(AuthoringCanvasReferenceProjectionStatus.PermissionDeniedOrUnknown, projection.Status);
        Assert.Null(projection.Title);
        Assert.Null(projection.ContextSnippet);
        Assert.Null(projection.OpenIntent);
        Assert.Null(projection.TargetRevision);
        Assert.Null(projection.CurrentTargetRevision);
        Assert.Null(projection.DisplayProjectionReference);
    }

    private static async Task<T> AtSqlBoundaryAsync<T>(SqlSugarClient db, Predicate<string> match, int occurrence,
        Func<Task<T>> run, Func<Task> mutation)
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        TimeSpan timeout = TimeSpan.FromSeconds(30);
        int observed = 0;
        db.Aop.OnLogExecuted = (sql, _) =>
        {
            if (match(sql) && Interlocked.Increment(ref observed) == occurrence)
            {
                // Only observe completed real PostgreSQL execution; never replace its SQL, rows or authority facts.
                entered.TrySetResult();
                released.Task.WaitAsync(timeout).GetAwaiter().GetResult();
            }
        };
        Task<T> pending = Task.Run(run);
        try
        {
            await entered.Task.WaitAsync(timeout);
            Assert.False(pending.IsCompleted);
            await mutation();
            released.TrySetResult();
            return await pending.WaitAsync(timeout);
        }
        finally
        {
            released.TrySetResult();
            db.Aop.OnLogExecuted = null;
            try
            {
                await pending.WaitAsync(timeout);
            }
            catch (Exception) when (pending.IsCompleted)
            {
                // The owning assertion observes the request outcome; cleanup must also drain a rejected request.
            }
        }
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
