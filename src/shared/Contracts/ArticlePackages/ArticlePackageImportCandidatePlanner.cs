using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Requested intent only; neither mode authorizes a target operation.</summary>
public enum ArticlePackageImportCandidateMode : byte
{
    CreateNew = 1,
    UpdateRequested = 2
}

/// <summary>Explicit untrusted update hints, never inferred from source IDs, titles or filenames.</summary>
public sealed record ArticlePackageImportRequestedTarget(
    ArticlePackageIdentity PortableArticle,
    int RequestedTargetArticleId,
    long ExpectedTargetRevision);

/// <summary>
/// Caller-supplied context and validity interval. Permission and policy digests are assertions,
/// not freshly observed permission decisions. Target rows are copied before planning.
/// </summary>
public sealed record ArticlePackageImportCandidateRequest(
    ArticleRelationActorContext Actor,
    ArticlePackageImportCandidateMode Mode,
    string PolicyDigest,
    DateTime CreatedAtUtc,
    DateTime ExpiresAtUtc,
    IReadOnlyList<ArticlePackageImportRequestedTarget>? RequestedTargets);

/// <summary>Frozen identity requirement or explicit update request; no target has been resolved.</summary>
public sealed record ArticlePackageImportCandidateTarget(
    ArticlePackageIdentity PortableArticle,
    bool RequiresNewIdentity,
    int? RequestedTargetArticleId,
    long? ExpectedTargetRevision);

/// <summary>
/// Immutable whole-set intermediate plan. This is always blocked on the original authorities;
/// it contains no write command, temporary-resource receipt or zero-write runtime observation.
/// </summary>
public sealed class ArticlePackageImportCandidatePlan
{
    internal ArticlePackageImportCandidatePlan(
        ArticlePackageValidatedImportCandidate candidate,
        ArticlePackageImportCandidateRequest request,
        ArticlePackageImportCandidateTarget[] targets,
        string planDigest)
    {
        Candidate = candidate;
        Actor = request.Actor;
        Mode = request.Mode;
        PolicyDigest = request.PolicyDigest;
        CreatedAtUtc = request.CreatedAtUtc;
        ExpiresAtUtc = request.ExpiresAtUtc;
        Targets = Array.AsReadOnly((ArticlePackageImportCandidateTarget[])targets.Clone());
        PlanDigest = planDigest;
        RequiredAuthorities = Array.AsReadOnly(new[]
        {
            "archive_intake",
            "complete_package_schema",
            "canonical_source_and_property_provenance",
            "fsusui_syntax_dependencies",
            "persisted_relation_and_embed_plan",
            "frozen_public_projection_retention",
            "asset_and_dependency_resolution",
            "rights_responsibility_taxonomy_privacy",
            "current_actor_site_target_permissions",
            "current_target_revision_and_identity",
            "execution_qualification"
        });
    }

    public ArticlePackageValidatedImportCandidate Candidate
    {
        get;
    }
    public ArticleRelationActorContext Actor
    {
        get;
    }
    public ArticlePackageImportCandidateMode Mode
    {
        get;
    }
    public string PolicyDigest
    {
        get;
    }
    public DateTime CreatedAtUtc
    {
        get;
    }
    public DateTime ExpiresAtUtc
    {
        get;
    }
    public string PlanDigest
    {
        get;
    }
    public IReadOnlyList<ArticlePackageImportCandidateTarget> Targets
    {
        get;
    }
    public IReadOnlyList<string> RequiredAuthorities
    {
        get;
    }

    /// <summary>No supplied digest, self-consistent bytes or requested target grants execution.</summary>
    public ArticlePackageManifestCandidateResult RequireExecutionAuthority()
        => new(false, "article_package_import_authority_unavailable");

