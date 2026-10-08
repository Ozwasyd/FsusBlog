using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Fixed, content-free candidate validation outcome; never an authorization receipt.</summary>
public readonly record struct ArticlePackagePropertyMappingResult(bool IsValid, string? ReasonCode);

/// <summary>
/// Pure, bounded projection of the canonical typed snapshot through explicit source-to-portable
/// bindings. It reads no stores, allocates no identities and grants no observed-source authority.
/// </summary>
public static class ArticlePackagePropertyMapper
{
    public const string ValueDigestDomain = "fsusblog.article-package.portable-property-value.v1";
    public const string MappingDigestDomain = "fsusblog.article-package.property-mapping-candidate.v1";
    private static readonly UTF8Encoding s_utf8 = new(false, true);

    /// <summary>
    /// Requires exact snapshot coordinates/digest, definition epochs and complete binding closure.
    /// Reference facts are shape-checked caller assertions, not independently observed permissions.
    /// Current definition policy and authorized persisted snapshot reads remain canonical-owner gates.
    /// </summary>
    public static ArticlePackagePropertyMappingResult TryMapCandidate(
        ArticlePropertyValueSnapshot? snapshot,
        ArticlePackagePropertyMappingBindings? bindings,
        out ArticlePackagePropertyMappingCandidate? candidate)
    {
        candidate = null;
        if (snapshot is null || bindings is null)
        {
            return Invalid("article_package_property_mapping_input_invalid");
        }
        if (!WithinBudgets(snapshot))
        {
            return Invalid("article_package_property_mapping_budget_exceeded");
        }
        try
        {
            ArticlePropertyValueValidator.ValidateSnapshotCandidate(snapshot);
            if (bindings.SourceCoordinates != snapshot.Coordinates
                || !string.Equals(bindings.SourceSnapshotDigest, snapshot.ContentDigest, StringComparison.Ordinal))
            {
                return Invalid("article_package_property_mapping_source_mismatch");
            }
            var definitions = new Dictionary<Guid, ArticlePackagePropertyDefinitionBinding>();
            var options = new Dictionary<(Guid Definition, Guid Option), ArticlePackagePropertyOptionBinding>();
            var articles = new Dictionary<long, ArticlePackagePropertyArticleBinding>();
            var portableDefinitions = new HashSet<ArticlePackageIdentity>();
            var portableOptions = new HashSet<ArticlePackageIdentity>();
            var portableArticles = new HashSet<ArticlePackageIdentity>();
            foreach (ArticlePackagePropertyDefinitionBinding binding in bindings.Definitions)
            {
                if (binding.SourceDefinitionId == Guid.Empty || binding.SourceSchemaRevision <= 0
                    || !IsIdentity(binding.PortableDefinition, ArticlePackageIdentityKind.Definition)
                    || !definitions.TryAdd(binding.SourceDefinitionId, binding)
                    || !portableDefinitions.Add(binding.PortableDefinition))
                {
                    return Invalid("article_package_property_mapping_definition_invalid");
                }
            }
            foreach (ArticlePackagePropertyOptionBinding binding in bindings.Options)
            {
                if (!definitions.ContainsKey(binding.SourceDefinitionId) || binding.SourceOptionId == Guid.Empty
                    || !IsIdentity(binding.PortableOption, ArticlePackageIdentityKind.Option)
                    || !options.TryAdd((binding.SourceDefinitionId, binding.SourceOptionId), binding)
                    || !portableOptions.Add(binding.PortableOption))
                {
                    return Invalid("article_package_property_mapping_option_invalid");
                }
            }
            foreach (ArticlePackagePropertyArticleBinding binding in bindings.Articles)
            {
                if (binding.SourceArticleId <= 0
                    || !IsIdentity(binding.PortableArticle, ArticlePackageIdentityKind.Article)
                    || !articles.TryAdd(binding.SourceArticleId, binding)
                    || !portableArticles.Add(binding.PortableArticle)
                    || !ArticleRelationContractValidator.Validate(binding.TargetFacts).IsValid
                    || binding.TargetFacts.TargetIdentity is not { Kind: ArticleRelationTargetKind.Article } target
                    || !string.Equals(target.ArticleIdentity, binding.PortableArticle.Value, StringComparison.Ordinal)
                    || binding.TargetFacts.Permission != ArticleRelationPermissionState.Allowed
                    || binding.TargetFacts.Lifecycle is ArticleRelationLifecycleState.Deleted or ArticleRelationLifecycleState.Archived)
                {
                    return Invalid("article_package_property_mapping_reference_invalid");
                }
            }
            var usedOptions = new HashSet<(Guid Definition, Guid Option)>();
            var usedArticles = new HashSet<long>();
            var rows = new List<ArticlePackageMappedProperty>(snapshot.Values.Count);
            foreach (ArticlePropertyValueEntry entry in snapshot.Values)
            {
                if (!definitions.TryGetValue(entry.DefinitionId, out ArticlePackagePropertyDefinitionBinding? definition)
                    || definition.SourceSchemaRevision != entry.DefinitionSchemaRevision
                    || !string.Equals(definition.SourceDefinitionDigest, entry.DefinitionDigest, StringComparison.Ordinal))
                {
                    return Invalid("article_package_property_mapping_definition_mismatch");
                }
                ArticlePackagePropertyProjection? projection;
                switch (entry.Value)
                {
                    case null:
                        projection = null;
                        break;
                    case ArticlePropertyTextValue or ArticlePropertyNumberValue or ArticlePropertyBooleanValue
                        or ArticlePropertyDateValue or ArticlePropertyUrlValue:
                        projection = new ArticlePackagePrimitivePropertyProjection(entry.Value);
                        break;
                    case ArticlePropertySingleSelectValue single:
                        if (!TryOption(entry.DefinitionId, single.OptionId, options, usedOptions, out ArticlePackageIdentity option))
                        {
                            return Invalid("article_package_property_mapping_option_missing");
                        }
                        projection = new ArticlePackageSingleOptionPropertyProjection(option);
                        break;
                    case ArticlePropertyMultiSelectValue multiple:
                        var optionIds = new List<ArticlePackageIdentity>(multiple.OptionIds.Count);
                        foreach (Guid sourceOption in multiple.OptionIds)
                        {
                            if (!TryOption(entry.DefinitionId, sourceOption, options, usedOptions, out option))
                            {
                                return Invalid("article_package_property_mapping_option_missing");
                            }
                            optionIds.Add(option);
                        }
                        projection = new ArticlePackageMultiOptionPropertyProjection(
                            optionIds.OrderBy(static identity => identity.Value, StringComparer.Ordinal).ToArray());
                        break;
                    case ArticlePropertyArticleReferenceValue references:
                        var articleIds = new List<ArticlePackageIdentity>(references.ArticleIds.Count);
                        foreach (long sourceArticle in references.ArticleIds)
                        {
                            if (!articles.TryGetValue(sourceArticle, out ArticlePackagePropertyArticleBinding? article))
                            {
                                return Invalid("article_package_property_mapping_reference_missing");
                            }
                            usedArticles.Add(sourceArticle);
                            articleIds.Add(article.PortableArticle);
                        }
                        projection = new ArticlePackageArticleReferencePropertyProjection(
                            articleIds.OrderBy(static identity => identity.Value, StringComparer.Ordinal).ToArray());
                        break;
                    default:
                        return Invalid("article_package_property_mapping_value_invalid");
                }
                string portableValueDigest = ComputeValueDigest(definition.PortableDefinition,
                    entry.Presence, entry.DefaultApplied, projection);
                rows.Add(new ArticlePackageMappedProperty(entry.DefinitionId, entry.DefinitionSchemaRevision,
                    entry.DefinitionDigest, definition.PortableDefinition, entry.ValueDigest, entry.Presence,
                    entry.DefaultApplied, portableValueDigest, projection));
            }
            if (definitions.Count != rows.Count || usedOptions.Count != options.Count || usedArticles.Count != articles.Count)
            {
                return Invalid("article_package_property_mapping_binding_closure_invalid");
            }
            ArticlePackageMappedProperty[] orderedRows = rows.OrderBy(static row => row.PortableDefinition.Value,
                StringComparer.Ordinal).ToArray();
            candidate = new ArticlePackagePropertyMappingCandidate(snapshot.Coordinates, snapshot.ContentDigest,
                orderedRows, ComputeMappingDigest(bindings, orderedRows));
            return Valid();
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_property_mapping_value_invalid");
        }
    }

