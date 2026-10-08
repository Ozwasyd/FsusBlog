using System.Text;

using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultBlockLinkRefactorTests
{
    private const string Host = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string Target = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string CollidingTarget = "article:cccccccc-cccc-cccc-cccc-cccccccccccc";
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
        Assert.Equal(input.SourceRange.MatchedText, candidate.ExpectedText);
        Assert.True(ArticleVaultBlockLinkRefactor.Verify(input, bytes, candidate));
        Assert.Equal(Encoding.UTF8.GetString(bytes)[candidate.Start!.Value..candidate.End!.Value], candidate.ExpectedText);
    }

    [Fact]
    public void IndependentQaFencedOccurrenceSubstitutionIsRejected()
    {
        (ArticleVaultBlockLinkRefactorInput input, byte[] bytes) = Input("new", qaSource: true);
        const string Markdown = "[display](/posts/old#stable)";
        Assert.Equal(Markdown, Encoding.UTF8.GetString(bytes)[42..70]);
        input = input with
        {
            SourceRange = new ArticleRelationSourceRange(42, 70, Markdown)
        };
        ArticleVaultBlockLinkRewriteCandidate candidate = ArticleVaultBlockLinkRefactor.Propose(input, bytes);
        Assert.False(candidate.Permitted);
        Assert.False(ArticleVaultBlockLinkRefactor.Verify(input, bytes, candidate));
    }

    [Fact]
    public void IndependentQaCollidingRouteCannotSubstitutePortableTargetIdentity()
    {
        (ArticleVaultBlockLinkRefactorInput input, byte[] bytes) = Input("new", qaSource: true, collision: true);
        ArticleBlockTarget collision = ArticleBlockTarget.Create(CollidingTarget, BlockAnchorId.Create("stable"));
        input = input with
        {
            Before = new ArticleBlockRouteProjection(collision, "old"),
            After = new ArticleBlockRouteProjection(collision, "new")
        };
        ArticleVaultBlockLinkRewriteCandidate candidate = ArticleVaultBlockLinkRefactor.Propose(input, bytes);
        Assert.False(candidate.Permitted);
        Assert.False(ArticleVaultBlockLinkRefactor.Verify(input, bytes, candidate));
    }

    [Fact]
    public void StaleRevisionAndHistoricalSourceAreNeverRewritten()
    {
        (ArticleVaultBlockLinkRefactorInput input, byte[] bytes) = Input("new");
        AssertRejected(input with
        {
            ExpectedRevision = 9
        }, bytes, "vault_block_link_binding_mismatch");
        VaultArticleCoordinate historical = input.Manifest.Coordinates.Server with
        {
            Lifecycle = "published"
        };
        historical = historical with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(historical)
        };
        ArticleVaultArticleManifest manifest = input.Manifest with
        {
            Coordinates = new VaultArticleCoordinates(historical, historical, historical)
        };
        manifest = manifest with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(manifest)
        };
        AssertRejected(input with
        {
            Manifest = manifest
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
        VaultDependencyNode crossSite = input.CurrentAuthorityNodes[0] with
        {
            Binding = input.CurrentAuthorityNodes[0].Binding with
            {
                SiteIdentity = "site:other"
            }
        };
        AssertRejected(input with
        {
            CurrentAuthorityNodes = [crossSite]
        }, bytes, "vault_block_link_target_unavailable");
        VaultLinkDependency crossTargetScope = ((VaultLinkDependency)input.CurrentAuthorityNodes[0]) with
        {
            TargetBinding = new VaultDependencyBinding("site:primary", "vault:other", Target)
        };
        AssertRejected(input with
        {
            CurrentAuthorityNodes = [crossTargetScope]
        }, bytes, "vault_block_link_target_unavailable");
        AssertRejected(input with
        {
            CurrentAuthorityEdges = [new("unexpected", "changed", VaultDependencyEdgeKind.Requires)]
        }, bytes, "vault_block_link_target_unavailable");
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
    public void MissingCanonicalGraphOrRouteProjectionProducesNoCandidateFacts()
    {
        (ArticleVaultBlockLinkRefactorInput input, byte[] bytes) = Input("new");
        AssertRejected(input with
        {
            Graph = null!
        }, bytes, "vault_block_link_input_invalid");
        AssertRejected(input with
        {
            After = null!
        }, bytes, "vault_block_link_input_invalid");
    }

    [Fact]
    public void UnauthorizedRelationProducesNoTargetOrSourceFragment()
    {
        (ArticleVaultBlockLinkRefactorInput input, byte[] bytes) = Input("new");
        VaultDependencyNode denied = input.CurrentAuthorityNodes[0] with
        {
            Admission = input.CurrentAuthorityNodes[0].Admission with
            {
                Permission = ArticleEmbedPermissionStatus.Denied
            }
        };
        AssertRejected(input with
        {
            CurrentAuthorityNodes = [denied]
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

    private static (ArticleVaultBlockLinkRefactorInput Input, byte[] Bytes) Input(
        string slug, bool qaSource = false, bool collision = false)
    {
        ArticleBlockTarget target = ArticleBlockTarget.Create(Target, BlockAnchorId.Create("stable"));
        string markdown = BlockAnchorMarkdownBuilder.Build(qaSource ? "display" : "显示", "old", target);
        string raw = qaSource
            ? $"{markdown}\n\n```markdown\n{markdown}\n```\n{(collision ? markdown + "\n" : string.Empty)}"
            : $"\uFEFF前文 😀\r\n{markdown}\r\n";
        byte[] bytes = Encoding.UTF8.GetBytes(raw);
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
        var binding = new VaultDependencyBinding(manifest.SiteIdentity, manifest.VaultIdentity, Host);
        var admission = new VaultDependencyAdmission(ArticleEmbedPermissionStatus.Allowed,
            VaultDependencyRight.Read | VaultDependencyRight.Reference,
            VaultDependencyRight.Read | VaultDependencyRight.Reference, Digest, Digest, Digest);
        var node = new VaultLinkDependency(binding, admission,
            new ArticleEmbedTargetIdentity(Target, ArticleEmbedTargetKind.Block, null, "stable"),
            binding with
            {
                PortableArticleIdentity = Target
            }, Digest);
        VaultDependencyNode[] nodes = collision
            ? [node, node with
            {
                Target = new ArticleEmbedTargetIdentity(CollidingTarget, ArticleEmbedTargetKind.Block, null, "stable"),
                TargetBinding = binding with
                {
                    PortableArticleIdentity = CollidingTarget
                }
            }]
            : [node];
        var graph = new PortableDependencyManifest(PortableDependencySchemas.Manifest, PortableDependencySchemas.Version,
            binding, manifest.ServerArticleIdentity, manifest.Coordinates, VaultDependencySourceSide.Server,
            sourceBytes, Digest, nodes, [], string.Empty, string.Empty);
        string graphSha256 = PortableDependencyCodec.GraphDigest(graph);
        coordinate = coordinate with
        {
            DependencySha256 = graphSha256
        };
        coordinate = coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };
        manifest = manifest with
        {
            Coordinates = new VaultArticleCoordinates(coordinate, coordinate, coordinate)
        };
        manifest = manifest with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(manifest)
        };
        graph = PortableDependencyCodec.Seal(graph with
        {
            Coordinates = manifest.Coordinates,
            GraphSha256 = graphSha256
        });
        int start = Encoding.UTF8.GetString(bytes).IndexOf(markdown, StringComparison.Ordinal);
        var range = new ArticleRelationSourceRange(start, start + markdown.Length, markdown);
        var budgets = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_048_576, 60_000, 128);
        Assert.True(ArticleVaultManifestValidator.Validate(manifest).IsValid);
        Assert.True(PortableDependencyVerifier.VerifyCurrent(graph, manifest, bytes, nodes, [], Digest, budgets).IsValid);
        return (new ArticleVaultBlockLinkRefactorInput(manifest, graph, nodes, [], Digest, budgets, range,
            new ArticleBlockRouteProjection(target, "old"), new ArticleBlockRouteProjection(target, slug), 8), bytes);
    }
}