    /// <summary>
    /// Compares caller assertions to the frozen request and interval. A successful comparison
    /// does not observe permissions, target revisions, retention or current policy from a store.
    /// Drift never refreshes or silently changes this plan.
    /// </summary>
    public ArticlePackageManifestCandidateResult ValidateRequestBinding(
        ArticlePackageImportCandidateRequest? request,
        string? currentPackageBytesDigest,
        DateTime nowUtc)
    {
        if (nowUtc.Kind != DateTimeKind.Utc
            || nowUtc < CreatedAtUtc
            || nowUtc >= ExpiresAtUtc
            || !string.Equals(currentPackageBytesDigest, Candidate.PackageBytesDigest, StringComparison.Ordinal))
        {
            return new(false, "article_package_import_plan_stale");
        }
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidatePlanner.TryCreatePlan(
            Candidate,
            request,
            out ArticlePackageImportCandidatePlan? recomputed);
        return result.IsValid && string.Equals(recomputed!.PlanDigest, PlanDigest, StringComparison.Ordinal)
            ? new(true, null)
            : new(false, "article_package_import_plan_stale");
    }
}

/// <summary>
/// Freezes a bounded finite-byte candidate and caller intent without resolving or creating
/// identities, reading stores, parsing Markdown, granting permissions or executing an import.
/// </summary>
public static class ArticlePackageImportCandidatePlanner
{
    public const int MaxArticles = 1000;
    public const string DigestDomain = "fsusblog.article-package.import-candidate.plan.v1";

    public static ArticlePackageManifestCandidateResult TryCreatePlan(
        ArticlePackageValidatedImportCandidate? candidate,
        ArticlePackageImportCandidateRequest? request,
        out ArticlePackageImportCandidatePlan? plan,
        CancellationToken cancellationToken = default)
    {
        plan = null;
        if (cancellationToken.IsCancellationRequested)
        {
            return Invalid("article_package_import_cancelled");
        }
        if (candidate is null)
        {
            return Invalid("article_package_import_candidate_required");
        }
        if (request is null
            || !ArticleRelationContractValidator.Validate(request.Actor).IsValid
            || !ArticleRelationDigest.IsSha256(request.PolicyDigest)
            || request.CreatedAtUtc.Kind != DateTimeKind.Utc
            || request.ExpiresAtUtc.Kind != DateTimeKind.Utc
            || request.ExpiresAtUtc <= request.CreatedAtUtc
            || !Enum.IsDefined(request.Mode))
        {
            return Invalid("article_package_import_request_invalid");
        }
        if (!TryCopyTargets(request.RequestedTargets, cancellationToken, out ArticlePackageImportRequestedTarget[] requested))
        {
            return Invalid(cancellationToken.IsCancellationRequested
                ? "article_package_import_cancelled"
                : "article_package_import_targets_invalid");
        }

        IReadOnlyList<ArticlePackageManifestArticle> articles = candidate.Manifest.Articles;
        if (articles.Count < 1 || articles.Count > MaxArticles)
        {
            return Invalid("article_package_import_article_budget_exceeded");
        }
        var targets = new ArticlePackageImportCandidateTarget[articles.Count];
        if (request.Mode == ArticlePackageImportCandidateMode.CreateNew)
        {
            if (requested.Length != 0)
            {
                return Invalid("article_package_import_create_targets_forbidden");
            }
            for (int index = 0; index < articles.Count; index++)
            {
                targets[index] = new(articles[index].PortableArticle, true, null, null);
            }
        }
        else
        {
            if (requested.Length != articles.Count)
            {
                return Invalid("article_package_import_target_closure_mismatch");
            }
            var byPortable = new Dictionary<ArticlePackageIdentity, ArticlePackageImportRequestedTarget>();
            var targetIds = new HashSet<int>();
            foreach (ArticlePackageImportRequestedTarget? target in requested)
            {
                if (target is null
                    || target.PortableArticle.Kind != ArticlePackageIdentityKind.Article
                    || !ArticlePackageIdentity.TryCreate(
                        ArticlePackageIdentityKind.Article,
                        target.PortableArticle.Value,
                        out ArticlePackageIdentity checkedIdentity).IsValid
                    || checkedIdentity != target.PortableArticle
                    || target.RequestedTargetArticleId < 1
                    || target.ExpectedTargetRevision < 1
                    || !byPortable.TryAdd(target.PortableArticle, target)
                    || !targetIds.Add(target.RequestedTargetArticleId))
                {
                    return Invalid("article_package_import_targets_invalid");
                }
            }
            for (int index = 0; index < articles.Count; index++)
            {
                if (!byPortable.TryGetValue(articles[index].PortableArticle, out ArticlePackageImportRequestedTarget? target))
                {
                    return Invalid("article_package_import_target_closure_mismatch");
                }
                targets[index] = new(target.PortableArticle, false, target.RequestedTargetArticleId, target.ExpectedTargetRevision);
            }
        }

        string digest;
        try
        {
            digest = ComputeDigest(candidate, request, targets);
        }
        catch (EncoderFallbackException)
        {
            return Invalid("article_package_import_request_invalid");
        }
        if (cancellationToken.IsCancellationRequested)
        {
            return Invalid("article_package_import_cancelled");
        }
        plan = new(candidate, request, targets, digest);
        return new(true, null);
    }