    /// <summary>Recomputes bindings and every projected field; a copied digest cannot hide altered rows.</summary>
    public static ArticlePackagePropertyMappingResult ValidateCandidate(
        ArticlePropertyValueSnapshot? snapshot,
        ArticlePackagePropertyMappingBindings? bindings,
        ArticlePackagePropertyMappingCandidate? candidate)
    {
        ArticlePackagePropertyMappingResult result = TryMapCandidate(snapshot, bindings, out ArticlePackagePropertyMappingCandidate? expected);
        if (!result.IsValid)
        {
            return result;
        }
        if (candidate is null || candidate.SchemaVersion != expected!.SchemaVersion
            || candidate.SourceCoordinates != expected.SourceCoordinates
            || !string.Equals(candidate.SourceSnapshotDigest, expected.SourceSnapshotDigest, StringComparison.Ordinal)
            || candidate.Properties.Count != expected.Properties.Count
            || !string.Equals(candidate.MappingDigest, expected.MappingDigest, StringComparison.Ordinal)
            || !WithinProjectionBudgets(candidate.Properties))
        {
            return Invalid("article_package_property_mapping_candidate_invalid");
        }
        try
        {
            return string.Equals(ComputeMappingDigest(bindings!, candidate.Properties), expected.MappingDigest, StringComparison.Ordinal)
                ? Valid() : Invalid("article_package_property_mapping_candidate_invalid");
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_property_mapping_candidate_invalid");
        }
    }

