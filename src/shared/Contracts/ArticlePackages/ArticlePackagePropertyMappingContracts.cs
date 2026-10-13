using System.Diagnostics.CodeAnalysis;

using FsusBlog.Shared.Contracts.ArticleProperties;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>
/// Bounds owned package-mapping copies, not the canonical definition catalog. The per-value and
/// definition limits align with the canonical owner; aggregate limits belong only to this component.
/// </summary>
public static class ArticlePackagePropertyMappingLimits
{
    public const int MaxDefinitions = 1000;
    public const int MaxOptionsPerValue = 1000;
    public const int MaxReferencesPerValue = 1000;
    public const int MaxOptionBindings = 20000;
    public const int MaxArticleBindings = 10000;
    public const int MaxProjectedIdentities = 20000;
}

/// <summary>Explicit source-definition binding; syntax and coordinates do not establish authority.</summary>
public sealed class ArticlePackagePropertyDefinitionBinding
{
    public ArticlePackagePropertyDefinitionBinding(
        Guid sourceDefinitionId,
        long sourceSchemaRevision,
        string sourceDefinitionDigest,
        ArticlePackageIdentity portableDefinition)
    {
        ArticlePackagePropertyMappingShape.Require(sourceDefinitionId != Guid.Empty && sourceSchemaRevision > 0);
        ArticlePackagePropertyMappingShape.RequireDigest(sourceDefinitionDigest);
        ArticlePackagePropertyMappingShape.RequireIdentity(portableDefinition, ArticlePackageIdentityKind.Definition);
        SourceDefinitionId = sourceDefinitionId;
        SourceSchemaRevision = sourceSchemaRevision;
        SourceDefinitionDigest = sourceDefinitionDigest;
        PortableDefinition = portableDefinition;
    }

    public Guid SourceDefinitionId
    {
        get;
    }
    public long SourceSchemaRevision
    {
        get;
    }
    public string SourceDefinitionDigest
    {
        get;
    }
    public ArticlePackageIdentity PortableDefinition
    {
        get;
    }
}

/// <summary>Option identities remain definition-scoped; labels and array positions are absent.</summary>
public sealed class ArticlePackagePropertyOptionBinding
{
    public ArticlePackagePropertyOptionBinding(
        Guid sourceDefinitionId,
        Guid sourceOptionId,
        ArticlePackageIdentity portableOption)
    {
        ArticlePackagePropertyMappingShape.Require(sourceDefinitionId != Guid.Empty && sourceOptionId != Guid.Empty);
        ArticlePackagePropertyMappingShape.RequireIdentity(portableOption, ArticlePackageIdentityKind.Option);
        SourceDefinitionId = sourceDefinitionId;
        SourceOptionId = sourceOptionId;
        PortableOption = portableOption;
    }

    public Guid SourceDefinitionId
    {
        get;
    }
    public Guid SourceOptionId
    {
        get;
    }
    public ArticlePackageIdentity PortableOption
    {
        get;
    }
}

/// <summary>
/// Keeps the explicit source article and canonical target facts supplied by their owner. No revision,
/// lifecycle or permission fact is synthesized; the mapper must validate the actual facts separately.
/// </summary>
public sealed class ArticlePackagePropertyArticleBinding
{
    public ArticlePackagePropertyArticleBinding(
        long sourceArticleId,
        ArticlePackageIdentity portableArticle,
        ArticleRelationTargetFacts targetFacts)
    {
        ArticlePackagePropertyMappingShape.Require(sourceArticleId > 0 && targetFacts is not null);
        ArticlePackagePropertyMappingShape.RequireIdentity(portableArticle, ArticlePackageIdentityKind.Article);
        SourceArticleId = sourceArticleId;
        PortableArticle = portableArticle;
        TargetFacts = targetFacts;
    }

    public long SourceArticleId
    {
        get;
    }
    public ArticlePackageIdentity PortableArticle
    {
        get;
    }
    public ArticleRelationTargetFacts TargetFacts
    {
        get;
    }
}

/// <summary>
/// Owned immutable binding lists scoped to one exact snapshot candidate. Construction validates
/// only structure and copy budgets; association, duplicate, coordinate and digest checks belong to
/// the canonical mapper and grant no persistence or current authorization.
/// </summary>
public sealed class ArticlePackagePropertyMappingBindings
{
    public ArticlePackagePropertyMappingBindings(
        ArticlePropertySnapshotCoordinates sourceCoordinates,
        string sourceSnapshotDigest,
        IReadOnlyList<ArticlePackagePropertyDefinitionBinding> definitions,
        IReadOnlyList<ArticlePackagePropertyOptionBinding> options,
        IReadOnlyList<ArticlePackagePropertyArticleBinding> articles)
    {
        ArticlePackagePropertyMappingShape.Require(sourceCoordinates is not null);
        ArticlePackagePropertyMappingShape.RequireDigest(sourceSnapshotDigest);
        SourceCoordinates = sourceCoordinates;
        SourceSnapshotDigest = sourceSnapshotDigest;
        Definitions = ArticlePackagePropertyMappingShape.CopyBounded(definitions, ArticlePackagePropertyMappingLimits.MaxDefinitions);
        Options = ArticlePackagePropertyMappingShape.CopyBounded(options, ArticlePackagePropertyMappingLimits.MaxOptionBindings);
        Articles = ArticlePackagePropertyMappingShape.CopyBounded(articles, ArticlePackagePropertyMappingLimits.MaxArticleBindings);
    }

