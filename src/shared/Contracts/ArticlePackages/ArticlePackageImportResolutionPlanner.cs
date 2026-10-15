using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>
/// Freezes explicit resolution intent around the existing candidate planner. It never observes
/// targets, creates definitions/assets, patches an old plan or establishes unresolved closure.
/// </summary>
public static class ArticlePackageImportResolutionPlanner
{
    public const int MaxItems = 1000;
    public const int MaxLossEntries = 10000;
    public const string DigestDomain = "fsusblog.article-package.resolution-preparation.v1";

    /// <summary>Produces only a new blocked candidate and an immutable intent proposal.</summary>
    public static ArticlePackageManifestCandidateResult TryPrepare(
        ArticlePackageImportCandidatePlan? oldPlan,
        ArticlePackageImportCandidateRequest? originalRequest,
        ArticlePackageImportCandidateRequest? replacementRequest,
        ArticlePackageImportResolutionBinding? binding,
        IReadOnlyList<ArticlePackageImportResolutionItem>? items,
        IReadOnlyList<ArticlePackageImportResolutionChoice>? choices,
        DateTime nowUtc,
        out ArticlePackageImportResolutionProposal? proposal,
        CancellationToken cancellationToken = default)
    {
        proposal = null;
        if (cancellationToken.IsCancellationRequested)
        {
            return Invalid("article_package_resolution_cancelled");
        }
        if (oldPlan is null || originalRequest is null || replacementRequest is null || binding is null
            || !oldPlan.ValidateRequestBinding(originalRequest, binding.PackageBytesDigest, nowUtc).IsValid
            || binding.OldPlanDigest != oldPlan.PlanDigest
            || binding.SiteIdentity != oldPlan.Actor.SiteIdentity
            || binding.PermissionContextDigest != oldPlan.Actor.PermissionContextDigest
            || binding.PolicyDigest != oldPlan.PolicyDigest
            || !IsDigest(binding.SchemaDigest) || !IsDigest(binding.CatalogDigest)
            || replacementRequest.Actor != oldPlan.Actor || replacementRequest.Mode != oldPlan.Mode
            || replacementRequest.PolicyDigest != oldPlan.PolicyDigest
            || replacementRequest.CreatedAtUtc.Kind != DateTimeKind.Utc
            || replacementRequest.CreatedAtUtc <= oldPlan.CreatedAtUtc
            || replacementRequest.CreatedAtUtc > nowUtc
            || replacementRequest.ExpiresAtUtc > oldPlan.ExpiresAtUtc
            || replacementRequest.ExpiresAtUtc <= nowUtc)
        {
            return Invalid("article_package_resolution_binding_stale");
        }
        if (oldPlan.RequiredAuthorities.Count != 11 || oldPlan.RequireExecutionAuthority().IsValid)
        {
            return Invalid("article_package_import_authority_unavailable");
        }
        try
        {
            ArticlePackageImportResolutionItem[] ownedItems = CopyItems(items);
            ArticlePackageImportResolutionChoice[] ownedChoices = Copy(choices, MaxItems);
            if (ownedItems.Length == 0 || ownedItems.Length != ownedChoices.Length)
            {
                return Invalid("article_package_resolution_choices_required");
            }
            var articleIds = oldPlan.Candidate.Manifest.Articles.Select(article => article.PortableArticle).ToHashSet();
            var sources = new HashSet<ArticlePackageIdentity>();
            var bySource = new Dictionary<ArticlePackageIdentity, ArticlePackageImportResolutionChoice>();
            foreach (ArticlePackageImportResolutionChoice choice in ownedChoices)
            {
                if (!bySource.TryAdd(choice.Source, choice))
                {
                    return Invalid("article_package_resolution_choice_duplicate");
                }
            }
            int lossCount = 0;
            var orderedChoices = new ArticlePackageImportResolutionChoice[ownedItems.Length];
            var lossDigests = new string[ownedItems.Length];
            for (int index = 0; index < ownedItems.Length; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ArticlePackageImportResolutionItem item = ownedItems[index];
                lossCount = checked(lossCount + item.Loss.Count);
                if (!IsIdentity(item.Source) || !sources.Add(item.Source) || item.SourceVersion < 1
                    || !IsDigest(item.SourceDigest) || !IsShape(item.ExpectedShape, item.Source.Kind)
                    || item.DisplayLabel is null || item.DisplayLabel.Length > 128
                    || item.AllowedActions.Count is < 1 or > 3
                    || item.AllowedActions.Any(allowedAction => !Enum.IsDefined(allowedAction))
                    || item.AllowedActions.Distinct().Count() != item.AllowedActions.Count
                    || item.Loss.Count == 0 || lossCount > MaxLossEntries
                    || item.Loss.Any(loss => !articleIds.Contains(loss.PortableArticle)
                        || !IsText(loss.FieldIdentity) || !IsDigest(loss.ValueDigest) || !IsDigest(loss.ConsequenceDigest))
                    || item.Loss.Select(loss => (loss.PortableArticle, loss.FieldIdentity)).Distinct().Count() != item.Loss.Count)
                {
                    return Invalid("article_package_resolution_item_invalid");
                }
                if (!bySource.TryGetValue(item.Source, out ArticlePackageImportResolutionChoice? choice)
                    || choice.SourceVersion != item.SourceVersion || choice.SourceDigest != item.SourceDigest
                    || choice.ExpectedShape != item.ExpectedShape
                    || choice.Action is not { } action || !Enum.IsDefined(action)
                    || !item.AllowedActions.Contains(action)
                    || choice.ActorIdentity != oldPlan.Actor.ActorIdentity
                    || choice.ChosenAtUtc.Kind != DateTimeKind.Utc || choice.ChosenAtUtc < oldPlan.CreatedAtUtc
                    || choice.ChosenAtUtc > replacementRequest.CreatedAtUtc)
                {
                    return Invalid("article_package_resolution_choice_invalid");
                }
                string lossDigest = ComputeLossDigest(item);
                if (!IsChoice(item, choice, binding, lossDigest))
                {
                    return Invalid("article_package_resolution_intent_invalid");
                }
                orderedChoices[index] = choice;
                lossDigests[index] = lossDigest;
            }
            if (ComputeCatalogDigest(ownedItems) != binding.CatalogDigest)
            {
                return Invalid("article_package_resolution_catalog_stale");
            }
            ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidatePlanner.TryCreatePlan(
                oldPlan.Candidate, replacementRequest, out ArticlePackageImportCandidatePlan? newCandidate, cancellationToken);
            if (!result.IsValid)
            {
                return result;
            }
            if (!oldPlan.Targets.SequenceEqual(newCandidate!.Targets) || newCandidate.PlanDigest == oldPlan.PlanDigest
                || !oldPlan.RequiredAuthorities.SequenceEqual(newCandidate.RequiredAuthorities)
                || newCandidate.RequireExecutionAuthority().IsValid)
            {
                return Invalid("article_package_resolution_candidate_mismatch");
            }
            string digest = ComputeProposalDigest(oldPlan, newCandidate, binding, ownedItems, orderedChoices);
            cancellationToken.ThrowIfCancellationRequested();
            proposal = new(oldPlan, newCandidate, binding, ownedItems, orderedChoices, lossDigests, digest);
            return new(true, null);
        }
        catch (OperationCanceledException)
        {
            return Invalid("article_package_resolution_cancelled");
        }
        catch (Exception)
        {
            // Untrusted collection providers and malformed text must not leak content or partial proposals.
            return Invalid("article_package_resolution_input_invalid");
        }
    }