    private static bool WithinBudgets(ArticlePropertyValueSnapshot snapshot)
    {
        if (snapshot.Values.Count > ArticlePackagePropertyMappingLimits.MaxDefinitions)
        {
            return false;
        }
        int projectedIds = 0;
        foreach (ArticlePropertyValueEntry entry in snapshot.Values)
        {
            if (entry is null)
            {
                return false;
            }
            switch (entry.Value)
            {
                case ArticlePropertyTextValue text when text.Text is null || text.Text.Length > ArticlePropertyDefinitionContract.MaxStringConstraintLength:
                case ArticlePropertyUrlValue url when url.Url is null || url.Url.Length > ArticlePropertyDefinitionContract.MaxUrlLength:
                    return false;
                case ArticlePropertySingleSelectValue single:
                    if (single.OptionId == Guid.Empty)
                    {
                        return false;
                    }
                    projectedIds++;
                    break;
                case ArticlePropertyMultiSelectValue multiple:
                    if (multiple.OptionIds.Count > ArticlePackagePropertyMappingLimits.MaxOptionsPerValue
                        || multiple.OptionIds.Any(static id => id == Guid.Empty)
                        || multiple.OptionIds.Distinct().Count() != multiple.OptionIds.Count)
                    {
                        return false;
                    }
                    projectedIds += multiple.OptionIds.Count;
                    break;
                case ArticlePropertyArticleReferenceValue references:
                    if (references.ArticleIds.Count > ArticlePackagePropertyMappingLimits.MaxReferencesPerValue
                        || references.ArticleIds.Any(static id => id <= 0)
                        || references.ArticleIds.Distinct().Count() != references.ArticleIds.Count)
                    {
                        return false;
                    }
                    projectedIds += references.ArticleIds.Count;
                    break;
            }
            if (projectedIds > ArticlePackagePropertyMappingLimits.MaxProjectedIdentities)
            {
                return false;
            }
        }
        return true;
    }