    public ArticlePropertySnapshotCoordinates SourceCoordinates
    {
        get;
    }
    public string SourceSnapshotDigest
    {
        get;
    }
    public IReadOnlyList<ArticlePackagePropertyDefinitionBinding> Definitions
    {
        get;
    }
    public IReadOnlyList<ArticlePackagePropertyOptionBinding> Options
    {
        get;
    }
    public IReadOnlyList<ArticlePackagePropertyArticleBinding> Articles
    {
        get;
    }
}

/// <summary>Closed portable property projections; the canonical property owner still owns value types.</summary>
public abstract class ArticlePackagePropertyProjection
{
    private protected ArticlePackagePropertyProjection()
    {
    }
}

/// <summary>Retains a canonical text, number, boolean, UTC date or URL payload without conversion.</summary>
public sealed class ArticlePackagePrimitivePropertyProjection : ArticlePackagePropertyProjection
{
    public ArticlePackagePrimitivePropertyProjection(ArticlePropertyTypedValue value)
    {
        bool validShape = value switch
        {
            ArticlePropertyTextValue text => text.Text is not null,
            ArticlePropertyNumberValue => true,
            ArticlePropertyBooleanValue => true,
            ArticlePropertyDateValue date => date.Utc.Kind == DateTimeKind.Utc,
            ArticlePropertyUrlValue url => url.Url is not null,
            _ => false
        };
        ArticlePackagePropertyMappingShape.Require(validShape);
        Value = value;
    }

    public ArticlePropertyTypedValue Value
    {
        get;
    }
}

/// <summary>One explicitly mapped portable option, never a source ID or label.</summary>
public sealed class ArticlePackageSingleOptionPropertyProjection : ArticlePackagePropertyProjection
{
    public ArticlePackageSingleOptionPropertyProjection(ArticlePackageIdentity option)
    {
        ArticlePackagePropertyMappingShape.RequireIdentity(option, ArticlePackageIdentityKind.Option);
        Option = option;
    }

    public ArticlePackageIdentity Option
    {
        get;
    }
}

/// <summary>Owned bounded portable-option list; the mapper establishes association, uniqueness and order.</summary>
public sealed class ArticlePackageMultiOptionPropertyProjection : ArticlePackagePropertyProjection
{
    public ArticlePackageMultiOptionPropertyProjection(IReadOnlyList<ArticlePackageIdentity> options)
    {
        Options = ArticlePackagePropertyMappingShape.CopyBounded(options, ArticlePackagePropertyMappingLimits.MaxOptionsPerValue);
        foreach (ArticlePackageIdentity option in Options)
        {
            ArticlePackagePropertyMappingShape.RequireIdentity(option, ArticlePackageIdentityKind.Option);
        }
    }

    public IReadOnlyList<ArticlePackageIdentity> Options
    {
        get;
    }
}

/// <summary>
/// Owned bounded portable-article list. Reference rights and frozen coordinates remain the canonical
/// target-facts authority's responsibility and must not be inferred from a portable identity.
/// </summary>
public sealed class ArticlePackageArticleReferencePropertyProjection : ArticlePackagePropertyProjection
{
    public ArticlePackageArticleReferencePropertyProjection(IReadOnlyList<ArticlePackageIdentity> articles)
    {
        Articles = ArticlePackagePropertyMappingShape.CopyBounded(articles, ArticlePackagePropertyMappingLimits.MaxReferencesPerValue);
        foreach (ArticlePackageIdentity article in Articles)
        {
            ArticlePackagePropertyMappingShape.RequireIdentity(article, ArticlePackageIdentityKind.Article);
        }
    }

    public IReadOnlyList<ArticlePackageIdentity> Articles
    {
        get;
    }
}

