using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleRelationContractTests
{
    private const string ArticleA = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string ArticleB = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string ArticleC = "article:01991e72-c397-75a2-b61a-da6d7dbd8092";
    private const string RevisionA = "revision:01991e72-aaaa-7a86-bc95-5518cf8bd7dc";
    private const string RevisionB = "revision:01991e72-bbbb-7a86-bc95-5518cf8bd7dc";
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string DigestC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string DigestD = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    private static readonly ArticleRelationContractCoordinate s_coordinate =
        new(1, 1, 1, 1, 1);

    private static readonly ArticleRelationActorContext s_sourceActor =
        new("actor:01991e72-dbed-74bd-a467-027699b78ad8", "site:primary", DigestA);

    private static readonly ArticleRelationActorContext s_queryActor =
        new("actor:01991e72-ffff-7fff-afff-027699b78ad8", "site:primary", DigestB);

    [Fact]
    public void Catalog_IsExactlyTheFiveClosedKindsWithUniqueOwners()
    {
        Assert.True(ArticleRelationContractValidator.ValidateCatalog().IsValid);
        Assert.Equal(
            [
                ArticleRelationKind.Outgoing,
                ArticleRelationKind.Backlink,
                ArticleRelationKind.Broken,
                ArticleRelationKind.VisibilityRisk,
                ArticleRelationKind.UnlinkedMention
            ],
            ArticleRelationCatalog.Definitions.Select(static definition => definition.Kind));
        Assert.Equal(
            ArticleRelationCatalog.Definitions.Count,
            ArticleRelationCatalog.Definitions.Select(static definition => definition.Owner).Distinct().Count());
    }

    [Fact]
    public void Relation_BindsStableSourceTargetOccurrencesVisibilityAndDigests()
    {
        ArticleRelationRecord relation = Outgoing();

        Assert.True(ArticleRelationContractValidator.Validate(relation).IsValid);
        Assert.Equal(
            ArticleRelationDigest.ComputeRelationIdentity(relation),
            relation.RelationIdentity);
        Assert.Equal(
            ArticleRelationDigest.ComputeRelation(relation),
            relation.RecordDigest);
        Assert.Equal(2, relation.Occurrence.Count);
        Assert.Equal(relation.Source.SourceActor, relation.Visibility.SourceActor);
        Assert.Equal(ArticleRelationRevisionKind.Current, relation.Source.RevisionKind);
        Assert.Equal(ArticleRelationLifecycleState.Published, relation.Target.Lifecycle);

        ArticleRelationSet set = ArticleRelationContractValidator.Seal(new ArticleRelationSet(
            ArticleRelationSchemas.RelationSet,
            ArticleRelationSchemas.Version,
            relation.Source,
            [relation],
            string.Empty));
        Assert.True(ArticleRelationContractValidator.Validate(set).IsValid);
    }

    [Fact]
    public void StableTargetIdentity_RejectsUrlSlugTitleAndMixedAnchorCoordinates()
    {
        Assert.False(ArticleRelationContractValidator.Validate(new ArticleRelationTargetIdentity(
            "https://example.test/article",
            ArticleRelationTargetKind.Article,
            null,
            null)).IsValid);
        Assert.False(ArticleRelationContractValidator.Validate(new ArticleRelationTargetIdentity(
            "article:article-title",
            ArticleRelationTargetKind.Article,
            null,
            null)).IsValid);
        Assert.False(ArticleRelationContractValidator.Validate(new ArticleRelationTargetIdentity(
            ArticleA,
            ArticleRelationTargetKind.Heading,
            "heading:heading-a",
            "anchor:block-a")).IsValid);
        Assert.False(ArticleRelationContractValidator.Validate(new ArticleRelationTargetIdentity(
            ArticleA,
            ArticleRelationTargetKind.Block,
            null,
            "anchor:bad#fragment")).IsValid);
        Assert.Equal(
            "article_relation_target_draft_revision_lifecycle_mismatch",
            ArticleRelationContractValidator.Validate(new ArticleRelationTargetFacts(
                Target(ArticleB),
                RevisionB,
                7,
                ArticleRelationRevisionKind.Draft,
                ArticleRelationLifecycleState.Published,
                ArticleRelationPermissionState.Allowed)).ReasonCode);
    }

    [Fact]
    public void BlockTargetIdentity_AcceptsCanonicalAnchorsAndPreservesEstablishedPrefixBytes()
    {
        string[] canonicalAnchors = ["a", "release-notes-2026", new('a', 64)];
        foreach (string anchor in canonicalAnchors)
        {
            Assert.True(BlockAnchorId.TryCreate(anchor, out _).IsValid);
            foreach (string prefix in new[] { string.Empty, "block:", "anchor:" })
            {
                string identity = string.Concat(prefix, anchor);
                var target = new ArticleRelationTargetIdentity(
                    ArticleB, ArticleRelationTargetKind.Block, null, identity);
                Assert.True(ArticleRelationContractValidator.Validate(target).IsValid);

                ArticleRelationRecord relation = ArticleRelationContractValidator.Seal(Outgoing() with
                {
                    Target = Outgoing().Target with
                    {
                        TargetIdentity = target
                    }
                });
                Assert.True(ArticleRelationContractValidator.Validate(relation).IsValid);
                Assert.Equal(identity, relation.Target.TargetIdentity!.BlockAnchorIdentity);
            }
        }

        var raw = new ArticleRelationTargetIdentity(
            ArticleB, ArticleRelationTargetKind.Block, null, "release-notes");
        Assert.NotEqual(raw, raw with
        {
            BlockAnchorIdentity = "anchor:release-notes"
        });
        Assert.NotEqual(raw, raw with
        {
            BlockAnchorIdentity = "block:release-notes"
        });
    }

    [Fact]
    public void BlockTargetIdentity_RejectsNoncanonicalRawAndPrefixedAnchorSuffixes()
    {
        string[] invalidAnchors = [
            string.Empty, "UPPERCASE", "bad_suffix", "1leading", "a:alias", "é",
            "^marker", "#fragment", "a%20", "a b", new('a', 65)
        ];
        foreach (string anchor in invalidAnchors)
        {
            Assert.False(BlockAnchorId.TryCreate(anchor, out _).IsValid);
            foreach (string prefix in new[] { string.Empty, "block:", "anchor:" })
            {
                var target = new ArticleRelationTargetIdentity(
                    ArticleB, ArticleRelationTargetKind.Block, null, string.Concat(prefix, anchor));
                Assert.Equal(
                    "article_relation_target_identity_invalid",
                    ArticleRelationContractValidator.Validate(target).ReasonCode);
            }
        }

        foreach (string identity in new[] { "anchor:http", "block:article-title", "anchor:article-slug" })
        {
            Assert.False(ArticleRelationContractValidator.Validate(new ArticleRelationTargetIdentity(
                ArticleB, ArticleRelationTargetKind.Block, null, identity)).IsValid);
        }
    }

    [Fact]
    public void ResolutionAndVisibilityStates_FailClosedForPublicDraftAndUnknownFacts()
    {
        ArticleRelationRecord outgoingWithoutTarget = ArticleRelationContractValidator.Seal(new ArticleRelationRecord(
            ArticleRelationSchemas.Relation,
            ArticleRelationSchemas.Version,
            string.Empty,
            1,
            ArticleRelationKind.Outgoing,
            Source(),
            Occurrence("[missing]", 20, 29),
            new(null, null, null, null, null, ArticleRelationPermissionState.Unknown),
            AuthoringVisibility(),
            ArticleRelationResolutionStatus.MissingTarget,
            s_coordinate,
            string.Empty));
        Assert.Equal(
            "article_relation_kind_target_required",
            ArticleRelationContractValidator.Validate(outgoingWithoutTarget).ReasonCode);

        ArticleRelationRecord broken = ArticleRelationContractValidator.Seal(new ArticleRelationRecord(
            ArticleRelationSchemas.Relation,
            ArticleRelationSchemas.Version,
            string.Empty,
            1,
            ArticleRelationKind.Broken,
            Source(),
            Occurrence("[missing]", 20, 29),
            new(null, null, null, null, null, ArticleRelationPermissionState.Unknown),
            AuthoringVisibility(),
            ArticleRelationResolutionStatus.MissingTarget,
            s_coordinate,
            string.Empty));
        Assert.True(ArticleRelationContractValidator.Validate(broken).IsValid);

        ArticleRelationRecord publicDraft = ArticleRelationContractValidator.Seal(Outgoing(
            source: Source() with
            {
                Lifecycle = ArticleRelationLifecycleState.Draft
            },
            visibility: new(
                s_sourceActor,
                new("public:anonymous", "site:primary", DigestB),
                ArticleRelationQueryScope.CurrentPublicPublication,
                ArticleRelationPublicContext.AnonymousPublic,
                DigestC)));
        Assert.Equal(
            "article_relation_public_draft_or_private_mix",
            ArticleRelationContractValidator.Validate(publicDraft).ReasonCode);

        ArticleRelationRecord unknownKind = Outgoing() with
        {
            Kind = (ArticleRelationKind)99
        };
        Assert.Equal(
            "article_relation_record_invalid",
            ArticleRelationContractValidator.Validate(unknownKind).ReasonCode);
    }

    [Fact]
    public void RelationSet_RejectsDuplicateRecordsAndTamper()
    {
        ArticleRelationRecord relation = Outgoing();
        ArticleRelationSet duplicate = ArticleRelationContractValidator.Seal(new ArticleRelationSet(
            ArticleRelationSchemas.RelationSet,
            ArticleRelationSchemas.Version,
            relation.Source,
            [relation, relation],
            string.Empty));
        Assert.Equal(
            "article_relation_duplicate_or_orphan_record",
            ArticleRelationContractValidator.Validate(duplicate).ReasonCode);

        Assert.Equal(
            "article_relation_identity_digest_mismatch",
            ArticleRelationContractValidator.Validate(relation with
            {
                Occurrence = relation.Occurrence with
                {
                    Count = 3
                }
            }).ReasonCode);

        Assert.Equal(
            "article_relation_contract_version_unknown",
            ArticleRelationContractValidator.Validate(
                relation with
                {
                    Coordinate = relation.Coordinate with
                    {
                        ContractVersion = 2
                    }
                }).ReasonCode);
    }

    [Fact]
    public void UnlinkedMention_IsExplainableAndNeverAuthoritative()
    {
        ArticleRelationUnlinkedMentionCandidate candidate = ArticleRelationContractValidator.Seal(
            new ArticleRelationUnlinkedMentionCandidate(
                ArticleRelationSchemas.MentionCandidate,
                ArticleRelationSchemas.Version,
                string.Empty,
                Source(),
                AuthoringVisibility(),
                new(100, 111, "Article B"),
                [Target(ArticleB)],
                ArticleRelationMentionMatchRule.ExactTitle,
                ArticleRelationMentionMatchReason.ExactText,
                ArticleRelationMentionConfidence.Certain,
                ArticleRelationMentionAmbiguity.Unique,
                null,
                false,
                s_coordinate,
                string.Empty));

        Assert.True(ArticleRelationContractValidator.Validate(candidate).IsValid);
        Assert.False(ArticleRelationContractValidator.Validate(candidate with
        {
            IsAuthoritative = true
        }).IsValid);

        ArticleRelationUnlinkedMentionCandidate ambiguous = ArticleRelationContractValidator.Seal(candidate with
        {
            CandidateTargets = [Target(ArticleB), Target(ArticleC)],
            Ambiguity = ArticleRelationMentionAmbiguity.Ambiguous
        });
        Assert.True(ArticleRelationContractValidator.Validate(ambiguous).IsValid);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void UnlinkedMention_RejectsResealedSourceActorContextMismatch(int changedField)
    {
        ArticleRelationUnlinkedMentionCandidate valid = ArticleRelationContractValidator.Seal(
            new ArticleRelationUnlinkedMentionCandidate(
                ArticleRelationSchemas.MentionCandidate,
                ArticleRelationSchemas.Version,
                string.Empty,
                Source(),
                AuthoringVisibility(),
                new(100, 111, "Article B"),
                [Target(ArticleB)],
                ArticleRelationMentionMatchRule.ExactTitle,
                ArticleRelationMentionMatchReason.ExactText,
                ArticleRelationMentionConfidence.Certain,
                ArticleRelationMentionAmbiguity.Unique,
                null,
                false,
                s_coordinate,
                string.Empty));
        Assert.True(ArticleRelationContractValidator.Validate(valid).IsValid);
        Assert.NotEqual(valid.Source.SourceActor, valid.Visibility.QueryActor);

        ArticleRelationUnlinkedMentionCandidate equalSourceContext = ArticleRelationContractValidator.Seal(valid with
        {
            Visibility = valid.Visibility with
            {
                SourceActor = valid.Source.SourceActor with
                {
                }
            }
        });
        Assert.True(ArticleRelationContractValidator.Validate(equalSourceContext).IsValid);

        ArticleRelationActorContext mismatchedSource = changedField switch
        {
            0 => s_sourceActor with { ActorIdentity = s_queryActor.ActorIdentity },
            1 => s_sourceActor with { SiteIdentity = "site:secondary" },
            _ => s_sourceActor with { PermissionContextDigest = DigestD }
        };
        ArticleRelationUnlinkedMentionCandidate mismatch = ArticleRelationContractValidator.Seal(valid with
        {
            Visibility = valid.Visibility with
            {
                SourceActor = mismatchedSource
            }
        });
        Assert.True(ArticleRelationContractValidator.Validate(mismatch.Source).IsValid);
        Assert.True(ArticleRelationContractValidator.Validate(mismatch.Visibility).IsValid);
        Assert.NotEqual(mismatch.Source.SourceActor, mismatch.Visibility.SourceActor);
        Assert.Equal(ArticleRelationDigest.ComputeCandidateIdentity(mismatch), mismatch.CandidateIdentity);
        Assert.Equal(ArticleRelationDigest.ComputeCandidate(mismatch), mismatch.CandidateDigest);
        Assert.Equal(
            "article_relation_source_actor_binding_mismatch",
            ArticleRelationContractValidator.Validate(mismatch).ReasonCode);
    }

    [Fact]
    public void LifecycleEvents_RequireOwnedClosedObligations()
    {
        ArticleRelationLifecycleEvent create = ArticleRelationContractValidator.Seal(new ArticleRelationLifecycleEvent(
            ArticleRelationSchemas.LifecycleEvent,
            ArticleRelationSchemas.Version,
            string.Empty,
            ArticleRelationLifecycleEventKind.Create,
            ArticleRelationLifecycleOwner.SourceRevisionAuthority,
            ArticleA,
            RevisionA,
            2,
            ArticleRelationLifecycleChanges.None,
            ArticleRelationLifecycleObligations.Rebuild | ArticleRelationLifecycleObligations.Reresolve,
            s_coordinate,
            string.Empty));
        Assert.True(ArticleRelationContractValidator.Validate(create).IsValid);

        ArticleRelationLifecycleEvent rename = ArticleRelationContractValidator.Seal(create with
        {
            EventIdentity = string.Empty,
            Kind = ArticleRelationLifecycleEventKind.SlugTitleHeadingRename,
            Owner = ArticleRelationLifecycleOwner.ArticleIdentityAuthority,
            Changes = ArticleRelationLifecycleChanges.HeadingIdentity,
            Obligations = ArticleRelationLifecycleObligations.Rebuild
                | ArticleRelationLifecycleObligations.Invalidate
                | ArticleRelationLifecycleObligations.Reresolve,
            EventDigest = string.Empty
        });
        Assert.True(ArticleRelationContractValidator.Validate(rename).IsValid);
        Assert.Equal(
            "article_relation_lifecycle_owner_mismatch",
            ArticleRelationContractValidator.Validate(rename with
            {
                Owner = ArticleRelationLifecycleOwner.SourceRevisionAuthority
            }).ReasonCode);
        Assert.Equal(
            "article_relation_lifecycle_obligations_invalid",
            ArticleRelationContractValidator.Validate(rename with
            {
                Obligations = ArticleRelationLifecycleObligations.None
            }).ReasonCode);
    }

    [Theory]
    [InlineData((ArticleRelationLifecycleChanges)8, ArticleRelationLifecycleObligations.Invalidate)]
    [InlineData((ArticleRelationLifecycleChanges)128, ArticleRelationLifecycleObligations.Invalidate)]
    [InlineData((ArticleRelationLifecycleChanges)129, ArticleRelationLifecycleObligations.Invalidate)]
    [InlineData((ArticleRelationLifecycleChanges)132, ArticleRelationLifecycleObligations.Rebuild
        | ArticleRelationLifecycleObligations.Invalidate | ArticleRelationLifecycleObligations.Reresolve)]
    public void LifecycleEvents_RejectFullySealedUnknownChangeBits(
        ArticleRelationLifecycleChanges changes,
        ArticleRelationLifecycleObligations obligations)
    {
        ArticleRelationLifecycleEvent valid = RenameLifecycle(
            ArticleRelationLifecycleChanges.HeadingIdentity,
            ArticleRelationLifecycleObligations.Rebuild
                | ArticleRelationLifecycleObligations.Invalidate
                | ArticleRelationLifecycleObligations.Reresolve);
        Assert.True(ArticleRelationContractValidator.Validate(valid).IsValid);

        ArticleRelationLifecycleEvent unknown = ArticleRelationContractValidator.Seal(valid with
        {
            Changes = changes,
            Obligations = obligations
        });
        Assert.Equal(ArticleRelationDigest.ComputeLifecycleIdentity(unknown), unknown.EventIdentity);
        Assert.Equal(ArticleRelationDigest.ComputeLifecycle(unknown), unknown.EventDigest);
        Assert.True(ArticleRelationContractValidator.Validate(unknown.Coordinate).IsValid);
        Assert.Equal(
            "article_relation_lifecycle_event_invalid",
            ArticleRelationContractValidator.Validate(unknown).ReasonCode);
    }

    [Theory]
    [InlineData(ArticleRelationLifecycleChanges.Slug, ArticleRelationLifecycleObligations.Invalidate)]
    [InlineData(ArticleRelationLifecycleChanges.Title, ArticleRelationLifecycleObligations.Invalidate)]
    [InlineData(ArticleRelationLifecycleChanges.Slug | ArticleRelationLifecycleChanges.Title,
        ArticleRelationLifecycleObligations.Invalidate)]
    [InlineData(ArticleRelationLifecycleChanges.HeadingIdentity, ArticleRelationLifecycleObligations.Rebuild
        | ArticleRelationLifecycleObligations.Invalidate | ArticleRelationLifecycleObligations.Reresolve)]
    [InlineData(ArticleRelationLifecycleChanges.Slug | ArticleRelationLifecycleChanges.HeadingIdentity,
        ArticleRelationLifecycleObligations.Rebuild | ArticleRelationLifecycleObligations.Invalidate
        | ArticleRelationLifecycleObligations.Reresolve)]
    [InlineData(ArticleRelationLifecycleChanges.Title | ArticleRelationLifecycleChanges.HeadingIdentity,
        ArticleRelationLifecycleObligations.Rebuild | ArticleRelationLifecycleObligations.Invalidate
        | ArticleRelationLifecycleObligations.Reresolve)]
    [InlineData(ArticleRelationLifecycleChanges.Slug | ArticleRelationLifecycleChanges.Title
        | ArticleRelationLifecycleChanges.HeadingIdentity, ArticleRelationLifecycleObligations.Rebuild
        | ArticleRelationLifecycleObligations.Invalidate | ArticleRelationLifecycleObligations.Reresolve)]
    public void LifecycleEvents_AcceptEveryClosedChangeCombinationAndRequireHeadingObligations(
        ArticleRelationLifecycleChanges changes,
        ArticleRelationLifecycleObligations obligations)
    {
        ArticleRelationLifecycleEvent rename = RenameLifecycle(changes, obligations);
        Assert.Equal(ArticleRelationDigest.ComputeLifecycleIdentity(rename), rename.EventIdentity);
        Assert.Equal(ArticleRelationDigest.ComputeLifecycle(rename), rename.EventDigest);
        Assert.True(ArticleRelationContractValidator.Validate(rename).IsValid);
        if (changes.HasFlag(ArticleRelationLifecycleChanges.HeadingIdentity))
        {
            ArticleRelationLifecycleEvent missingHeadingWork = ArticleRelationContractValidator.Seal(rename with
            {
                Obligations = ArticleRelationLifecycleObligations.Invalidate
            });
            Assert.Equal(ArticleRelationDigest.ComputeLifecycleIdentity(missingHeadingWork),
                missingHeadingWork.EventIdentity);
            Assert.Equal(ArticleRelationDigest.ComputeLifecycle(missingHeadingWork),
                missingHeadingWork.EventDigest);
            Assert.Equal(
                "article_relation_lifecycle_obligations_invalid",
                ArticleRelationContractValidator.Validate(missingHeadingWork).ReasonCode);
        }
    }

    [Fact]
    public void Receipts_BindToolchainPolicyCoordinatesAndContentDigest()
    {
        ArticleRelationRecord relation = Outgoing();
        ArticleRelationReceipt receipt = ArticleRelationContractValidator.Seal(new ArticleRelationReceipt(
            ArticleRelationSchemas.Receipt,
            ArticleRelationSchemas.Version,
            string.Empty,
            ArticleRelationReceiptKind.Index,
            new(
                ArticleA,
                RevisionA,
                4,
                ArticleRelationRevisionKind.Current,
                s_sourceActor,
                s_queryActor,
                ArticleRelationQueryScope.Authoring,
                "worktree:2236",
                "build:d5eb8013",
                "parser:canonical",
                "renderer:server",
                1,
                1,
                s_coordinate,
                DigestD),
            [relation.RecordDigest],
            [],
            1,
            0,
            string.Empty));

        Assert.True(ArticleRelationContractValidator.Validate(receipt).IsValid);
        Assert.Equal(
            "article_relation_receipt_invalid",
            ArticleRelationContractValidator.Validate(receipt with
            {
                RelationCount = 0
            }).ReasonCode);
        Assert.Equal(
            "article_relation_contract_version_unknown",
            ArticleRelationContractValidator.Validate(receipt with
            {
                Context = receipt.Context with
                {
                    Coordinate = receipt.Context.Coordinate with
                    {
                        LifecycleCatalogVersion = 2
                    }
                }
            }).ReasonCode);
    }

    private static ArticleRelationLifecycleEvent RenameLifecycle(
        ArticleRelationLifecycleChanges changes,
        ArticleRelationLifecycleObligations obligations)
        => ArticleRelationContractValidator.Seal(new ArticleRelationLifecycleEvent(
            ArticleRelationSchemas.LifecycleEvent,
            ArticleRelationSchemas.Version,
            string.Empty,
            ArticleRelationLifecycleEventKind.SlugTitleHeadingRename,
            ArticleRelationLifecycleOwner.ArticleIdentityAuthority,
            ArticleA,
            RevisionA,
            2,
            changes,
            obligations,
            s_coordinate,
            string.Empty));

    private static ArticleRelationRecord Outgoing(
        ArticleRelationSourceFacts? source = null,
        ArticleRelationVisibilityFacts? visibility = null)
    {
        source ??= Source();
        visibility ??= AuthoringVisibility();
        return ArticleRelationContractValidator.Seal(new ArticleRelationRecord(
            ArticleRelationSchemas.Relation,
            ArticleRelationSchemas.Version,
            string.Empty,
            1,
            ArticleRelationKind.Outgoing,
            source,
            Occurrence("[target]", 0, 8, 2),
            new(Target(ArticleB), RevisionB, 7, ArticleRelationRevisionKind.Published, ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed),
            visibility,
            ArticleRelationResolutionStatus.Resolved,
            s_coordinate,
            string.Empty));
    }

    private static ArticleRelationSourceFacts Source()
        => new(
            ArticleA,
            RevisionA,
            4,
            ArticleRelationRevisionKind.Current,
            ArticleRelationLifecycleState.Published,
            ArticleRelationPermissionState.Allowed,
            s_sourceActor,
            DigestC);

    private static ArticleRelationVisibilityFacts AuthoringVisibility()
        => new(
            s_sourceActor,
            s_queryActor,
            ArticleRelationQueryScope.Authoring,
            ArticleRelationPublicContext.AuthoringActor,
            DigestB);

    private static ArticleRelationTargetIdentity Target(string articleIdentity)
        => new(articleIdentity, ArticleRelationTargetKind.Article, null, null);

    private static ArticleRelationOccurrence Occurrence(
        string linkText,
        int start,
        int end,
        int count = 1)
        => new(
            linkText,
            new(start, end, linkText),
            new(start + (count - 1) * 10, end + (count - 1) * 10, linkText),
            count);
}