    /// <summary>Revalidates the same assertions; success is never a fresh store observation.</summary>
    public static ArticlePackageManifestCandidateResult ValidateBinding(
        ArticlePackageImportResolutionProposal? proposal,
        ArticlePackageImportCandidateRequest? originalRequest,
        ArticlePackageImportCandidateRequest? replacementRequest,
        ArticlePackageImportResolutionBinding? currentBinding,
        IReadOnlyList<ArticlePackageImportResolutionItem>? currentItems,
        IReadOnlyList<ArticlePackageImportResolutionChoice>? currentChoices,
        DateTime nowUtc)
    {
        if (proposal is null)
        {
            return Invalid("article_package_resolution_binding_stale");
        }
        ArticlePackageManifestCandidateResult result = TryPrepare(proposal.OldPlan, originalRequest, replacementRequest,
            currentBinding, currentItems, currentChoices, nowUtc, out ArticlePackageImportResolutionProposal? expected);
        return result.IsValid && expected!.ProposalDigest == proposal.ProposalDigest
            ? new(true, null) : Invalid("article_package_resolution_binding_stale");
    }

    /// <summary>Hashes a bounded declared catalog, not an independently observed unresolved set.</summary>
    public static string ComputeCatalogDigest(IReadOnlyList<ArticlePackageImportResolutionItem> items)
    {
        ArticlePackageImportResolutionItem[] owned = CopyItems(items);
        using var digest = new DigestWriter(DigestDomain + ".catalog");
        digest.Add(owned.Length);
        foreach (ArticlePackageImportResolutionItem item in owned)
        {
            AddItem(digest, item);
        }
        return digest.Finish();
    }