    private static bool TryCopyTargets(
        IReadOnlyList<ArticlePackageImportRequestedTarget>? input,
        CancellationToken cancellationToken,
        out ArticlePackageImportRequestedTarget[] owned)
    {
        owned = [];
        if (input is null)
        {
            return true;
        }
        try
        {
            int count = input.Count;
            if (count < 0 || count > MaxArticles)
            {
                return false;
            }
            var copy = new ArticlePackageImportRequestedTarget[count];
            for (int index = 0; index < count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                copy[index] = input[index];
            }
            owned = copy;
            return true;
        }
        catch (Exception)
        {
            // Caller-owned collection providers can throw content-bearing exceptions. No caller
            // data or partially copied target list escapes this boundary.
            return false;
        }
    }

    private static string ComputeDigest(
        ArticlePackageValidatedImportCandidate candidate,
        ArticlePackageImportCandidateRequest request,
        ArticlePackageImportCandidateTarget[] targets)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var utf8 = new UTF8Encoding(false, true);
        AppendString(hash, utf8, DigestDomain);
        AppendString(hash, utf8, candidate.PackageBytesDigest);
        AppendString(hash, utf8, candidate.ChecksumComponentDigest);
        AppendString(hash, utf8, candidate.Manifest.SemanticDigest);
        AppendString(hash, utf8, request.Actor.ActorIdentity);
        AppendString(hash, utf8, request.Actor.SiteIdentity);
        AppendString(hash, utf8, request.Actor.PermissionContextDigest);
        AppendInt64(hash, (long)request.Mode);
        AppendString(hash, utf8, request.PolicyDigest);
        AppendInt64(hash, request.CreatedAtUtc.Ticks);
        AppendInt64(hash, request.ExpiresAtUtc.Ticks);
        AppendInt64(hash, targets.Length);
        foreach (ArticlePackageImportCandidateTarget target in targets)
        {
            AppendString(hash, utf8, target.PortableArticle.Value!);
            AppendInt64(hash, target.RequiresNewIdentity ? 1 : 0);
            AppendInt64(hash, target.RequestedTargetArticleId ?? 0);
            AppendInt64(hash, target.ExpectedTargetRevision ?? 0);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static void AppendString(IncrementalHash hash, UTF8Encoding utf8, string value)
    {
        byte[] bytes = utf8.GetBytes(value);
        AppendInt64(hash, bytes.Length);
        hash.AppendData(bytes);
    }

    private static void AppendInt64(IncrementalHash hash, long value)
    {
        Span<byte> bytes = stackalloc byte[8];
        BinaryPrimitives.WriteInt64BigEndian(bytes, value);
        hash.AppendData(bytes);
    }

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);
}
