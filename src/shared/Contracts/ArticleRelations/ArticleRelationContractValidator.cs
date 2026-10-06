using System.Security.Cryptography;

namespace FsusBlog.Shared.Contracts.ArticleRelations;

/// <summary>
/// Fail-closed validation and sealing for relation records, candidate facts, lifecycle events and receipts.
/// This type contains no parser, index writer, query, publication rule or UI behavior.
/// </summary>
public static class ArticleRelationContractValidator
{
    public const int MaxRelationsPerSet = 100_000;
    public const int MaxCandidatesPerSource = 10_000;

    public static ArticleRelationRecord Seal(ArticleRelationRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);
        ArticleRelationRecord unsigned = record with
        {
            RelationIdentity = string.Empty,
            RecordDigest = string.Empty
        };
        string identity = ArticleRelationDigest.ComputeRelationIdentity(unsigned);
        ArticleRelationRecord identified = unsigned with
        {
            RelationIdentity = identity
        };
        return identified with
        {
            RecordDigest = ArticleRelationDigest.ComputeRelation(identified)
        };
    }

    public static ArticleRelationSet Seal(ArticleRelationSet set)
    {
        ArgumentNullException.ThrowIfNull(set);
        ArticleRelationSet unsigned = set with
        {
            SetDigest = string.Empty
        };
        return unsigned with
        {
            SetDigest = ArticleRelationDigest.ComputeSet(unsigned)
        };
    }

    public static ArticleRelationIgnoreDecisionReference Seal(ArticleRelationIgnoreDecisionReference reference)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArticleRelationIgnoreDecisionReference unsigned = reference with
        {
            DecisionDigest = string.Empty
        };
        return unsigned with
        {
            DecisionDigest = ArticleRelationDigest.ComputeIgnoreDecisionReference(unsigned)
        };
    }

    public static ArticleRelationUnlinkedMentionCandidate Seal(ArticleRelationUnlinkedMentionCandidate candidate)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        ArticleRelationUnlinkedMentionCandidate unsigned = candidate with
        {
            CandidateIdentity = string.Empty,
            CandidateDigest = string.Empty
        };
        string identity = ArticleRelationDigest.ComputeCandidateIdentity(unsigned);
        ArticleRelationUnlinkedMentionCandidate identified = unsigned with
        {
            CandidateIdentity = identity
        };
        return identified with
        {
            CandidateDigest = ArticleRelationDigest.ComputeCandidate(identified)
        };
    }

    public static ArticleRelationLifecycleEvent Seal(ArticleRelationLifecycleEvent lifecycleEvent)
    {
        ArgumentNullException.ThrowIfNull(lifecycleEvent);
        ArticleRelationLifecycleEvent unsigned = lifecycleEvent with
        {
            EventIdentity = string.Empty,
            EventDigest = string.Empty
        };
        string identity = ArticleRelationDigest.ComputeLifecycleIdentity(unsigned);
        ArticleRelationLifecycleEvent identified = unsigned with
        {
            EventIdentity = identity
        };
        return identified with
        {
            EventDigest = ArticleRelationDigest.ComputeLifecycle(identified)
        };
    }

    public static ArticleRelationReceipt Seal(ArticleRelationReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        ArticleRelationReceipt unsigned = receipt with
        {
            ReceiptIdentity = string.Empty,
            ReceiptDigest = string.Empty
        };
        string identity = ArticleRelationDigest.ComputeReceipt(unsigned);
        ArticleRelationReceipt identified = unsigned with
        {
            ReceiptIdentity = identity
        };
        return identified with
        {
            ReceiptDigest = ArticleRelationDigest.ComputeReceipt(identified)
        };
    }

    public static ArticleRelationValidationResult ValidateCatalog()
        => ArticleRelationCatalog.Validate();

    public static ArticleRelationValidationResult Validate(ArticleRelationContractCoordinate? coordinate)
    {
        if (coordinate is null
            || coordinate.ContractVersion != ArticleRelationSchemas.Version
            || coordinate.KindCatalogVersion != ArticleRelationSchemas.KindCatalogVersion
            || coordinate.ResolutionCatalogVersion != ArticleRelationSchemas.ResolutionCatalogVersion
            || coordinate.VisibilityCatalogVersion != ArticleRelationSchemas.VisibilityCatalogVersion
            || coordinate.LifecycleCatalogVersion != ArticleRelationSchemas.LifecycleCatalogVersion)
        {
            return Invalid("article_relation_contract_version_unknown");
        }

        return Valid();
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationActorContext? actor)
    {
        if (actor is null
            || !IsContextIdentity(actor.ActorIdentity)
            || !IsContextIdentity(actor.SiteIdentity)
            || !ArticleRelationDigest.IsSha256(actor.PermissionContextDigest))
        {
            return Invalid("article_relation_actor_context_invalid");
        }

        return Valid();
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationSourceFacts? source)
    {
        if (source is null
            || !IsStableArticleIdentity(source.ArticleIdentity)
            || !IsStableRevisionIdentity(source.RevisionIdentity)
            || source.RevisionNumber < 1
            || !Enum.IsDefined(source.RevisionKind)
            || !Enum.IsDefined(source.Lifecycle)
            || !Enum.IsDefined(source.Permission)
            || !Validate(source.SourceActor).IsValid
            || !ArticleRelationDigest.IsSha256(source.ContentDigest))
        {
            return Invalid("article_relation_source_facts_invalid");
        }

        if (source.RevisionKind == ArticleRelationRevisionKind.Draft
            && source.Lifecycle is not ArticleRelationLifecycleState.Draft)
        {
            return Invalid("article_relation_draft_revision_lifecycle_mismatch");
        }

        if (source.RevisionKind == ArticleRelationRevisionKind.Published
            && source.Lifecycle is not ArticleRelationLifecycleState.Published)
        {
            return Invalid("article_relation_published_revision_lifecycle_mismatch");
        }

        return Valid();
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationTargetIdentity? target)
    {
        if (target is null
            || !IsStableArticleIdentity(target.ArticleIdentity)
            || !Enum.IsDefined(target.Kind)
            || !IsOptionalStableIdentity(target.HeadingIdentity, "heading:")
            || !IsOptionalBlockIdentity(target.BlockAnchorIdentity))
        {
            return Invalid("article_relation_target_identity_invalid");
        }

        bool hasHeading = target.HeadingIdentity is not null;
        bool hasBlock = target.BlockAnchorIdentity is not null;
        if (target.Kind == ArticleRelationTargetKind.Article && (hasHeading || hasBlock)
            || target.Kind == ArticleRelationTargetKind.Heading && (!hasHeading || hasBlock)
            || target.Kind == ArticleRelationTargetKind.Block && (!hasBlock || hasHeading))
        {
            return Invalid("article_relation_target_kind_identity_mismatch");
        }

        return Valid();
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationTargetFacts? target)
    {
        if (target is null || !Enum.IsDefined(target.Permission))
        {
            return Invalid("article_relation_target_facts_invalid");
        }

        if (target.TargetIdentity is null)
        {
            return target.RevisionIdentity is null
                && target.RevisionNumber is null
                && target.RevisionKind is null
                && target.Lifecycle is null
                && target.Permission == ArticleRelationPermissionState.Unknown
                ? Valid()
                : Invalid("article_relation_missing_target_carries_facts");
        }

        if (!Validate(target.TargetIdentity).IsValid
            || !IsStableRevisionIdentity(target.RevisionIdentity)
            || target.RevisionNumber is not > 0
            || target.RevisionKind is null
            || !Enum.IsDefined(target.RevisionKind.Value)
            || target.Lifecycle is null
            || !Enum.IsDefined(target.Lifecycle.Value))
        {
            return Invalid("article_relation_target_facts_invalid");
        }

        if (target.RevisionKind == ArticleRelationRevisionKind.Draft
            && target.Lifecycle is not ArticleRelationLifecycleState.Draft)
        {
            return Invalid("article_relation_target_draft_revision_lifecycle_mismatch");
        }

        if (target.RevisionKind == ArticleRelationRevisionKind.Published
            && target.Lifecycle is not ArticleRelationLifecycleState.Published)
        {
            return Invalid("article_relation_target_published_revision_lifecycle_mismatch");
        }

        return Valid();
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationVisibilityFacts? visibility)
    {
        if (visibility is null
            || !Validate(visibility.SourceActor).IsValid
            || !Validate(visibility.QueryActor).IsValid
            || !Enum.IsDefined(visibility.QueryScope)
            || !Enum.IsDefined(visibility.PublicContext)
            || !ArticleRelationDigest.IsSha256(visibility.PermissionPolicyDigest))
        {
            return Invalid("article_relation_visibility_facts_invalid");
        }

        bool contextMatches = visibility.QueryScope switch
        {
            ArticleRelationQueryScope.Authoring =>
                visibility.PublicContext == ArticleRelationPublicContext.AuthoringActor,
            ArticleRelationQueryScope.CurrentPublicPublication =>
                visibility.PublicContext == ArticleRelationPublicContext.AnonymousPublic
                    && visibility.QueryActor.ActorIdentity.StartsWith("public:", StringComparison.Ordinal),
            ArticleRelationQueryScope.PublicationEvidence =>
                visibility.PublicContext == ArticleRelationPublicContext.PublicationBuild
                    && visibility.QueryActor.ActorIdentity.StartsWith("build:", StringComparison.Ordinal),
            _ => false
        };
        return contextMatches
            ? Valid()
            : Invalid("article_relation_query_context_mismatch");
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationSourceRange? range)
    {
        if (range is null
            || range.Start < 0
            || range.End <= range.Start
            || string.IsNullOrWhiteSpace(range.MatchedText)
            || range.MatchedText.Length > 8_192)
        {
            return Invalid("article_relation_source_range_invalid");
        }

        return Valid();
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationOccurrence? occurrence)
    {
        if (occurrence is null
            || occurrence.Count < 1
            || !Validate(occurrence.First).IsValid
            || !Validate(occurrence.Last).IsValid
            || string.IsNullOrWhiteSpace(occurrence.LinkText)
            || occurrence.First.MatchedText != occurrence.LinkText
            || occurrence.Last.MatchedText != occurrence.LinkText
            || occurrence.First.Start > occurrence.Last.Start)
        {
            return Invalid("article_relation_occurrence_invalid");
        }

        return Valid();
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationRecord? record)
    {
        if (record is null
            || record.Schema != ArticleRelationSchemas.Relation
            || record.SchemaVersion != ArticleRelationSchemas.Version
            || !ArticleRelationDigest.IsSha256(record.RelationIdentity)
            || record.IndexVersion < 1
            || !Enum.IsDefined(record.Kind)
            || !Validate(record.Source).IsValid
            || !Validate(record.Occurrence).IsValid
            || !Validate(record.Target).IsValid
            || !Validate(record.Visibility).IsValid
            || !Enum.IsDefined(record.Resolution))
        {
            return Invalid("article_relation_record_invalid");
        }

        ArticleRelationValidationResult coordinateCheck = Validate(record.Coordinate);
        if (!coordinateCheck.IsValid)
        {
            return coordinateCheck;
        }

        if (!ArticleRelationCatalog.TryGet(record.Kind, out ArticleRelationKindDefinition? definition)
            || definition is null)
        {
            return Invalid("article_relation_kind_orphan");
        }

        ArticleRelationEligibility requiredEligibility = EligibilityFor(record.Visibility.QueryScope);
        if ((definition.Eligibility & requiredEligibility) == 0)
        {
            return Invalid("article_relation_kind_query_not_eligible");
        }

        if (definition.RequiresStableTarget && record.Target.TargetIdentity is null)
        {
            return Invalid("article_relation_kind_target_required");
        }

        if (record.Kind == ArticleRelationKind.UnlinkedMention)
        {
            return Invalid("article_relation_unlinked_requires_candidate");
        }

        ArticleRelationValidationResult status = ValidateStatus(record);
        if (!status.IsValid)
        {
            return status;
        }

        if (record.Visibility.SourceActor != record.Source.SourceActor)
        {
            return Invalid("article_relation_source_actor_binding_mismatch");
        }

        if (record.Visibility.QueryScope == ArticleRelationQueryScope.CurrentPublicPublication)
        {
            ArticleRelationValidationResult publicCheck = ValidatePublicRecord(record);
            if (!publicCheck.IsValid)
            {
                return publicCheck;
            }
        }

        string expectedIdentity = ArticleRelationDigest.ComputeRelationIdentity(record);
        if (!DigestEquals(record.RelationIdentity, expectedIdentity))
        {
            return Invalid("article_relation_identity_digest_mismatch");
        }

        return DigestEquals(record.RecordDigest, ArticleRelationDigest.ComputeRelation(record))
            ? Valid()
            : Invalid("article_relation_record_digest_mismatch");
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationSet? set)
    {
        if (set is null
            || set.Schema != ArticleRelationSchemas.RelationSet
            || set.SchemaVersion != ArticleRelationSchemas.Version
            || !Validate(set.Source).IsValid
            || set.Relations is null
            || set.Relations.Count > MaxRelationsPerSet)
        {
            return Invalid("article_relation_set_invalid");
        }

        var identities = new HashSet<string>(StringComparer.Ordinal);
        foreach (ArticleRelationRecord relation in set.Relations)
        {
            ArticleRelationValidationResult relationCheck = Validate(relation);
            if (!relationCheck.IsValid)
            {
                return relationCheck;
            }

            if (relation.Source != set.Source || !identities.Add(relation.RelationIdentity))
            {
                return Invalid("article_relation_duplicate_or_orphan_record");
            }
        }

        return DigestEquals(set.SetDigest, ArticleRelationDigest.ComputeSet(set))
            ? Valid()
            : Invalid("article_relation_set_digest_mismatch");
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationIgnoreDecisionReference? reference)
    {
        if (reference is null
            || reference.Schema != ArticleRelationSchemas.IgnoreDecisionReference
            || reference.SchemaVersion != ArticleRelationSchemas.Version
            || !ArticleRelationDigest.IsSha256(reference.DecisionIdentity)
            || reference.DecisionRevision < 1)
        {
            return Invalid("article_relation_ignore_reference_invalid");
        }

        return DigestEquals(
            reference.DecisionDigest,
            ArticleRelationDigest.ComputeIgnoreDecisionReference(reference))
            ? Valid()
            : Invalid("article_relation_ignore_reference_digest_mismatch");
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationUnlinkedMentionCandidate? candidate)
    {
        if (candidate is null
            || candidate.Schema != ArticleRelationSchemas.MentionCandidate
            || candidate.SchemaVersion != ArticleRelationSchemas.Version
            || !ArticleRelationDigest.IsSha256(candidate.CandidateIdentity)
            || !Validate(candidate.Source).IsValid
            || !Validate(candidate.Visibility).IsValid
            || !Validate(candidate.MatchedRange).IsValid
            || candidate.CandidateTargets is null
            || candidate.CandidateTargets.Count is < 1 or > MaxCandidatesPerSource
            || !Enum.IsDefined(candidate.MatchRule)
            || !Enum.IsDefined(candidate.MatchReason)
            || !Enum.IsDefined(candidate.Confidence)
            || !Enum.IsDefined(candidate.Ambiguity)
            || candidate.IsAuthoritative)
        {
            return Invalid("article_relation_mention_candidate_invalid");
        }

        ArticleRelationValidationResult candidateCoordinateCheck = Validate(candidate.Coordinate);
        if (!candidateCoordinateCheck.IsValid)
        {
            return candidateCoordinateCheck;
        }

        var targetIdentities = new HashSet<string>(StringComparer.Ordinal);
        foreach (ArticleRelationTargetIdentity target in candidate.CandidateTargets)
        {
            if (!Validate(target).IsValid || !targetIdentities.Add(TargetKey(target)))
            {
                return Invalid("article_relation_mention_candidate_target_invalid");
            }
        }

        if (candidate.Ambiguity == ArticleRelationMentionAmbiguity.Unique
            && candidate.CandidateTargets.Count != 1
            || candidate.Ambiguity == ArticleRelationMentionAmbiguity.Ambiguous
                && candidate.CandidateTargets.Count < 2)
        {
            return Invalid("article_relation_mention_ambiguity_mismatch");
        }

        if (candidate.MatchRule == ArticleRelationMentionMatchRule.ExactTitle
            && candidate.MatchReason != ArticleRelationMentionMatchReason.ExactText
            || candidate.MatchRule == ArticleRelationMentionMatchRule.ExactAlias
                && candidate.MatchReason != ArticleRelationMentionMatchReason.RegisteredAlias
            || candidate.MatchRule == ArticleRelationMentionMatchRule.UnicodeNormalizedAlias
                && candidate.MatchReason != ArticleRelationMentionMatchReason.CaseOrUnicodeNormalization)
        {
            return Invalid("article_relation_mention_match_mismatch");
        }

        if (candidate.IgnoreDecision is not null
            && !Validate(candidate.IgnoreDecision).IsValid)
        {
            return Invalid("article_relation_mention_ignore_reference_invalid");
        }

        if (candidate.Visibility.QueryScope != ArticleRelationQueryScope.Authoring)
        {
            return Invalid("article_relation_mention_public_scope_forbidden");
        }

        if (candidate.Visibility.SourceActor != candidate.Source.SourceActor)
        {
            return Invalid("article_relation_source_actor_binding_mismatch");
        }

        string expectedIdentity = ArticleRelationDigest.ComputeCandidateIdentity(candidate);
        if (!DigestEquals(candidate.CandidateIdentity, expectedIdentity))
        {
            return Invalid("article_relation_mention_identity_digest_mismatch");
        }

        return DigestEquals(candidate.CandidateDigest, ArticleRelationDigest.ComputeCandidate(candidate))
            ? Valid()
            : Invalid("article_relation_mention_digest_mismatch");
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationLifecycleEvent? lifecycleEvent)
    {
        const ArticleRelationLifecycleChanges allowedChanges = ArticleRelationLifecycleChanges.Slug
            | ArticleRelationLifecycleChanges.Title
            | ArticleRelationLifecycleChanges.HeadingIdentity;
        if (lifecycleEvent is null
            || lifecycleEvent.Schema != ArticleRelationSchemas.LifecycleEvent
            || lifecycleEvent.SchemaVersion != ArticleRelationSchemas.Version
            || !ArticleRelationDigest.IsSha256(lifecycleEvent.EventIdentity)
            || !Enum.IsDefined(lifecycleEvent.Kind)
            || !Enum.IsDefined(lifecycleEvent.Owner)
            || (lifecycleEvent.Changes & ~allowedChanges) != ArticleRelationLifecycleChanges.None
            || !IsStableArticleIdentity(lifecycleEvent.ArticleIdentity)
            || !IsStableRevisionIdentity(lifecycleEvent.RevisionIdentity)
            || lifecycleEvent.EventRevision < 1)
        {
            return Invalid("article_relation_lifecycle_event_invalid");
        }

        ArticleRelationValidationResult lifecycleCoordinateCheck = Validate(lifecycleEvent.Coordinate);
        if (!lifecycleCoordinateCheck.IsValid)
        {
            return lifecycleCoordinateCheck;
        }

        ArticleRelationLifecycleObligations expectedObligations = ExpectedObligations(
            lifecycleEvent.Kind,
            lifecycleEvent.Changes);
        ArticleRelationLifecycleOwner expectedOwner = ExpectedOwner(lifecycleEvent.Kind);
        if (lifecycleEvent.Owner != expectedOwner)
        {
            return Invalid("article_relation_lifecycle_owner_mismatch");
        }

        if (lifecycleEvent.Obligations != expectedObligations
            || (lifecycleEvent.Kind == ArticleRelationLifecycleEventKind.SlugTitleHeadingRename
                && lifecycleEvent.Changes == ArticleRelationLifecycleChanges.None)
            || (lifecycleEvent.Kind != ArticleRelationLifecycleEventKind.SlugTitleHeadingRename
                && lifecycleEvent.Changes != ArticleRelationLifecycleChanges.None))
        {
            return Invalid("article_relation_lifecycle_obligations_invalid");
        }

        string expectedIdentity = ArticleRelationDigest.ComputeLifecycleIdentity(lifecycleEvent);
        if (!DigestEquals(lifecycleEvent.EventIdentity, expectedIdentity))
        {
            return Invalid("article_relation_lifecycle_identity_digest_mismatch");
        }

        return DigestEquals(lifecycleEvent.EventDigest, ArticleRelationDigest.ComputeLifecycle(lifecycleEvent))
            ? Valid()
            : Invalid("article_relation_lifecycle_digest_mismatch");
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationReceiptContext? context)
    {
        if (context is null
            || !IsStableArticleIdentity(context.SourceArticleIdentity)
            || !IsStableRevisionIdentity(context.SourceRevisionIdentity)
            || context.SourceRevisionNumber < 1
            || !Enum.IsDefined(context.SourceRevisionKind)
            || !Validate(context.SourceActor).IsValid
            || !Validate(context.QueryActor).IsValid
            || !Enum.IsDefined(context.QueryScope)
            || !IsIdentifier(context.WorktreeIdentity, 1, 160)
            || !IsIdentifier(context.BuildIdentity, 1, 160)
            || !IsIdentifier(context.ParserContract, 1, 200)
            || !IsIdentifier(context.RendererContract, 1, 200)
            || context.ArticleSchemaVersion < 1
            || context.PermissionPolicyVersion < 1
            || !ArticleRelationDigest.IsSha256(context.ContentDigest))
        {
            return Invalid("article_relation_receipt_context_invalid");
        }

        ArticleRelationValidationResult receiptCoordinateCheck = Validate(context.Coordinate);
        if (!receiptCoordinateCheck.IsValid)
        {
            return receiptCoordinateCheck;
        }

        if (context.QueryScope == ArticleRelationQueryScope.CurrentPublicPublication
            && context.SourceRevisionKind != ArticleRelationRevisionKind.Current)
        {
            return Invalid("article_relation_public_revision_scope_mismatch");
        }

        return Valid();
    }

    public static ArticleRelationValidationResult Validate(ArticleRelationReceipt? receipt)
    {
        if (receipt is null
            || receipt.Schema != ArticleRelationSchemas.Receipt
            || receipt.SchemaVersion != ArticleRelationSchemas.Version
            || !ArticleRelationDigest.IsSha256(receipt.ReceiptIdentity)
            || !Enum.IsDefined(receipt.Kind)
            || receipt.RelationDigests is null
            || receipt.CandidateDigests is null
            || receipt.RelationCount < 0
            || receipt.CandidateCount < 0
            || receipt.RelationCount != receipt.RelationDigests.Count
            || receipt.CandidateCount != receipt.CandidateDigests.Count
            || receipt.RelationDigests.Count > MaxRelationsPerSet
            || receipt.CandidateDigests.Count > MaxCandidatesPerSource)
        {
            return Invalid("article_relation_receipt_invalid");
        }

        ArticleRelationValidationResult receiptContextCheck = Validate(receipt.Context);
        if (!receiptContextCheck.IsValid)
        {
            return receiptContextCheck;
        }

        if (!ValidateReceiptScope(receipt.Kind, receipt.Context.QueryScope))
        {
            return Invalid("article_relation_receipt_scope_invalid");
        }

        var seenRelations = new HashSet<string>(StringComparer.Ordinal);
        foreach (string digest in receipt.RelationDigests)
        {
            if (!ArticleRelationDigest.IsSha256(digest) || !seenRelations.Add(digest))
            {
                return Invalid("article_relation_receipt_relation_digest_invalid");
            }
        }

        var seenCandidates = new HashSet<string>(StringComparer.Ordinal);
        foreach (string digest in receipt.CandidateDigests)
        {
            if (!ArticleRelationDigest.IsSha256(digest) || !seenCandidates.Add(digest))
            {
                return Invalid("article_relation_receipt_candidate_digest_invalid");
            }
        }

        return DigestEquals(receipt.ReceiptDigest, ArticleRelationDigest.ComputeReceipt(receipt))
            ? Valid()
            : Invalid("article_relation_receipt_digest_mismatch");
    }

    private static ArticleRelationValidationResult ValidateStatus(ArticleRelationRecord record)
    {
        ArticleRelationTargetFacts target = record.Target;
        return record.Resolution switch
        {
            ArticleRelationResolutionStatus.Resolved => target.TargetIdentity is not null
                && target.RevisionIdentity is not null
                && target.RevisionNumber is > 0
                && target.RevisionKind is not null
                && target.Lifecycle is not null
                && target.Permission == ArticleRelationPermissionState.Allowed
                    ? Valid()
                    : Invalid("article_relation_resolved_target_incomplete"),
            ArticleRelationResolutionStatus.MissingTarget
                or ArticleRelationResolutionStatus.Ambiguous
                or ArticleRelationResolutionStatus.Unsupported => target.TargetIdentity is null
                    ? Valid()
                    : Invalid("article_relation_missing_target_binding_invalid"),
            ArticleRelationResolutionStatus.MissingAnchor => target.TargetIdentity is not null
                && target.TargetIdentity.Kind is ArticleRelationTargetKind.Heading or ArticleRelationTargetKind.Block
                && target.TargetIdentity.HeadingIdentity is not null
                    || target.TargetIdentity is not null
                        && target.TargetIdentity.BlockAnchorIdentity is not null
                ? Valid()
                : Invalid("article_relation_missing_anchor_binding_invalid"),
            ArticleRelationResolutionStatus.Deleted => target.Lifecycle == ArticleRelationLifecycleState.Deleted
                ? Valid()
                : Invalid("article_relation_deleted_status_mismatch"),
            ArticleRelationResolutionStatus.Archived => target.Lifecycle == ArticleRelationLifecycleState.Archived
                ? Valid()
                : Invalid("article_relation_archived_status_mismatch"),
            ArticleRelationResolutionStatus.Draft => target.Lifecycle == ArticleRelationLifecycleState.Draft
                ? Valid()
                : Invalid("article_relation_draft_status_mismatch"),
            ArticleRelationResolutionStatus.Unauthorized => target.Permission == ArticleRelationPermissionState.Denied
                ? Valid()
                : Invalid("article_relation_unauthorized_status_mismatch"),
            ArticleRelationResolutionStatus.Private => target.TargetIdentity is not null
                && target.Permission != ArticleRelationPermissionState.Allowed
                    || target.TargetIdentity is not null
                        && target.Lifecycle is not ArticleRelationLifecycleState.Published
                    ? Valid()
                    : Invalid("article_relation_private_status_mismatch"),
            ArticleRelationResolutionStatus.Stale => Valid(),
            _ => Invalid("article_relation_resolution_status_unknown")
        };
    }

    private static ArticleRelationValidationResult ValidatePublicRecord(ArticleRelationRecord record)
    {
        if (record.Source.RevisionKind != ArticleRelationRevisionKind.Current
            || record.Source.Lifecycle != ArticleRelationLifecycleState.Published
            || record.Source.Permission != ArticleRelationPermissionState.Allowed
            || !record.Visibility.QueryActor.ActorIdentity.StartsWith("public:", StringComparison.Ordinal)
            || record.Target.TargetIdentity is null
            || record.Target.RevisionKind != ArticleRelationRevisionKind.Published
            || record.Target.Lifecycle != ArticleRelationLifecycleState.Published
            || record.Target.Permission != ArticleRelationPermissionState.Allowed)
        {
            return Invalid("article_relation_public_draft_or_private_mix");
        }

        return Valid();
    }

    private static ArticleRelationLifecycleOwner ExpectedOwner(ArticleRelationLifecycleEventKind kind)
        => kind switch
        {
            ArticleRelationLifecycleEventKind.Create
                or ArticleRelationLifecycleEventKind.Edit
                or ArticleRelationLifecycleEventKind.Rollback =>
                ArticleRelationLifecycleOwner.SourceRevisionAuthority,
            ArticleRelationLifecycleEventKind.Publish
                or ArticleRelationLifecycleEventKind.Schedule
                or ArticleRelationLifecycleEventKind.Archive
                or ArticleRelationLifecycleEventKind.Delete
                or ArticleRelationLifecycleEventKind.Restore =>
                ArticleRelationLifecycleOwner.PublicationLifecycleAuthority,
            ArticleRelationLifecycleEventKind.SlugTitleHeadingRename =>
                ArticleRelationLifecycleOwner.ArticleIdentityAuthority,
            ArticleRelationLifecycleEventKind.Import
                or ArticleRelationLifecycleEventKind.Migration =>
                ArticleRelationLifecycleOwner.ImportMigrationAuthority,
            _ => throw new ArgumentOutOfRangeException(nameof(kind))
        };

    private static ArticleRelationLifecycleObligations ExpectedObligations(
        ArticleRelationLifecycleEventKind kind,
        ArticleRelationLifecycleChanges changes)
        => kind switch
        {
            ArticleRelationLifecycleEventKind.Create =>
                ArticleRelationLifecycleObligations.Rebuild | ArticleRelationLifecycleObligations.Reresolve,
            ArticleRelationLifecycleEventKind.Edit =>
                ArticleRelationLifecycleObligations.Rebuild
                | ArticleRelationLifecycleObligations.Invalidate
                | ArticleRelationLifecycleObligations.Reresolve,
            ArticleRelationLifecycleEventKind.Publish
                or ArticleRelationLifecycleEventKind.Schedule
                or ArticleRelationLifecycleEventKind.Archive
                or ArticleRelationLifecycleEventKind.Delete
                or ArticleRelationLifecycleEventKind.Restore =>
                ArticleRelationLifecycleObligations.Invalidate | ArticleRelationLifecycleObligations.Reresolve,
            ArticleRelationLifecycleEventKind.Rollback
                or ArticleRelationLifecycleEventKind.Import
                or ArticleRelationLifecycleEventKind.Migration =>
                ArticleRelationLifecycleObligations.Rebuild
                | ArticleRelationLifecycleObligations.Invalidate
                | ArticleRelationLifecycleObligations.Reresolve,
            ArticleRelationLifecycleEventKind.SlugTitleHeadingRename =>
                changes.HasFlag(ArticleRelationLifecycleChanges.HeadingIdentity)
                    ? ArticleRelationLifecycleObligations.Rebuild
                        | ArticleRelationLifecycleObligations.Invalidate
                        | ArticleRelationLifecycleObligations.Reresolve
                    : ArticleRelationLifecycleObligations.Invalidate,
            _ => ArticleRelationLifecycleObligations.None
        };

    private static bool ValidateReceiptScope(ArticleRelationReceiptKind kind, ArticleRelationQueryScope scope)
        => kind switch
        {
            ArticleRelationReceiptKind.Index => scope is ArticleRelationQueryScope.Authoring
                or ArticleRelationQueryScope.PublicationEvidence,
            ArticleRelationReceiptKind.Query => scope is ArticleRelationQueryScope.Authoring
                or ArticleRelationQueryScope.CurrentPublicPublication,
            ArticleRelationReceiptKind.IgnoreDecision => scope == ArticleRelationQueryScope.Authoring,
            ArticleRelationReceiptKind.Prepublish => scope == ArticleRelationQueryScope.PublicationEvidence,
            ArticleRelationReceiptKind.Inspector => scope == ArticleRelationQueryScope.Authoring,
            _ => false
        };

    private static ArticleRelationEligibility EligibilityFor(ArticleRelationQueryScope scope)
        => scope switch
        {
            ArticleRelationQueryScope.Authoring => ArticleRelationEligibility.AuthoringQuery,
            ArticleRelationQueryScope.CurrentPublicPublication => ArticleRelationEligibility.PublicQuery,
            ArticleRelationQueryScope.PublicationEvidence => ArticleRelationEligibility.PublicationEvidence,
            _ => ArticleRelationEligibility.None
        };

    private static bool IsStableArticleIdentity(string? value)
        => IsStableIdentifier(value, "article:");

    private static bool IsStableRevisionIdentity(string? value)
        => IsStableIdentifier(value, "revision:");

    private static bool IsOptionalStableIdentity(string? value, string prefix)
        => value is null || IsStableIdentifier(value, prefix);

    private static bool IsOptionalBlockIdentity(string? value)
        => value is null
            || IsStableIdentifier(value, "block:")
            || IsStableIdentifier(value, "anchor:");

    private static bool IsStableIdentifier(string? value, string prefix)
    {
        if (!IsIdentifier(value, prefix.Length + 1, 160)
            || !value!.StartsWith(prefix, StringComparison.Ordinal))
        {
            return false;
        }

        string suffix = value[prefix.Length..];
        return suffix.Length > 0
            && !suffix.Contains("http", StringComparison.OrdinalIgnoreCase)
            && !suffix.Contains("title", StringComparison.OrdinalIgnoreCase)
            && !suffix.Contains("slug", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsContextIdentity(string? value)
        => IsIdentifier(value, 3, 160)
            && value!.Contains(':', StringComparison.Ordinal)
            && !value.Contains("http", StringComparison.OrdinalIgnoreCase);

    private static bool IsIdentifier(string? value, int minimumLength, int maximumLength)
    {
        if (value is null || value.Length < minimumLength || value.Length > maximumLength)
        {
            return false;
        }

        foreach (char character in value)
        {
            if (char.IsWhiteSpace(character)
                || char.IsControl(character)
                || character is '/' or '\\' or '?' or '=' or '#')
            {
                return false;
            }
        }

        return true;
    }

    private static string TargetKey(ArticleRelationTargetIdentity target)
        => string.Join('|', target.ArticleIdentity, (byte)target.Kind, target.HeadingIdentity, target.BlockAnchorIdentity);

    private static bool DigestEquals(string? supplied, string expected)
    {
        if (!ArticleRelationDigest.IsSha256(supplied))
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(
            Convert.FromHexString(supplied!),
            Convert.FromHexString(expected));
    }

    private static ArticleRelationValidationResult Valid()
        => ArticleRelationValidationResult.Valid();

    private static ArticleRelationValidationResult Invalid(string reasonCode)
        => ArticleRelationValidationResult.Invalid(reasonCode);
}