    /// <summary>Exact explicit skip confirmation covers identity, shape, fields, values and consequences.</summary>
    public static string ComputeLossDigest(ArticlePackageImportResolutionItem item)
    {
        ArticlePackageImportResolutionItem owned = CopyItems(new[] { item })[0];
        using var digest = new DigestWriter(DigestDomain + ".loss");
        AddItem(digest, owned);
        return digest.Finish();
    }

    private static bool IsChoice(ArticlePackageImportResolutionItem item, ArticlePackageImportResolutionChoice choice,
        ArticlePackageImportResolutionBinding binding, string lossDigest)
    {
        switch (choice.Action)
        {
            case ArticlePackageImportResolutionAction.Map:
                ArticlePackageImportResolutionTarget? target = choice.Target;
                return target is not null && choice.ConfirmedLossDigest is null && choice.CreationSchemaDigest is null
                    && target.SiteIdentity == binding.SiteIdentity && IsStableIdentity(target.StableIdentity, item.Source.Kind)
                    && (target.AnchorIdentity is null || item.Source.Kind == ArticlePackageIdentityKind.Article
                        && IsText(target.AnchorIdentity))
                    && target.Revision > 0 && target.Shape == item.ExpectedShape
                    && target.SourceDigest == item.SourceDigest && IsDigest(target.FactsDigest)
                    && target.PermissionContextDigest == binding.PermissionContextDigest && target.PolicyDigest == binding.PolicyDigest;
            case ArticlePackageImportResolutionAction.Create:
                return item.Source.Kind != ArticlePackageIdentityKind.Article && choice.Target is null
                    && choice.ConfirmedLossDigest is null && choice.CreationSchemaDigest == item.ExpectedShape.ConstraintsDigest;
            case ArticlePackageImportResolutionAction.Skip:
                return choice.Target is null && choice.CreationSchemaDigest is null && choice.ConfirmedLossDigest == lossDigest;
            default:
                return false;
        }
    }

    private static ArticlePackageImportResolutionItem[] CopyItems(IReadOnlyList<ArticlePackageImportResolutionItem>? items)
    {
        ArticlePackageImportResolutionItem[] owned = Copy(items, MaxItems);
        int total = 0;
        for (int index = 0; index < owned.Length; index++)
        {
            ArticlePackageImportResolutionItem item = owned[index];
            if (!IsText(item.DisplayLabel) || item.DisplayLabel.Length > 128
                || !IsIdentity(item.Source) || !IsDigest(item.SourceDigest)
                || !IsShape(item.ExpectedShape, item.Source.Kind))
            {
                throw new ArgumentException("article_package_resolution_item_invalid");
            }
            ArticlePackageImportResolutionLoss[] loss = Copy(item.Loss, MaxLossEntries);
            if (loss.Any(entry => entry.PortableArticle.Kind != ArticlePackageIdentityKind.Article
                || !IsIdentity(entry.PortableArticle) || !IsText(entry.FieldIdentity)
                || !IsDigest(entry.ValueDigest) || !IsDigest(entry.ConsequenceDigest)))
            {
                throw new ArgumentException("article_package_resolution_loss_invalid");
            }
            total = checked(total + loss.Length);
            if (total > MaxLossEntries)
            {
                throw new ArgumentException("article_package_resolution_budget_exceeded");
            }
            owned[index] = item with
            {
                AllowedActions = Array.AsReadOnly(Copy(item.AllowedActions, 3)),
                Loss = Array.AsReadOnly(loss)
            };
        }
        return owned;
    }

    private static T[] Copy<T>(IReadOnlyList<T>? input, int maximum)
    {
        ArgumentNullException.ThrowIfNull(input);
        int count = input.Count;
        if (count < 0 || count > maximum)
        {
            throw new ArgumentException("article_package_resolution_budget_exceeded");
        }
        var copy = new T[count];
        for (int index = 0; index < count; index++)
        {
            copy[index] = input[index];
            ArgumentNullException.ThrowIfNull(copy[index]);
        }
        return copy;
    }

    private static bool IsIdentity(ArticlePackageIdentity identity)
        => ArticlePackageIdentity.TryCreate(identity.Kind, identity.Value, out ArticlePackageIdentity expected).IsValid
            && identity == expected;

    private static bool IsDigest(string? value) => ArticleRelationDigest.IsSha256(value);
    private static bool IsText(string? value) => !string.IsNullOrWhiteSpace(value) && value.Length <= 256;

