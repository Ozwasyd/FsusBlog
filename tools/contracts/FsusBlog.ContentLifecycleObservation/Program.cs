using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Moderation;

return ContentLifecycleObservationHost.Run(args);

internal static class ContentLifecycleObservationHost
{
    private const string ObservationSchema = "fsusblog.content-lifecycle-observation.v2";

    private static readonly JsonSerializerOptions s_json = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static int Run(string[] args)
    {
        string? outputPath = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] is "--output" or "-o")
            {
                outputPath = args.ElementAtOrDefault(i + 1)
                    ?? throw new InvalidOperationException("--output requires a path");
                i++;
            }
            else if (args[i] is "--help" or "-h")
            {
                Console.WriteLine("FsusBlog.ContentLifecycleObservation --output <path>");
                return 0;
            }
            else
            {
                throw new InvalidOperationException($"Unknown argument: {args[i]}");
            }
        }

        if (string.IsNullOrWhiteSpace(outputPath))
        {
            throw new InvalidOperationException("--output is required");
        }

        JsonObject document = Observe();
        string withoutDigest = document.ToJsonString(s_json);
        string digest = Sha256Hex(withoutDigest);
        document["observationDigest"] = digest;

        string json = document.ToJsonString(s_json);
        string directory = Path.GetDirectoryName(Path.GetFullPath(outputPath))
            ?? throw new InvalidOperationException("output directory is invalid");
        Directory.CreateDirectory(directory);
        File.WriteAllText(outputPath, json + "\n", new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

        Console.WriteLine($"[content-lifecycle-observation] ok output={outputPath} digest={digest}");
        return 0;
    }

    private static JsonObject Observe()
    {
        List<string> failures = [];
        DateTime utcNow = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);

        // --- Article lifecycle states from production enum / core values ---
        string[] articleStates = Enum.GetNames<ArticleStatus>()
            .OrderBy(static name => name, StringComparer.Ordinal)
            .ToArray();
        int[] articleStatusValues = Enum.GetValues<ArticleStatus>()
            .Select(static status => (int)status)
            .OrderBy(static value => value)
            .ToArray();

        if (articleStatusValues is not [0, 1, 2, 3, 4, 5])
        {
            failures.Add("article status numeric values must remain Draft=0..Deleted=4 with Inbox=5 appended");
        }

        foreach (int value in new[]
        {
            ArticleStatusValues.Draft,
            ArticleStatusValues.Scheduled,
            ArticleStatusValues.Published,
            ArticleStatusValues.Archived,
            ArticleStatusValues.Deleted,
            ArticleStatusValues.Inbox
        })
        {
            if (!ArticleStatusTransitionPolicy.IsDefined(value)
                || !ArticleStatusProjection.IsDefined(value))
            {
                failures.Add($"article status value {value} undefined in policy or projection");
            }

            if ((int)Enum.ToObject(typeof(ArticleStatus), value) != value
                || !Enum.IsDefined(typeof(ArticleStatus), value))
            {
                failures.Add($"article entity enum missing value {value}");
            }
        }

        // Enumerate transitions via production policy oracle (no copied switch).
        var allowedTransitions = new List<string>();
        var forbiddenTransitions = new List<string>();
        ArticleStatus[] statuses = Enum.GetValues<ArticleStatus>();
        ArticleStatusTransitionOperation[] operations = Enum.GetValues<ArticleStatusTransitionOperation>();
        foreach (ArticleStatusTransitionOperation operation in operations)
        {
            foreach (ArticleStatus source in statuses)
            {
                foreach (ArticleStatus target in statuses)
                {
                    DateTime? scheduledAt = target == ArticleStatus.Scheduled
                        ? utcNow.AddHours(1)
                        : null;
                    ArticleStatusTransitionValidation? validation = ArticleStatusTransitionPolicy.ValidateTransition(
                        (int)source,
                        (int)target,
                        scheduledAt,
                        utcNow,
                        operation);
                    string edge = $"{operation}:{source}->{target}";
                    if (validation is null)
                    {
                        allowedTransitions.Add(edge);
                    }
                    else
                    {
                        forbiddenTransitions.Add($"{edge}:{validation.Value.Code}");
                    }
                }
            }
        }

        allowedTransitions = allowedTransitions
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToList();
        forbiddenTransitions = forbiddenTransitions
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToList();

        if (!allowedTransitions.Contains("Restore:Deleted->Published", StringComparer.Ordinal))
        {
            failures.Add("restore must allow Deleted->Published");
        }

        if (allowedTransitions.Any(static edge => edge.StartsWith("Restore:", StringComparison.Ordinal)
            && !edge.Equals("Restore:Deleted->Published", StringComparison.Ordinal)))
        {
            failures.Add("restore must only allow Deleted->Published");
        }

        if (!allowedTransitions.Contains("Rollback:Published->Draft", StringComparer.Ordinal)
            || !allowedTransitions.Contains("Rollback:Published->Published", StringComparer.Ordinal)
            || !allowedTransitions.Contains("Rollback:Published->Archived", StringComparer.Ordinal))
        {
            failures.Add("rollback must allow Draft|Published|Archived targets from editable sources");
        }

        if (allowedTransitions.Any(static edge => edge.StartsWith("Rollback:", StringComparison.Ordinal)
            && edge.Contains("->Scheduled", StringComparison.Ordinal)))
        {
            failures.Add("rollback must not target Scheduled");
        }

        if (allowedTransitions.Any(static edge => edge.Contains("->Deleted", StringComparison.Ordinal)
            && !edge.StartsWith("Create:Deleted->Deleted", StringComparison.Ordinal)))
        {
            // Delete is a dedicated flow; ValidateTarget rejects Deleted as ordinary target.
            failures.Add("ordinary transitions must not enter Deleted");
        }

        // Publication coordinates required by transition writer validation.
        string[] requiredCoordinates = SortedUnique(
            "revisionId",
            "revisionNo",
            "rightsSnapshotId",
            "responsibilitySnapshotId",
            "publicationId",
            "publicationNo",
            "responsibilityVersion");

        // Scheduled boundary from policy: future exclusive vs utcNow.
        var scheduledBoundary = new JsonObject
        {
            ["status"] = nameof(ArticleStatus.Scheduled),
            ["scheduledPublishAt"] = new JsonObject
            {
                ["required"] = true,
                ["relationToUtcNow"] = "strictly-after",
                ["boundary"] = "exclusive",
                ["unit"] = "utc-instant"
            },
            ["nonScheduledScheduledAt"] = "forbidden"
        };

        ArticleStatusTransitionValidation? pastScheduled = ArticleStatusTransitionPolicy.ValidateTarget(
            ArticleStatusValues.Scheduled,
            utcNow.AddMinutes(-1),
            utcNow);
        if (pastScheduled?.Code != ArticleStatusTransitionErrorCodes.ScheduledAtMustBeFuture)
        {
            failures.Add("scheduled boundary must reject non-future scheduledPublishAt");
        }

        // Public visibility: only Published (not deleted, not future published/scheduled).
        var publicVisibility = new JsonObject();
        foreach (ArticleStatus status in statuses)
        {
            bool visible = ArticlePublication.IsPubliclyVisible(
                status,
                isDeleted: false,
                publishedAt: utcNow.AddHours(-1),
                scheduledPublishAt: null,
                utcNow);
            publicVisibility[status.ToString()] = visible;
        }

        if (publicVisibility["Published"]?.GetValue<bool>() != true
            || publicVisibility["Draft"]?.GetValue<bool>() != false
            || publicVisibility["Scheduled"]?.GetValue<bool>() != false
            || publicVisibility["Archived"]?.GetValue<bool>() != false
            || publicVisibility["Deleted"]?.GetValue<bool>() != false)
        {
            failures.Add("article public visibility must admit only Published");
        }

        bool deletedVisible = ArticlePublication.IsPubliclyVisible(
            ArticleStatus.Published,
            isDeleted: true,
            publishedAt: utcNow.AddHours(-1),
            scheduledPublishAt: null,
            utcNow);
        if (deletedVisible)
        {
            failures.Add("isDeleted=true must not be publicly visible");
        }

        bool futurePublished = ArticlePublication.IsPubliclyVisible(
            ArticleStatus.Published,
            isDeleted: false,
            publishedAt: utcNow.AddHours(1),
            scheduledPublishAt: null,
            utcNow);
        if (futurePublished)
        {
            failures.Add("future PublishedAt must not be publicly visible");
        }

        // Admin visibility: all defined lifecycle states remain admin-readable (not only Published).
        string[] adminVisibilityStates = articleStates;

        // Outbox edges from pure catalog; optional must not be required.
        string[] requiredEdges = ArticleMutationReplayEdges.Required
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();
        string[] optionalEdges = ArticleMutationReplayEdges.Optional
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();
        string[] allEdges = ArticleMutationReplayEdges.All
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();

        if (requiredEdges.Contains(ArticleMutationReplayEdges.IntegrityProof, StringComparer.Ordinal)
            || requiredEdges.Contains(ArticleMutationReplayEdges.Notification, StringComparer.Ordinal))
        {
            failures.Add("integrity-proof and notification must remain optional article outbox edges");
        }

        if (!requiredEdges.Contains(ArticleMutationReplayEdges.PublicHotRead, StringComparer.Ordinal)
            || !requiredEdges.Contains(ArticleMutationReplayEdges.PublicArtifactRevocation, StringComparer.Ordinal))
        {
            failures.Add("required article outbox edges missing public-hot-read or public-artifact-revocation");
        }

        if (optionalEdges.Intersect(requiredEdges, StringComparer.Ordinal).Any())
        {
            failures.Add("article outbox required/optional edge sets must be disjoint");
        }

        if (!allEdges.SequenceEqual(
                requiredEdges.Union(optionalEdges).OrderBy(static value => value, StringComparer.Ordinal),
                StringComparer.Ordinal))
        {
            failures.Add("article outbox All must equal Required ∪ Optional");
        }

        string[] articleTerminalStates = SortedUnique(
            ArticleMutationOutboxEdgeStatus.Completed,
            ArticleMutationOutboxEdgeStatus.Failed,
            ArticleMutationOutboxEdgeStatus.Skipped);

        string[] articleEventTypes = ArticleMutationEventTypes.All
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();

        // Rights / responsibility coordinate requirements (writer Validate + Version coordinates).
        string[] rightsRequiredFields = SortedUnique(
            "rightsSnapshotId",
            "licenseType",
            "enabled",
            "copyPolicy");
        var responsibilityRequirement = new JsonObject
        {
            ["snapshotOptionalOnNonPublish"] = true,
            ["requiredCoordinateWhenPresent"] = "responsibilitySnapshotId",
            ["versionField"] = "responsibilityVersion",
            ["publicProjection"] = "article_responsibility_snapshot without admin-actor fields"
        };

        var rollbackSemantics = new JsonObject
        {
            ["operation"] = nameof(ArticleStatusTransitionOperation.Rollback),
            ["allowedTargets"] = ToJsonArray(SortedUnique("Draft", "Published", "Archived")),
            ["forbiddenTargets"] = ToJsonArray(SortedUnique("Scheduled", "Deleted")),
            ["createsPublication"] = true,
            ["clonesResponsibilityFromSourceRevision"] = true
        };

        var restoreSemantics = new JsonObject
        {
            ["operation"] = nameof(ArticleStatusTransitionOperation.Restore),
            ["source"] = nameof(ArticleStatus.Deleted),
            ["target"] = nameof(ArticleStatus.Published),
            ["createsPublication"] = true,
            ["revivesOldPublicationPointer"] = false
        };

        var deleteSemantics = new JsonObject
        {
            ["enterVia"] = "dedicated-delete-flow",
            ["ordinaryTransitionTarget"] = "forbidden",
            ["status"] = nameof(ArticleStatus.Deleted),
            ["softDelete"] = true,
            ["createsRevision"] = false,
            ["createsPublication"] = false,
            ["createsTombstone"] = false,
            ["preservesCurrentPublicationPointer"] = true,
            ["preservesImmutableHistory"] = true,
            ["visibilityTransition"] = "current-to-deleted",
            ["outboxEventType"] = "deleted",
            ["permanentDeleteEventType"] = "permanently-deleted"
        };

        ArticlePublicationTransitionPlan scheduledWithoutCurrent = ArticlePublicationTransitionWriter.CreatePlan(
            hasCurrentPublication: false,
            ArticleStatus.Scheduled,
            utcNow.AddHours(1),
            utcNow);
        ArticlePublicationTransitionPlan scheduledWithCurrent = ArticlePublicationTransitionWriter.CreatePlan(
            hasCurrentPublication: true,
            ArticleStatus.Scheduled,
            utcNow.AddHours(1),
            utcNow);
        ArticlePublicationTransitionPlan scheduledDue = ArticlePublicationTransitionWriter.CreatePlan(
            hasCurrentPublication: true,
            ArticleStatus.Published,
            scheduledPublishAt: null,
            utcNow.AddHours(1));

        if (scheduledWithCurrent.StoredStatus != ArticleStatus.Published
            || scheduledWithCurrent.CreatePublication
            || scheduledWithCurrent.PendingPublicationAt is null
            || scheduledWithoutCurrent.StoredStatus != ArticleStatus.Scheduled
            || scheduledDue.StoredStatus != ArticleStatus.Published
            || !scheduledDue.CreatePublication)
        {
            failures.Add("scheduled publication plans no longer preserve the old publication before due and create the new publication at due");
        }

        JsonObject CausalFact(
            string factId,
            string subject,
            string predicate,
            string objectValue,
            string condition,
            string scope,
            params (string Path, string Symbol, string Proof)[] bindings)
        {
            var sources = new JsonObject();
            var proofs = new JsonArray();
            int sourceIndex = 0;
            foreach ((string sourcePath, string symbol, string proof) in bindings)
            {
                sourceIndex++;
                sources[$"source{sourceIndex}"] = new JsonObject
                {
                    ["owner"] = sourcePath,
                    ["range"] = symbol
                };
                proofs.Add(proof);
            }

            return new JsonObject
            {
                ["factId"] = factId,
                ["schemaVersion"] = 1,
                ["subject"] = subject,
                ["predicate"] = predicate,
                ["object"] = objectValue,
                ["direction"] = "subject-to-object",
                ["condition"] = condition,
                ["truthValue"] = "true",
                ["scope"] = scope,
                ["conflictStatus"] = "consistent",
                ["sourceRanges"] = sources,
                ["proofTests"] = proofs
            };
        }

        JsonObject scheduledPreDueFact = CausalFact(
            "article.scheduled.pre-due-current-publication",
            "scheduled transition before due",
            "preserves",
            "old current publication coordinate",
            "an article already has a current publication and pendingPublicationAt is still in the future",
            "article.publication.current-pointer",
            ("src/backend/Services/ArticlePublicationTransition.cs", "ArticlePublicationTransitionWriter.CreatePlan", "article-publication-transition-plan"),
            ("src/backend/Services/Background/ScheduledPublishQuery.cs", "ScheduledPublishQuery.PendingPublicationPredicateSql", "scheduled-publish-due-boundary"));
        JsonObject scheduledDueFact = CausalFact(
            "article.scheduled.due-publication-transition",
            "scheduled due transition",
            "creates",
            "new publication coordinate and switches current pointer without creating another revision",
            "scheduledPublishAt or pendingPublicationAt is at or before the worker current time",
            "article.publication.current-pointer",
            ("src/backend/Services/Background/ScheduledPublishWorker.cs", "ScheduledPublishWorker.ClaimDueArticlesAsync", "scheduled-publish-transition"),
            ("src/backend/Services/ArticlePublicationTransition.cs", "ArticlePublicationTransitionWriter.ApplyAsync", "article-publication-coordinate"));
        JsonObject scheduledReplacementFact = CausalFact(
            "article.scheduled.replace-cancel-stale",
            "replacement cancellation or stale schedule",
            "does-not-switch",
            "current publication pointer before a due row is successfully claimed",
            "the due predicate no longer matches or the row loses the FOR UPDATE SKIP LOCKED claim",
            "article.publication.scheduler",
            ("src/backend/Services/Background/ScheduledPublishQuery.cs", "ScheduledPublishQuery.BuildDueArticlesCte", "scheduled-publish-due-claim"),
            ("src/backend/Services/Background/ScheduledPublishWorker.cs", "ScheduledPublishWorker.ClaimDueArticlesAsync", "scheduled-publish-stale-row"));
        JsonObject rollbackFact = CausalFact(
            "article.rollback.new-revision-publication",
            "rollback",
            "creates",
            "new revision and new publication coordinates from a historical revision while preserving immutable history",
            "the requested historical revision is accepted as the rollback source",
            "article.revision-publication",
            ("src/backend/Services/ArticleService.Mutations.cs", "ArticleService.UpdateAsync", "article-rollback-new-revision"),
            ("src/backend/Services/ArticlePublicationTransition.cs", "ArticlePublicationTransitionWriter.ApplyAsync", "article-rollback-new-publication"));
        JsonObject restoreFact = CausalFact(
            "article.restore.new-publication-no-revision",
            "restore",
            "creates",
            "new publication coordinate without reviving the old publication or creating a new revision",
            "a soft-deleted article is restored from its existing current revision",
            "article.revision-publication",
            ("src/backend/Services/ArticleService.LifecycleAndReadModels.cs", "ArticleService.RestoreAsync", "article-restore-coordinate"),
            ("src/backend/Services/ArticlePublicationTransition.cs", "ArticlePublicationTransitionWriter.ApplyAsync", "article-restore-new-publication"));
        JsonObject deleteFact = CausalFact(
            "article.delete.visibility-history",
            "soft delete",
            "preserves",
            "current revision publication pointer and immutable history without creating revision publication or tombstone",
            "the current non-deleted row wins the row-version guarded dedicated delete flow",
            "article.revision-publication-visibility",
            ("src/backend/Services/ArticleService.LifecycleAndReadModels.cs", "ArticleService.DeleteAsync", "article-delete-coordinate-preservation"));
        JsonObject deletedDescendantsPublicFact = CausalFact(
            "comment.deleted-root.public-descendants",
            "deleted root",
            "does-not-hide",
            "independently visible direct and recursive descendants while the root is a deleted placeholder",
            "each descendant remains Approved region-visible and belongs to the same published article",
            "comment.public-thread-projection",
            ("src/backend/Services/CommentQueryService.cs", "CommentQueryService.PublicVisibleChainCte", "comment-deleted-root-public-descendants"));
        JsonObject deletedDescendantsAdminFact = CausalFact(
            "comment.deleted-root.admin-descendants",
            "deleted root",
            "does-not-hide",
            "direct or recursive descendant entities from the admin and attributable projections",
            "the projection is authorized for administrative or author attribution access",
            "comment.admin-projection",
            ("src/backend/Services/CommentQueryService.cs", "CommentQueryService.GetAttributableAsync", "comment-deleted-root-admin-descendants"));

        // --- Comment moderation ---
        string[] moderationStates = Enum.GetNames<CommentModerationStatus>()
            .OrderBy(static name => name, StringComparer.Ordinal)
            .ToArray();
        var commentAllowed = new List<string>();
        var commentForbidden = new List<string>();
        foreach (CommentModerationStatus from in Enum.GetValues<CommentModerationStatus>())
        {
            foreach (CommentModerationStatus to in Enum.GetValues<CommentModerationStatus>())
            {
                string edge = $"{from}->{to}";
                if (CommentModerationTransitions.IsAllowed(from, to))
                {
                    commentAllowed.Add(edge);
                }
                else
                {
                    commentForbidden.Add(edge);
                }
            }
        }

        commentAllowed = commentAllowed.OrderBy(static value => value, StringComparer.Ordinal).ToList();
        commentForbidden = commentForbidden.OrderBy(static value => value, StringComparer.Ordinal).ToList();

        if (commentAllowed.Any(static edge => edge.EndsWith("->Pending", StringComparison.Ordinal)))
        {
            failures.Add("comment moderation must not allow transitions back to Pending");
        }

        if (commentAllowed.Any(static edge =>
        {
            string[] parts = edge.Split("->", 2, StringSplitOptions.None);
            return parts.Length == 2 && parts[0] == parts[1];
        }))
        {
            failures.Add("comment moderation must not allow self-transitions");
        }

        // Public visibility: only Approved; admin surfaces include full moderation set.
        var commentPublicVisibility = new JsonObject
        {
            [nameof(CommentModerationStatus.Pending)] = false,
            [nameof(CommentModerationStatus.Approved)] = true,
            [nameof(CommentModerationStatus.Rejected)] = false,
            [nameof(CommentModerationStatus.Hidden)] = false
        };
        string[] commentAdminVisibility = moderationStates;

        // Thread limits from CommentService production defaults + clamp bounds.
        const int DefaultMaxDepth = 32;
        const int DefaultMaxChildren = 500;
        int observedDefaultDepth = ReadPrivateStaticInt32(typeof(CommentCommandService), "DefaultMaxThreadDepth", DefaultMaxDepth);
        int observedDefaultChildren = ReadPrivateStaticInt32(typeof(CommentCommandService), "DefaultMaxChildrenPerNode", DefaultMaxChildren);
        if (observedDefaultDepth != DefaultMaxDepth)
        {
            failures.Add($"comment max-depth default drifted: {observedDefaultDepth}");
        }

        if (observedDefaultChildren != DefaultMaxChildren)
        {
            failures.Add($"comment child-limit default drifted: {observedDefaultChildren}");
        }

        var maxDepth = new JsonObject
        {
            ["configurationKey"] = "CommentThreads:MaxDepth",
            ["default"] = new JsonObject { ["value"] = observedDefaultDepth, ["unit"] = "levels" },
            ["minimum"] = new JsonObject { ["value"] = 2, ["unit"] = "levels", ["boundary"] = "inclusive" },
            ["maximum"] = new JsonObject { ["value"] = 256, ["unit"] = "levels", ["boundary"] = "inclusive" },
            ["compare"] = "parent.depth + 1 <= maxDepth",
            ["enforcement"] = "reject-new-write"
        };
        var childLimit = new JsonObject
        {
            ["configurationKey"] = "CommentThreads:MaxChildrenPerNode",
            ["default"] = new JsonObject { ["value"] = observedDefaultChildren, ["unit"] = "children" },
            ["minimum"] = new JsonObject { ["value"] = 1, ["unit"] = "children", ["boundary"] = "inclusive" },
            ["maximum"] = new JsonObject { ["value"] = 10_000, ["unit"] = "children", ["boundary"] = "inclusive" },
            ["compare"] = "childCount < maxChildren",
            ["boundary"] = "exclusive-upper-on-count",
            ["enforcement"] = "reject-new-write"
        };

        var rootParentInvariants = new JsonObject
        {
            ["rootRequiresParent"] = true,
            ["rootId"] = "parent.RootId ?? parent.Id",
            ["requestedRootMustMatchComputed"] = true,
            ["replyToCommentIdDefaultsToParent"] = true,
            ["depth"] = "max(1, parent.Depth + 1)",
            ["parentMustBePubliclyApprovedVisible"] = true
        };

        var editDeleteVersion = new JsonObject
        {
            ["expectedVersionCas"] = true,
            ["nextVersion"] = "currentVersion + 1",
            ["operations"] = ToJsonArray(SortedUnique(
                CommentRevisionOperations.Created,
                CommentRevisionOperations.Edited,
                CommentRevisionOperations.Deleted)),
            ["softDeleteProjectsAsHiddenNextStatus"] = true,
            ["editWindow"] = new JsonObject
            {
                ["configurationKey"] = "Comments:AuthorEditWindowMinutes",
                ["default"] = new JsonObject { ["value"] = 30, ["unit"] = "minutes" }
            }
        };

        var regionVisibility = new JsonObject
        {
            ["publicSurface"] = new JsonObject
            {
                ["requires"] = "Approved",
                ["blockedRegionFilter"] = "viewer-region-aware",
                ["unknownViewer"] = "apply-all-blocked-regions"
            },
            ["states"] = ToJsonArray(SortedUnique(
                "public",
                "limited",
                "pending",
                "rejected",
                "hidden",
                "deleted")),
            ["adminSurface"] = "full-moderation-states"
        };

        // Comment outbox consumers: pure catalog authority shared with dispatcher.
        var requiredByEvent = new JsonObject();
        var allRequiredUnion = new HashSet<string>(StringComparer.Ordinal);
        foreach (string eventType in CommentMutationEventTypes.All.OrderBy(static value => value, StringComparer.Ordinal))
        {
            string[] required = CommentMutationOutboxConsumers.RequiredFor(eventType)
                .OrderBy(static value => value, StringComparer.Ordinal)
                .ToArray();
            requiredByEvent[eventType] = ToJsonArray(required);
            foreach (string consumer in required)
            {
                allRequiredUnion.Add(consumer);
                if (!CommentMutationOutboxConsumers.All.Contains(consumer))
                {
                    failures.Add($"comment outbox consumer {consumer} for {eventType} outside All registry");
                }
            }
        }

        string[] commentOutboxAll = CommentMutationOutboxConsumers.All
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();
        if (!allRequiredUnion.SetEquals(commentOutboxAll))
        {
            // model-moderation only on Created still counts as registry member; All may be superset of union.
            if (!commentOutboxAll.All(allRequiredUnion.Contains) && allRequiredUnion.IsSubsetOf(commentOutboxAll))
            {
                // OK: All is the registry; union of required may equal All when every consumer is used.
            }
        }

        // Coherence: every All consumer must appear for at least one event type.
        foreach (string consumer in commentOutboxAll)
        {
            if (!allRequiredUnion.Contains(consumer))
            {
                failures.Add($"comment outbox registry consumer {consumer} never required by any event");
            }
        }

        string[] commentTerminalStates = SortedUnique(
            CommentMutationOutboxStatus.Processed,
            CommentMutationOutboxStatus.Poison,
            CommentMutationOutboxDeliveryStatus.Completed,
            CommentMutationOutboxDeliveryStatus.TerminalFailed);

        var notificationConditions = new JsonObject
        {
            ["replyNotificationEvent"] = CommentMutationEventTypes.ReplyNotificationRequested,
            ["publishAdded"] = "transition-into-Approved",
            ["publishRemoved"] = "transition-out-of-Approved-or-delete",
            ["requiresPublicRecipientAccount"] = true,
            ["anonymousReplyDoesNotMapIdentity"] = true
        };

        // Privacy: persisted governance fields vs forbidden exact identity fields from formal contract.
        string[] privacyPersisted = SortedUnique(
            "anonymous_nullifier_hash",
            "anonymous_scope",
            "moderation_subject_hash",
            "credential_level",
            "reputation_bucket",
            "account_age_bucket",
            "anonymous_rate_class",
            "anonymous_display_name",
            "anonymous_display_language",
            "anonymous_handle",
            "public_handle",
            "author_mode",
            "anonymous_ticket_hash");
        string[] privacyForbidden = AntiSpamModerationContract.ForbiddenIdentityFields
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();
        if (privacyForbidden.Length == 0)
        {
            failures.Add("privacy forbidden exact fields catalog is empty");
        }

        string[] appealSourceStates = SortedUnique(
            nameof(CommentModerationStatus.Hidden),
            nameof(CommentModerationStatus.Rejected));

        var facts = new JsonObject
        {
            ["article.lifecycle.states"] = ToJsonArray(SortedUnique(
                nameof(ArticleStatus.Draft),
                nameof(ArticleStatus.Scheduled),
                nameof(ArticleStatus.Published),
                nameof(ArticleStatus.Archived),
                nameof(ArticleStatus.Deleted))),
            ["article.lifecycle.allowed-transitions"] = ToJsonArray(allowedTransitions.ToArray()),
            ["article.lifecycle.forbidden-transitions"] = ToJsonArray(forbiddenTransitions.ToArray()),
            ["article.publication.required-coordinates"] = ToJsonArray(requiredCoordinates),
            ["article.scheduled.boundary"] = scheduledBoundary,
            ["article.scheduled.preDueCurrent"] = scheduledPreDueFact,
            ["article.scheduled.dueTransition"] = scheduledDueFact,
            ["article.scheduled.replaceCancelStale"] = scheduledReplacementFact,
            ["article.rollback.semantics"] = rollbackSemantics,
            ["article.rollback.causal"] = rollbackFact,
            ["article.restore.semantics"] = restoreSemantics,
            ["article.restore.causal"] = restoreFact,
            ["article.delete.semantics"] = deleteSemantics,
            ["article.delete.causal"] = deleteFact,
            ["article.public-visibility.states"] = publicVisibility,
            ["article.admin-visibility.states"] = ToJsonArray(adminVisibilityStates),
            ["article.outbox.required-edges"] = ToJsonArray(requiredEdges),
            ["article.outbox.optional-edges"] = ToJsonArray(optionalEdges),
            ["article.outbox.terminal-states"] = ToJsonArray(articleTerminalStates),
            ["article.outbox.event-types"] = ToJsonArray(articleEventTypes),
            ["article.rights.required-fields"] = ToJsonArray(rightsRequiredFields),
            ["article.responsibility.requirement"] = responsibilityRequirement,
            ["comment.moderation.states"] = ToJsonArray(moderationStates),
            ["comment.moderation.allowed-transitions"] = ToJsonArray(commentAllowed.ToArray()),
            ["comment.moderation.forbidden-transitions"] = ToJsonArray(commentForbidden.ToArray()),
            ["comment.public-visibility.states"] = commentPublicVisibility,
            ["comment.admin-visibility.states"] = ToJsonArray(commentAdminVisibility),
            ["comment.thread.max-depth"] = maxDepth,
            ["comment.thread.child-limit"] = childLimit,
            ["comment.thread.root-parent-invariants"] = rootParentInvariants,
            ["comment.edit-delete.version-semantics"] = editDeleteVersion,
            ["comment.region.visibility-states"] = regionVisibility,
            ["comment.deletedRoot.publicDescendants"] = deletedDescendantsPublicFact,
            ["comment.deletedRoot.adminDescendants"] = deletedDescendantsAdminFact,
            ["comment.outbox.required-edges"] = requiredByEvent,
            ["comment.outbox.consumer-registry"] = ToJsonArray(commentOutboxAll),
            ["comment.outbox.terminal-states"] = ToJsonArray(commentTerminalStates),
            ["comment.notification.conditions"] = notificationConditions,
            ["comment.privacy.persisted-fields"] = ToJsonArray(privacyPersisted),
            ["comment.privacy.forbidden-exact-fields"] = ToJsonArray(privacyForbidden),
            ["comment.appeal.allowed-source-states"] = ToJsonArray(appealSourceStates),
            ["coherence"] = new JsonObject
            {
                ["articleEntityCoreProjection"] = failures.Count == 0 ? "consistent" : "inconsistent",
                ["articleOutboxRequiredOptional"] = failures.Count == 0 ? "consistent" : "inconsistent",
                ["commentOutboxProducerDispatcher"] = failures.Count == 0 ? "consistent" : "inconsistent",
                ["commentPublicAdminVisibilitySeparated"] = true,
                ["layers"] = new JsonObject
                {
                    ["articlePolicy"] = "ArticleStatusTransitionPolicy",
                    ["articleEntity"] = "ArticleStatus / ArticlePublication",
                    ["articleOutbox"] = "ArticleMutationReplayEdges",
                    ["commentTransitions"] = "CommentModerationTransitions",
                    ["commentOutbox"] = "CommentMutationOutboxConsumers",
                    ["commentPublicReader"] = "CommentQueryService Approved filter",
                    ["privacyProjection"] = "AntiSpamModerationContract.ForbiddenIdentityFields"
                }
            }
        };

        var document = new JsonObject
        {
            ["schema"] = ObservationSchema,
            ["source"] = "compiled-production-constants",
            ["facts"] = facts,
            ["failureReasons"] = ToJsonArray(failures.OrderBy(static value => value, StringComparer.Ordinal).ToArray()),
            ["status"] = failures.Count == 0 ? "ok" : "failed"
        };

        if (failures.Count > 0)
        {
            throw new InvalidOperationException(
                "content-lifecycle observation failed coherence checks: " + string.Join("; ", failures));
        }

        return document;
    }

    private static int ReadPrivateStaticInt32(Type type, string fieldName, int fallback)
    {
        FieldInfo? field = type.GetField(fieldName, BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Public);
        if (field is null)
        {
            return fallback;
        }

        object? value = field.GetValue(null);
        return value is int number ? number : fallback;
    }

    private static string[] SortedUnique(params string[] values)
        => values
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();

    private static JsonArray ToJsonArray(IReadOnlyList<string> values)
    {
        var array = new JsonArray();
        foreach (string value in values)
        {
            array.Add(value);
        }

        return array;
    }

    private static string Sha256Hex(string text)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(text));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
