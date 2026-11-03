#if COMPOSE
using System.Text;

using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;
using FsusBlog.Shared.Contracts.BlockLinks;

internal static partial class Program
{
    private static void CompositeChecks()
    {
        ArticleBlockTarget target = ArticleBlockTarget.Create(Target, BlockAnchorId.Create("stable"));
        string link = BlockAnchorMarkdownBuilder.Build("display", "old", target);
        byte[] source = Encoding.UTF8.GetBytes($"{link}\n\n```markdown\n{link}\n```\n");
        PortableDependencyManifest graph = Manifest([Link()], bytes: source, side: VaultDependencySourceSide.Server);
        ArticleVaultArticleManifest article = Article(graph);
        ArticleVaultBlockLinkRefactorInput Input(int offset, ArticleBlockTarget? identity = null, PortableDependencyManifest? replacementGraph = null)
            => new(article, replacementGraph ?? graph, (replacementGraph ?? graph).Nodes,
#if STRICT_API
                (replacementGraph ?? graph).Edges,
#endif
                Digest, s_budgets,
                new(offset, offset + link.Length, link), new(identity ?? target, "old"), new(identity ?? target, "new"), 8);
        Check("composite_live_link_projection_control", true, () =>
        {
            var candidate = ArticleVaultBlockLinkRefactor.Propose(Input(0), source);
            return (candidate.Permitted, candidate.ReasonCode);
        });
        Check("forged_code_fence_occurrence_with_live_link_authority", false, () =>
        {
            int fencedOffset = Encoding.UTF8.GetString(source).LastIndexOf(link, StringComparison.Ordinal);
            var input = Input(fencedOffset);
            var candidate = ArticleVaultBlockLinkRefactor.Propose(input, source);
            Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { trace = "fenced-occurrence", fencedOffset,
                candidate.Start, candidate.End, candidate.ExpectedText, candidate.Replacement,
                verifierAccepted = ArticleVaultBlockLinkRefactor.Verify(input, source, candidate) }));
            return (candidate.Permitted, candidate.ReasonCode);
        });
        Check("two_portable_identities_collide_on_one_route_projection", false, () =>
        {
            PortableDependencyManifest collision = Manifest([Link(), Link(OtherTarget)], bytes: source, side: VaultDependencySourceSide.Server);
            var targetB = ArticleBlockTarget.Create(OtherTarget, BlockAnchorId.Create("stable"));
            var input = Input(0, targetB, collision) with { Manifest = Article(collision) };
            var candidate = ArticleVaultBlockLinkRefactor.Propose(input, source);
            Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { trace = "route-collision", targetA = Target,
                targetB = OtherTarget, rawOccurrence = link, candidate.Target,
                verifierAccepted = ArticleVaultBlockLinkRefactor.Verify(input, source, candidate) }));
            return (candidate.Permitted, candidate.ReasonCode);
        });

        if (s_occurrenceOnly)
        {
            return;
        }
        using var signal = new CancellationTokenSource();
        ArticleVaultFrozenEmbedInput embed = FrozenInput(signal.Token);
        Check("composite_published_coordinate_with_newer_target_control", true, () =>
        {
            var candidate = ArticleVaultFrozenEmbedAdmission.Compare(embed);
            return (candidate.Permitted && candidate.After?.ResolvedRevision == 17, candidate.ReasonCode);
        });
        Check("cancellation_between_resolution_and_admission", false, () =>
        {
            signal.Cancel();
            var candidate = ArticleVaultFrozenEmbedAdmission.Compare(embed);
            return (candidate.Permitted, candidate.ReasonCode);
        });
        Check("actor_substitution_reusing_resolved_authority", false, () =>
        {
            using var otherSignal = new CancellationTokenSource();
            ArticleVaultFrozenEmbedInput uncancelled = FrozenInput(otherSignal.Token);
            var request = ArticleEmbedContractValidator.Seal(uncancelled.Request with
            {
                Actor = uncancelled.Request.Actor with { ActorIdentity = "actor:other" }
            });
            var candidate = ArticleVaultFrozenEmbedAdmission.Compare(uncancelled with { Request = request });
            return (candidate.Permitted, candidate.ReasonCode);
        });
    }

    private static ArticleVaultFrozenEmbedInput FrozenInput(CancellationToken cancellationToken)
    {
        byte[] source = Encoding.UTF8.GetBytes($"::embed[target=\"{Target}\" mode=\"article\"]\n");
        var graph = Manifest([Embed()], bytes: source, side: VaultDependencySourceSide.Server, lifecycle: "published");
        var actor = new ArticleEmbedActorContext("actor:primary", s_binding.SiteIdentity, Digest);
        var runtime = new ArticleEmbedRuntimeContext("article-embed", 1, ArticleEmbedSchemas.ProviderRuntime, Digest);
        var document = new ArticleEmbedDocumentIdentity("document:primary", 1);
        var target = new ArticleEmbedTargetIdentity(Target, ArticleEmbedTargetKind.Article, null, null);
        var request = ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderRequest(ArticleEmbedSchemas.ProviderRequest, 1,
            "request:embed", Host, document, 8,
            new(ArticleEmbedSchemas.ParserContract, Target, ArticleEmbedTargetKind.Article, new(0, source.Length - 1)),
            target, ArticleEmbedRequestedScope.Authoring, actor, runtime, graph.Source.Sha256, "", cancellationToken));
        var facts = new ArticleEmbedTargetFacts(Target, s_binding.SiteIdentity, 1, 17, 17, 99,
            ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Published, ArticleEmbedPermissionStatus.Allowed,
            Digest, "revision:17", 128, "test target",
            new(ArticleEmbedProjectionKind.SafeProjection, "projection:target", Digest), [], [], []);
        var authority = ArticleEmbedAuthoringContractValidator.Seal(new ArticleEmbedAuthoritySnapshot(
            ArticleEmbedAuthoringSchemas.AuthoritySnapshot, 1, Host, document, 8, graph.Source.Sha256, 1,
            actor, runtime, null, null, [facts], ""));
        var resolution = ArticleEmbedAuthoringResolver.Resolve([request], authority, s_budgets);
        return new(Article(graph), request, authority, s_budgets, resolution, Coordinate(17), Coordinate(17), Coordinate(17), false);
    }
}
#endif
