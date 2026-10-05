namespace FsusBlog.Shared.Contracts.ArticleRelations;

/// <summary>
/// The only relation-kind map. Downstream producer, query and UI slices consume this catalog rather than
/// declaring a second type/status table.
/// </summary>
public static class ArticleRelationCatalog
{
    private static readonly ArticleRelationKindDefinition[] s_definitions =
    [
        new(
            ArticleRelationKind.Outgoing,
            "outgoing",
            ArticleRelationOwner.SourceRevisionAuthority,
            ArticleRelationEligibility.AuthoringQuery
                | ArticleRelationEligibility.PublicQuery
                | ArticleRelationEligibility.PublicationEvidence,
            "source-article-revision-range-actor-lifecycle",
            "stable-target-article-revision-anchor-rights-lifecycle",
            true,
            "article-relation-outgoing-contract"),
        new(
            ArticleRelationKind.Backlink,
            "backlink",
            ArticleRelationOwner.RelationIndexAuthority,
            ArticleRelationEligibility.AuthoringQuery
                | ArticleRelationEligibility.PublicQuery
                | ArticleRelationEligibility.PublicationEvidence,
            "source-article-revision-range-actor-lifecycle",
            "stable-target-article-revision-anchor-rights-lifecycle",
            true,
            "article-relation-backlink-contract"),
        new(
            ArticleRelationKind.Broken,
            "broken",
            ArticleRelationOwner.ResolutionAuthority,
            ArticleRelationEligibility.AuthoringQuery | ArticleRelationEligibility.PublicationEvidence,
            "source-article-revision-range-actor-lifecycle",
            "stable-target-article-revision-anchor-rights-lifecycle-or-missing",
            false,
            "article-relation-broken-contract"),
        new(
            ArticleRelationKind.VisibilityRisk,
            "visibility-risk",
            ArticleRelationOwner.VisibilityPolicyAuthority,
            ArticleRelationEligibility.AuthoringQuery | ArticleRelationEligibility.PublicationEvidence,
            "source-article-revision-range-actor-lifecycle",
            "stable-target-article-revision-anchor-rights-lifecycle",
            true,
            "article-relation-visibility-risk-contract"),
        new(
            ArticleRelationKind.UnlinkedMention,
            "unlinked-mention",
            ArticleRelationOwner.MentionMatcherAuthority,
            ArticleRelationEligibility.AuthoringQuery,
            "source-article-revision-range-actor-lifecycle",
            "candidate-target-identities-only",
            false,
            "article-relation-unlinked-mention-contract")
    ];

    public static IReadOnlyList<ArticleRelationKindDefinition> Definitions => s_definitions;

    public static bool TryGet(ArticleRelationKind kind, out ArticleRelationKindDefinition? definition)
    {
        foreach (ArticleRelationKindDefinition candidate in s_definitions)
        {
            if (candidate.Kind == kind)
            {
                definition = candidate;
                return true;
            }
        }

        definition = null;
        return false;
    }

    public static ArticleRelationValidationResult Validate()
    {
        ArticleRelationKind[] expectedKinds =
        [
            ArticleRelationKind.Outgoing,
            ArticleRelationKind.Backlink,
            ArticleRelationKind.Broken,
            ArticleRelationKind.VisibilityRisk,
            ArticleRelationKind.UnlinkedMention
        ];
        if (s_definitions.Length != expectedKinds.Length)
        {
            return ArticleRelationValidationResult.Invalid("article_relation_kind_catalog_incomplete");
        }

        var seenKinds = new HashSet<ArticleRelationKind>();
        var seenKeys = new HashSet<string>(StringComparer.Ordinal);
        var seenOwners = new HashSet<ArticleRelationOwner>();
        foreach (ArticleRelationKindDefinition definition in s_definitions)
        {
            if (!Enum.IsDefined(definition.Kind)
                || !seenKinds.Add(definition.Kind)
                || !seenKeys.Add(definition.Key)
                || !seenOwners.Add(definition.Owner)
                || string.IsNullOrWhiteSpace(definition.Key)
                || string.IsNullOrWhiteSpace(definition.SourceFacts)
                || string.IsNullOrWhiteSpace(definition.TargetFacts)
                || string.IsNullOrWhiteSpace(definition.ProofTestId)
                || definition.Eligibility == ArticleRelationEligibility.None)
            {
                return ArticleRelationValidationResult.Invalid("article_relation_kind_catalog_duplicate_or_invalid");
            }

            if (!expectedKinds.Contains(definition.Kind)
                || !string.Equals(definition.Key, KeyFor(definition.Kind), StringComparison.Ordinal)
                || definition.Owner != OwnerFor(definition.Kind)
                || definition.RequiresStableTarget != RequiresStableTargetFor(definition.Kind))
            {
                return ArticleRelationValidationResult.Invalid("article_relation_kind_catalog_orphan");
            }
        }

        foreach (ArticleRelationKind expected in expectedKinds)
        {
            if (!seenKinds.Contains(expected))
            {
                return ArticleRelationValidationResult.Invalid("article_relation_kind_catalog_orphan");
            }
        }

        return ArticleRelationValidationResult.Valid();
    }

    public static ArticleRelationEligibility EligibilityFor(ArticleRelationKind kind)
        => TryGet(kind, out ArticleRelationKindDefinition? definition)
            ? definition!.Eligibility
            : ArticleRelationEligibility.None;

    public static ArticleRelationOwner OwnerFor(ArticleRelationKind kind)
        => kind switch
        {
            ArticleRelationKind.Outgoing => ArticleRelationOwner.SourceRevisionAuthority,
            ArticleRelationKind.Backlink => ArticleRelationOwner.RelationIndexAuthority,
            ArticleRelationKind.Broken => ArticleRelationOwner.ResolutionAuthority,
            ArticleRelationKind.VisibilityRisk => ArticleRelationOwner.VisibilityPolicyAuthority,
            ArticleRelationKind.UnlinkedMention => ArticleRelationOwner.MentionMatcherAuthority,
            _ => throw new ArgumentOutOfRangeException(nameof(kind))
        };

    public static bool RequiresStableTargetFor(ArticleRelationKind kind)
        => kind is ArticleRelationKind.Outgoing
            or ArticleRelationKind.Backlink
            or ArticleRelationKind.VisibilityRisk;

    private static string KeyFor(ArticleRelationKind kind)
        => kind switch
        {
            ArticleRelationKind.Outgoing => "outgoing",
            ArticleRelationKind.Backlink => "backlink",
            ArticleRelationKind.Broken => "broken",
            ArticleRelationKind.VisibilityRisk => "visibility-risk",
            ArticleRelationKind.UnlinkedMention => "unlinked-mention",
            _ => string.Empty
        };
}