    private static bool IsStableIdentity(string? value, ArticlePackageIdentityKind kind)
    {
        if (value is null)
        {
            return false;
        }
        return kind switch
        {
            ArticlePackageIdentityKind.Article or ArticlePackageIdentityKind.Category or ArticlePackageIdentityKind.Tag
                => int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int id)
                    && id > 0 && value == id.ToString(CultureInfo.InvariantCulture),
            ArticlePackageIdentityKind.Asset or ArticlePackageIdentityKind.Definition or ArticlePackageIdentityKind.Option
                => Guid.TryParseExact(value, "D", out Guid id) && id != Guid.Empty && value == id.ToString("D"),
            _ => false
        };
    }
    private static bool IsShape(ArticlePackageImportResolutionShape? shape, ArticlePackageIdentityKind kind)
        => shape is not null && shape.Kind == kind && Enum.IsDefined(shape.Cardinality)
            && IsDigest(shape.TypeDigest) && IsDigest(shape.ConstraintsDigest);

    private static string ComputeProposalDigest(ArticlePackageImportCandidatePlan oldPlan,
        ArticlePackageImportCandidatePlan newPlan, ArticlePackageImportResolutionBinding binding,
        ArticlePackageImportResolutionItem[] items, ArticlePackageImportResolutionChoice[] choices)
    {
        using var digest = new DigestWriter(DigestDomain);
        digest.Add(oldPlan.PlanDigest);
        digest.Add(newPlan.PlanDigest);
        digest.Add(binding.PackageBytesDigest);
        digest.Add(binding.SiteIdentity);
        digest.Add(binding.SchemaDigest);
        digest.Add(binding.CatalogDigest);
        digest.Add(binding.PermissionContextDigest);
        digest.Add(binding.PolicyDigest);
        digest.Add(items.Length);
        for (int index = 0; index < items.Length; index++)
        {
            AddItem(digest, items[index]);
            ArticlePackageImportResolutionChoice choice = choices[index];
            digest.Add((long)choice.Action!.Value);
            digest.Add(choice.ActorIdentity);
            digest.Add(choice.ChosenAtUtc.Ticks);
            digest.Add(choice.ConfirmedLossDigest);
            digest.Add(choice.CreationSchemaDigest);
            ArticlePackageImportResolutionTarget? target = choice.Target;
            digest.Add(target is null ? 0 : 1);
            if (target is not null)
            {
                digest.Add(target.SiteIdentity);
                digest.Add(target.StableIdentity);
                digest.Add(target.AnchorIdentity);
                digest.Add(target.Revision);
                AddShape(digest, target.Shape);
                digest.Add(target.SourceDigest);
                digest.Add(target.FactsDigest);
                digest.Add(target.PermissionContextDigest);
                digest.Add(target.PolicyDigest);
            }
        }
        return digest.Finish();
    }

    private static void AddItem(DigestWriter digest, ArticlePackageImportResolutionItem item)
    {
        digest.Add((long)item.Source.Kind);
        digest.Add(item.Source.Value);
        digest.Add(item.SourceVersion);
        digest.Add(item.SourceDigest);
        digest.Add(item.DisplayLabel);
        AddShape(digest, item.ExpectedShape);
        digest.Add(item.AllowedActions.Count);
        foreach (ArticlePackageImportResolutionAction action in item.AllowedActions)
        {
            digest.Add((long)action);
        }
        digest.Add(item.Loss.Count);
        foreach (ArticlePackageImportResolutionLoss loss in item.Loss)
        {
            digest.Add(loss.PortableArticle.Value);
            digest.Add(loss.FieldIdentity);
            digest.Add(loss.ValueDigest);
            digest.Add(loss.ConsequenceDigest);
        }
    }

    private static void AddShape(DigestWriter digest, ArticlePackageImportResolutionShape shape)
    {
        digest.Add((long)shape.Kind);
        digest.Add(shape.TypeDigest);
        digest.Add((long)shape.Cardinality);
        digest.Add(shape.ConstraintsDigest);
    }

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);

    private sealed class DigestWriter : IDisposable
    {
        private readonly IncrementalHash _hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        private readonly UTF8Encoding _utf8 = new(false, true);

        public DigestWriter(string domain) => Add(domain);

        public void Add(string? value)
        {
            if (value is null)
            {
                Add(-1);
                return;
            }
            byte[] bytes = _utf8.GetBytes(value);
            Add(bytes.Length);
            _hash.AppendData(bytes);
        }

        public void Add(long value)
        {
            Span<byte> bytes = stackalloc byte[8];
            BinaryPrimitives.WriteInt64BigEndian(bytes, value);
            _hash.AppendData(bytes);
        }

        public string Finish() => Convert.ToHexStringLower(_hash.GetHashAndReset());
        public void Dispose() => _hash.Dispose();
    }
}
