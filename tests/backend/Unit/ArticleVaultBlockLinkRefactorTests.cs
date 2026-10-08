using System.Text;

using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultBlockLinkRefactorTests
{
    private const string Host = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string Target = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Theory]
    [InlineData("renamed")]
    [InlineData("标题-😀")]
    [InlineData("CaseChanged")]
    public void SlugChangeProducesAnExplicitRewriteWithStablePortableTarget(string slug)
    {
        (ArticleVaultBlockLinkRefactorInput input, byte[] bytes) = Input(slug);
        ArticleVaultBlockLinkRewriteCandidate candidate = ArticleVaultBlockLinkRefactor.Propose(input, bytes);

        Assert.True(candidate.Permitted);
        Assert.Equal(input.Before.Target, candidate.Target);
        Assert.Equal(BlockAnchorMarkdownBuilder.Build("显示", slug, input.Before.Target), candidate.Replacement);
        Assert.Equal(input.Relation.Occurrence.First.MatchedText, candidate.ExpectedText);
        Assert.True(ArticleVaultBlockLinkRefactor.Verify(input, bytes, candidate));
        Assert.Equal(Encoding.UTF8.GetString(bytes)[candidate.Start!.Value..candidate.End!.Value], candidate.ExpectedText);
    }

    [Fact]
    public void StaleRevisionAndHistoricalSourceAreNeverRewritten()
    {
        (ArticleVaultBlockLinkRefactorInput input, byte[] bytes) = Input("new");
        AssertRejected(input with
        {
            ExpectedRevision = 9
        }, bytes, "vault_block_link_binding_mismatch");
        ArticleRelationRecord historical = ArticleRelationContractValidator.Seal(input.Relation with
        {
            Source = input.Relation.Source with
            {
                RevisionKind = ArticleRelationRevisionKind.Published,
                Lifecycle = ArticleRelationLifecycleState.Published
            }
        });
        AssertRejected(input with
        {
            Relation = historical
        }, bytes, "vault_block_link_binding_mismatch");
    }

    [Fact]
    public void RouteNeverSelectsADifferentTargetOrCrossSiteSource()
    {
        (ArticleVaultBlockLinkRefactorInput input, byte[] bytes) = Input("new");
        AssertRejected(input with
        {
            After = input.After with
            {
                Target = ArticleBlockTarget.Create(Host, BlockAnchorId.Create("stable"))
            }
        }, bytes, "vault_block_link_binding_mismatch");
        ArticleRelationRecord crossSite = ArticleRelationContractValidator.Seal(input.Relation with
        {
            Visibility = input.Relation.Visibility with
            {
                QueryActor = input.Relation.Visibility.QueryActor with
                {
                    SiteIdentity = "site:other"
                }
            }
        });
        AssertRejected(input with
        {
            Relation = crossSite
        }, bytes, "vault_block_link_binding_mismatch");
    }

    [Fact]
    public void SourceRangeProjectionAndCandidateTamperAreRejected()
    {
        (ArticleVaultBlockLinkRefactorInput input, byte[] bytes) = Input("new");
        AssertRejected(input, Encoding.UTF8.GetBytes("modified"), "vault_block_link_source_mismatch");
        AssertRejected(input with
        {
            Before = input.Before with
            {
                CanonicalSlug = "wrong"
            }
        }, bytes, "vault_block_link_projection_mismatch");
        ArticleVaultBlockLinkRewriteCandidate candidate = ArticleVaultBlockLinkRefactor.Propose(input, bytes);
        Assert.False(ArticleVaultBlockLinkRefactor.Verify(input, bytes, candidate with
        {
            Replacement = "[changed](/posts/new#stable)"
        }));
    }

    [Fact]
    public void UnauthorizedRelationProducesNoTargetOrSourceFragment()
    {
        (ArticleVaultBlockLinkRefactorInput input, byte[] bytes) = Input("new");
        ArticleRelationRecord denied = ArticleRelationContractValidator.Seal(input.Relation with
        {
            Resolution = ArticleRelationResolutionStatus.Unauthorized,
            Target = new ArticleRelationTargetFacts(null, null, null, null, null, ArticleRelationPermissionState.Denied)
        });
        Assert.True(ArticleRelationContractValidator.Validate(denied).IsValid);
        AssertRejected(input with
        {
            Relation = denied
        }, bytes, "vault_block_link_target_unavailable");
    }

    private static void AssertRejected(ArticleVaultBlockLinkRefactorInput input, byte[] bytes, string reason)
    {
        ArticleVaultBlockLinkRewriteCandidate candidate = ArticleVaultBlockLinkRefactor.Propose(input, bytes);
        Assert.False(candidate.Permitted);
        Assert.Equal(reason, candidate.ReasonCode);
        Assert.Null(candidate.Target);
        Assert.Null(candidate.ExpectedText);
        Assert.Null(candidate.Replacement);
        Assert.Null(candidate.InputSha256);
    }

    private static (ArticleVaultBlockLinkRefactorInput Input, byte[] Bytes) Input(string slug)
    {
        ArticleBlockTarget target = ArticleBlockTarget.Create(Target, BlockAnchorId.Create("stable"));
        string markdown = BlockAnchorMarkdownBuilder.Build("显示", "old", target);
        byte[] bytes = Encoding.UTF8.GetBytes($"\uFEFF前文 😀\r\n{markdown}\r\n");
        VaultSourceByteIdentity sourceBytes = ArticleVaultManifestCodec.CaptureSourceBytes(bytes);
        var coordinate = new VaultArticleCoordinate(ArticleVaultSchemas.Coordinate, ArticleVaultSchemas.Version,
            true, false, 8, sourceBytes, Digest, Digest, "draft", Digest, string.Empty);
        coordinate = coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };
        const string Path = "articles/source.md";
        var manifest = new ArticleVaultArticleManifest(ArticleVaultSchemas.ArticleManifest, ArticleVaultSchemas.Version,
            "site:primary", "vault:primary", "device:primary", Host, "server:42",
            new VaultPathProjection(Path, ArticleVaultManifestCodec.ComputeProjectionSha256(Path)),
            new VaultArticleCoordinates(coordinate, coordinate, coordinate),
            new VaultOperationWatermarks(0, null, null, null, null, null, null), VaultArticleState.Clean, string.Empty);
        manifest = manifest with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(manifest)
        };
        var actor = new ArticleRelationActorContext("actor:01991e72-dbed-74bd-a467-027699b78ad8", "site:primary", Digest);
        var source = new ArticleRelationSourceFacts(Host, "revision:01991e72-aaaa-7a86-bc95-5518cf8bd7dc", 8,
            ArticleRelationRevisionKind.Draft, ArticleRelationLifecycleState.Draft, ArticleRelationPermissionState.Allowed, actor, sourceBytes.Sha256);
        int start = Encoding.UTF8.GetString(bytes).IndexOf(markdown, StringComparison.Ordinal);
        var range = new ArticleRelationSourceRange(start, start + markdown.Length, markdown);
        ArticleRelationRecord relation = ArticleRelationContractValidator.Seal(new ArticleRelationRecord(
            ArticleRelationSchemas.Relation, ArticleRelationSchemas.Version, string.Empty, 1, ArticleRelationKind.Outgoing,
            source, new ArticleRelationOccurrence("显示", range, range, 1),
            new ArticleRelationTargetFacts(new ArticleRelationTargetIdentity(Target, ArticleRelationTargetKind.Block, null, "stable"),
                "revision:01991e72-bbbb-7a86-bc95-5518cf8bd7dc", 17, ArticleRelationRevisionKind.Published,
                ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed),
            new ArticleRelationVisibilityFacts(actor, actor, ArticleRelationQueryScope.Authoring, ArticleRelationPublicContext.AuthoringActor, Digest),
            ArticleRelationResolutionStatus.Resolved, new ArticleRelationContractCoordinate(1, 1, 1, 1, 1), string.Empty));
        Assert.True(ArticleVaultManifestValidator.Validate(manifest).IsValid);
        Assert.True(ArticleRelationContractValidator.Validate(relation).IsValid);
        return (new ArticleVaultBlockLinkRefactorInput(manifest, relation,
            new ArticleBlockRouteProjection(target, "old"), new ArticleBlockRouteProjection(target, slug), 8), bytes);
    }
}