    private static bool WithinProjectionBudgets(IReadOnlyList<ArticlePackageMappedProperty> rows)
    {
        int projectedIds = 0;
        foreach (ArticlePackageMappedProperty row in rows)
        {
            switch (row.Projection)
            {
                case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyTextValue text }
                    when text.Text is null || text.Text.Length > ArticlePropertyDefinitionContract.MaxStringConstraintLength:
                case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyUrlValue url }
                    when url.Url is null || url.Url.Length > ArticlePropertyDefinitionContract.MaxUrlLength:
                    return false;
                case ArticlePackageSingleOptionPropertyProjection:
                    projectedIds++;
                    break;
                case ArticlePackageMultiOptionPropertyProjection options:
                    projectedIds += options.Options.Count;
                    break;
                case ArticlePackageArticleReferencePropertyProjection articles:
                    projectedIds += articles.Articles.Count;
                    break;
            }
            if (projectedIds > ArticlePackagePropertyMappingLimits.MaxProjectedIdentities)
            {
                return false;
            }
        }
        return true;
    }

    private static bool TryOption(Guid definition, Guid option,
        Dictionary<(Guid Definition, Guid Option), ArticlePackagePropertyOptionBinding> options,
        HashSet<(Guid Definition, Guid Option)> used, out ArticlePackageIdentity portable)
    {
        if (options.TryGetValue((definition, option), out ArticlePackagePropertyOptionBinding? binding))
        {
            used.Add((definition, option));
            portable = binding.PortableOption;
            return true;
        }
        portable = default;
        return false;
    }

    private static bool IsIdentity(ArticlePackageIdentity identity, ArticlePackageIdentityKind kind)
        => identity.Kind == kind && ArticlePackageIdentity.TryCreate(kind, identity.Value, out ArticlePackageIdentity parsed).IsValid
            && identity == parsed;

    private static string ComputeValueDigest(ArticlePackageIdentity definition, ArticlePropertyValuePresence presence,
        bool defaultApplied, ArticlePackagePropertyProjection? projection)
    {
        using var writer = new DigestWriter();
        writer.Add(ValueDigestDomain);
        writer.Add(definition.Value!);
        writer.Add((int)presence);
        writer.Add(defaultApplied ? 1 : 0);
        AddProjection(writer, projection);
        return writer.Finish();
    }

    private static string ComputeMappingDigest(ArticlePackagePropertyMappingBindings bindings,
        IReadOnlyList<ArticlePackageMappedProperty> rows)
    {
        using var writer = new DigestWriter();
        writer.Add(MappingDigestDomain);
        writer.Add(1);
        ArticlePropertySnapshotCoordinates coordinates = bindings.SourceCoordinates;
        writer.Add(coordinates.DefinitionOwnerUserId);
        writer.Add(coordinates.SiteScope);
        writer.Add(coordinates.ArticleId);
        writer.Add(coordinates.PropertyRevision);
        writer.Add(coordinates.ArticleRevisionId);
        writer.Add(coordinates.DraftId);
        writer.Add(coordinates.DraftServerRevision);
        writer.Add(coordinates.PublicationId);
        writer.Add(bindings.SourceSnapshotDigest);
        writer.Add(bindings.Options.Count);
        foreach (ArticlePackagePropertyOptionBinding option in bindings.Options.OrderBy(static binding => binding.PortableOption.Value, StringComparer.Ordinal))
        {
            writer.Add(option.SourceDefinitionId.ToString("D"));
            writer.Add(option.SourceOptionId.ToString("D"));
            writer.Add(option.PortableOption.Value!);
        }
        writer.Add(bindings.Articles.Count);
        foreach (ArticlePackagePropertyArticleBinding article in bindings.Articles.OrderBy(static binding => binding.PortableArticle.Value, StringComparer.Ordinal))
        {
            writer.Add(article.SourceArticleId);
            writer.Add(article.PortableArticle.Value!);
            writer.Add(article.TargetFacts.RevisionIdentity!);
            writer.Add(article.TargetFacts.RevisionNumber);
            writer.Add((int)article.TargetFacts.RevisionKind!);
            writer.Add((int)article.TargetFacts.Lifecycle!);
            writer.Add((int)article.TargetFacts.Permission);
        }
        writer.Add(rows.Count);
        foreach (ArticlePackageMappedProperty row in rows)
        {
            writer.Add(row.SourceDefinitionId.ToString("D"));
            writer.Add(row.SourceSchemaRevision);
            writer.Add(row.SourceDefinitionDigest);
            writer.Add(row.PortableDefinition.Value!);
            writer.Add(row.SourceValueDigest);
            writer.Add((int)row.Presence);
            writer.Add(row.DefaultApplied ? 1 : 0);
            writer.Add(row.PortableValueDigest);
            AddProjection(writer, row.Projection);
        }
        return writer.Finish();
    }

    private static void AddProjection(DigestWriter writer, ArticlePackagePropertyProjection? projection)
    {
        switch (projection)
        {
            case null:
                writer.Add("absent-payload");
                break;
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyTextValue text }:
                writer.Add("text");
                writer.Add(text.Text);
                break;
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyNumberValue number }:
                writer.Add("number");
                writer.Add(number.Number.ToString("0.############################", CultureInfo.InvariantCulture));
                break;
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyBooleanValue boolean }:
                writer.Add("boolean");
                writer.Add(boolean.Boolean ? 1 : 0);
                break;
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyDateValue date } when date.Utc.Kind == DateTimeKind.Utc:
                writer.Add("date");
                writer.Add(date.Utc.Ticks);
                break;
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyUrlValue url }:
                writer.Add("url");
                writer.Add(url.Url);
                break;
            case ArticlePackageSingleOptionPropertyProjection single:
                writer.Add("single-select");
                writer.Add(single.Option.Value!);
                break;
            case ArticlePackageMultiOptionPropertyProjection multiple:
                writer.Add("multi-select");
                writer.Add(multiple.Options.Count);
                foreach (ArticlePackageIdentity option in multiple.Options)
                {
                    writer.Add(option.Value!);
                }
                break;
            case ArticlePackageArticleReferencePropertyProjection references:
                writer.Add("article-reference");
                writer.Add(references.Articles.Count);
                foreach (ArticlePackageIdentity article in references.Articles)
                {
                    writer.Add(article.Value!);
                }
                break;
            default:
                throw new ArgumentException("article_package_property_mapping_projection_invalid");
        }
    }

    private static ArticlePackagePropertyMappingResult Valid()
        => new(true, null);

    private static ArticlePackagePropertyMappingResult Invalid(string reason)
        => new(false, reason);

    private sealed class DigestWriter : IDisposable
    {
        private readonly IncrementalHash _hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);

        public void Add(string value)
        {
            ArgumentNullException.ThrowIfNull(value);
            byte[] bytes = s_utf8.GetBytes(value);
            Add(bytes.Length);
            _hash.AppendData(bytes);
        }

        public void Add(int value)
        {
            Span<byte> bytes = stackalloc byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(bytes, value);
            _hash.AppendData(bytes);
        }

        public void Add(long value)
        {
            Span<byte> bytes = stackalloc byte[8];
            BinaryPrimitives.WriteInt64LittleEndian(bytes, value);
            _hash.AppendData(bytes);
        }

        public void Add(long? value)
        {
            Add(value.HasValue ? 1 : 0);
            if (value.HasValue)
            {
                Add(value.Value);
            }
        }

        public string Finish()
            => Convert.ToHexStringLower(_hash.GetHashAndReset());

        public void Dispose()
            => _hash.Dispose();
    }
}