/// <summary>
/// Binds a portable projection to source definition/value digests and normalization provenance.
/// Presence and DefaultApplied remain separate; absent values carry no projection payload.
/// </summary>
public sealed class ArticlePackageMappedProperty
{
    public ArticlePackageMappedProperty(
        Guid sourceDefinitionId,
        long sourceSchemaRevision,
        string sourceDefinitionDigest,
        ArticlePackageIdentity portableDefinition,
        string sourceValueDigest,
        ArticlePropertyValuePresence presence,
        bool defaultApplied,
        string portableValueDigest,
        ArticlePackagePropertyProjection? projection)
    {
        ArticlePackagePropertyMappingShape.Require(sourceDefinitionId != Guid.Empty && sourceSchemaRevision > 0);
        ArticlePackagePropertyMappingShape.RequireDigest(sourceDefinitionDigest);
        ArticlePackagePropertyMappingShape.RequireDigest(sourceValueDigest);
        ArticlePackagePropertyMappingShape.RequireDigest(portableValueDigest);
        ArticlePackagePropertyMappingShape.RequireIdentity(portableDefinition, ArticlePackageIdentityKind.Definition);
        ArticlePackagePropertyMappingShape.Require(Enum.IsDefined(presence)
            && (presence == ArticlePropertyValuePresence.Present) == (projection is not null)
            && !(defaultApplied && presence == ArticlePropertyValuePresence.Missing));
        SourceDefinitionId = sourceDefinitionId;
        SourceSchemaRevision = sourceSchemaRevision;
        SourceDefinitionDigest = sourceDefinitionDigest;
        PortableDefinition = portableDefinition;
        SourceValueDigest = sourceValueDigest;
        Presence = presence;
        DefaultApplied = defaultApplied;
        PortableValueDigest = portableValueDigest;
        Projection = projection;
    }

    public Guid SourceDefinitionId
    {
        get;
    }
    public long SourceSchemaRevision
    {
        get;
    }
    public string SourceDefinitionDigest
    {
        get;
    }
    public ArticlePackageIdentity PortableDefinition
    {
        get;
    }
    public string SourceValueDigest
    {
        get;
    }
    public ArticlePropertyValuePresence Presence
    {
        get;
    }
    public bool DefaultApplied
    {
        get;
    }
    public string PortableValueDigest
    {
        get;
    }
    public ArticlePackagePropertyProjection? Projection
    {
        get;
    }
}

/// <summary>
/// Immutable property-subset candidate only. Schema and digests establish neither a complete
/// manifest/privacy contract nor persistence, authorization or canonical writer acceptance.
/// </summary>
public sealed class ArticlePackagePropertyMappingCandidate
{
    public const int CurrentSchemaVersion = 1;

    public ArticlePackagePropertyMappingCandidate(
        ArticlePropertySnapshotCoordinates sourceCoordinates,
        string sourceSnapshotDigest,
        IReadOnlyList<ArticlePackageMappedProperty> properties,
        string mappingDigest)
    {
        ArticlePackagePropertyMappingShape.Require(sourceCoordinates is not null);
        ArticlePackagePropertyMappingShape.RequireDigest(sourceSnapshotDigest);
        ArticlePackagePropertyMappingShape.RequireDigest(mappingDigest);
        SourceCoordinates = sourceCoordinates;
        SourceSnapshotDigest = sourceSnapshotDigest;
        Properties = ArticlePackagePropertyMappingShape.CopyBounded(properties, ArticlePackagePropertyMappingLimits.MaxDefinitions);
        MappingDigest = mappingDigest;
    }

    public int SchemaVersion => CurrentSchemaVersion;

    public ArticlePropertySnapshotCoordinates SourceCoordinates
    {
        get;
    }
    public string SourceSnapshotDigest
    {
        get;
    }
    public IReadOnlyList<ArticlePackageMappedProperty> Properties
    {
        get;
    }
    public string MappingDigest
    {
        get;
    }
}

internal static class ArticlePackagePropertyMappingShape
{
    public static void Require([DoesNotReturnIf(false)] bool condition)
    {
        if (!condition)
        {
            throw new ArgumentException("article_package_property_mapping_shape_invalid");
        }
    }

    public static void RequireDigest(string? digest)
        => Require(digest is not null && digest.Length == 64
            && digest.All(character => (character is >= '0' and <= '9') || (character is >= 'a' and <= 'f')));

    public static void RequireIdentity(ArticlePackageIdentity identity, ArticlePackageIdentityKind kind)
        => Require(identity.Kind == kind
            && ArticlePackageIdentity.TryCreate(kind, identity.Value, out _).IsValid);

    public static IReadOnlyList<T> CopyBounded<T>(IReadOnlyList<T>? source, int maximum)
    {
        if (source is null)
        {
            throw new ArgumentException("article_package_property_mapping_collection_invalid");
        }
        int count = source.Count;
        if (count < 0 || count > maximum)
        {
            throw new ArgumentException("article_package_property_mapping_collection_invalid");
        }
        var copy = new T[count];
        for (int index = 0; index < count; index++)
        {
            T item = source[index];
            if (item is null)
            {
                throw new ArgumentException("article_package_property_mapping_collection_invalid");
            }
            copy[index] = item;
        }

        return Array.AsReadOnly(copy);
    }
}
