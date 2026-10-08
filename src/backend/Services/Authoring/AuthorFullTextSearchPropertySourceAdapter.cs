using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Held source inputs from the sole persisted value reader. Original snapshot/factset/audit
/// identities are preserved; this is neither a new snapshot authority nor an admission receipt.
/// Definition-bound field extraction remains with the property projection consumer.
/// </summary>
public sealed record AuthorSearchCurrentPropertySource(
    long ActorAdminPrincipalId, ArticlePropertyDefinitionOwner Owner,
    ArticlePropertyValuePersistedSnapshot Persisted,
    ImmutableSortedDictionary<Guid, ArticlePropertyDefinition> Definitions,
    ImmutableSortedDictionary<Guid, ArticlePropertyValueEntry> EligibleValues);

/// <summary>
/// Single-current-article intake for the original canonical source adapter. ReadAsync already
/// authorizes and verifies persisted facts in the article owner's transaction. No parser,
/// property normalizer, writer, query, source-coordinate map or registration is introduced.
/// The upstream port has no batch read: this adapter must not be looped inside a corpus-page
/// reader to disguise N+1 queries. A real batch source authority is required for full rebuild.
/// </summary>
public sealed class AuthorFullTextSearchPropertySourceAdapter(IArticlePropertyValueAuthority values)
{
    public async Task<AuthorSearchCurrentPropertySource> ReadCurrentAsync(
        long actorAdminPrincipalId, ArticlePropertyDefinitionOwner owner, int articleId,
        long expectedArticleRevisionId, long? expectedPropertyRevision = null,
        CancellationToken cancellationToken = default)
    {
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        if (actorAdminPrincipalId <= 0 || articleId <= 0 || expectedArticleRevisionId <= 0
            || expectedPropertyRevision is <= 0)
        {
            throw new AuthorSearchContractException("author_search_property_read_coordinate_invalid");
        }
        cancellationToken.ThrowIfCancellationRequested();
        ArticlePropertyValueReadModel model = await values.ReadAsync(actorAdminPrincipalId, owner,
            articleId, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (model is null || model.Definitions is null || model.Reconciliation is null)
        {
            throw new AuthorSearchContractException("author_search_property_source_shape_invalid");
        }
        ArticlePropertyValuePersistedSnapshot persisted = model.Current
            ?? throw new AuthorSearchContractException("author_search_property_snapshot_unavailable");
        if (persisted.Snapshot is null)
        {
            throw new AuthorSearchContractException("author_search_property_source_shape_invalid");
        }
        ArticlePropertySnapshotCoordinates coordinate = persisted.Snapshot.Coordinates;
        if (model.ArticleId != articleId || model.ArticleRevisionId != expectedArticleRevisionId
            || model.PropertyRevision <= 0 || expectedPropertyRevision.HasValue
                && model.PropertyRevision != expectedPropertyRevision.Value
            || coordinate.ArticleId != articleId || coordinate.ArticleRevisionId != model.ArticleRevisionId
            || coordinate.PropertyRevision != model.PropertyRevision
            || coordinate.DefinitionOwnerUserId != owner.UserId || coordinate.SiteScope != owner.SiteScope
            || coordinate.DraftId.HasValue || coordinate.DraftServerRevision.HasValue
            || persisted.SnapshotId == Guid.Empty || persisted.FactsetId == Guid.Empty
            || persisted.AuditReference != persisted.SnapshotId
            || string.IsNullOrWhiteSpace(persisted.AuditChainId) || persisted.AuditChainId.Length > 1_024
            || !ArticlePropertyValueMutationContract.IsDigest(persisted.AuditRecordHash))
        {
            throw new AuthorSearchContractException("author_search_property_snapshot_binding_stale_or_invalid");
        }
        if (model.Definitions.Count > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner
            || persisted.Snapshot.Values.Count > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner
            || model.Reconciliation.Count > 2 * ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner)
        {
            throw new AuthorSearchContractException("author_search_property_source_budget_exceeded");
        }
        long bytes = 0;
        var definitions = ImmutableSortedDictionary.CreateBuilder<Guid, ArticlePropertyDefinition>();
        foreach (ArticlePropertyDefinition definition in model.Definitions)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticlePropertyDefinitionContract.ValidateDefinition(definition);
            if (definition.Owner != owner || !definitions.TryAdd(definition.DefinitionId, HoldDefinition(definition)))
            {
                throw new AuthorSearchContractException("author_search_property_definition_binding_invalid");
            }
            bytes += ArticlePropertyDefinitionContract.ComputeDefinitionBytes(definition);
            RequireBudget(bytes);
        }
        var reconciliation = new HashSet<Guid>();
        foreach (ArticlePropertyValueReconciliation fact in model.Reconciliation)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!reconciliation.Add(fact.DefinitionId) || fact.Status != ArticlePropertyValueReconciliationStatus.Current)
            {
                throw new AuthorSearchContractException("author_search_property_reconciliation_required");
            }
        }
        var held = ImmutableArray.CreateBuilder<ArticlePropertyValueEntry>(persisted.Snapshot.Values.Count);
        var eligible = ImmutableSortedDictionary.CreateBuilder<Guid, ArticlePropertyValueEntry>();
        foreach (ArticlePropertyValueEntry entry in persisted.Snapshot.Values)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!reconciliation.Remove(entry.DefinitionId)
                || !definitions.TryGetValue(entry.DefinitionId, out ArticlePropertyDefinition? definition)
                || definition.Status != ArticlePropertyDefinitionStatus.Active
                || definition.SchemaRevision != entry.DefinitionSchemaRevision
                || definition.ContentDigest != entry.DefinitionDigest)
            {
                throw new AuthorSearchContractException("author_search_property_value_definition_stale");
            }
            bytes += 512 + ValueBytes(entry.Value);
            RequireBudget(bytes);
            ArticlePropertyValueEntry value = entry with
            {
                Value = HoldValue(entry.Value, definition.ValueType)
            };
            held.Add(value);
            if (definition.SearchEligible)
            {
                eligible.Add(value.DefinitionId, value);
            }
        }
        if (reconciliation.Count != 0)
        {
            throw new AuthorSearchContractException("author_search_property_reconciliation_required");
        }
        var snapshot = new ArticlePropertyValueSnapshot(persisted.Snapshot.SchemaVersion,
            coordinate, held.MoveToImmutable(), persisted.Snapshot.ContentDigest);
        ArticlePropertyValueValidator.ValidateSnapshotCandidate(snapshot);
        cancellationToken.ThrowIfCancellationRequested();
        return new(actorAdminPrincipalId, owner, persisted with
        {
            Snapshot = snapshot
        },
            definitions.ToImmutable(), eligible.ToImmutable());
    }

    private static void RequireBudget(long bytes)
    {
        if (bytes > ArticlePropertyDefinitionContract.MaxVerificationResourceBytes)
        {
            throw new AuthorSearchContractException("author_search_property_source_budget_exceeded");
        }
    }

    private static long ValueBytes(ArticlePropertyTypedValue? value)
        => value switch
        {
            ArticlePropertyTextValue text when text.Text.Length <= ArticlePropertyDefinitionContract.MaxStringConstraintLength
                => 2L * text.Text.Length,
            ArticlePropertyUrlValue url when url.Url.Length <= ArticlePropertyDefinitionContract.MaxUrlLength
                => 2L * url.Url.Length,
            ArticlePropertyMultiSelectValue options when options.OptionIds.Count <= ArticlePropertyDefinitionContract.MaxOptionsPerDefinition
                => 32L * options.OptionIds.Count,
            ArticlePropertyArticleReferenceValue references when references.ArticleIds.Count <= ArticlePropertyDefinitionContract.MaxReferenceIdsPerDefault
                => 32L * references.ArticleIds.Count,
            null or ArticlePropertyNumberValue or ArticlePropertyBooleanValue or ArticlePropertyDateValue or ArticlePropertySingleSelectValue => 64,
            _ => throw new AuthorSearchContractException("author_search_property_source_budget_exceeded")
        };

    // Closed transport-shape join only. Values remain typed and unchanged; definition-owned
    // normalization/constraint/default and persisted authentication are not reimplemented.
    private static ArticlePropertyTypedValue? HoldValue(ArticlePropertyTypedValue? value, ArticlePropertyValueType type)
        => value switch
        {
            null => null,
            ArticlePropertyTextValue when type == ArticlePropertyValueType.Text => value,
            ArticlePropertyNumberValue when type == ArticlePropertyValueType.Number => value,
            ArticlePropertyBooleanValue when type == ArticlePropertyValueType.Boolean => value,
            ArticlePropertyDateValue when type == ArticlePropertyValueType.Date => value,
            ArticlePropertySingleSelectValue when type == ArticlePropertyValueType.SingleSelect => value,
            ArticlePropertyUrlValue when type == ArticlePropertyValueType.Url => value,
            ArticlePropertyMultiSelectValue options when type == ArticlePropertyValueType.MultiSelect
                => new ArticlePropertyMultiSelectValue(options.OptionIds),
            ArticlePropertyArticleReferenceValue references when type == ArticlePropertyValueType.ArticleReference
                && references.ArticleIds.Count == 0 => new ArticlePropertyArticleReferenceValue([]),
            ArticlePropertyArticleReferenceValue => throw new AuthorSearchContractException("author_search_property_reference_authority_unavailable"),
            _ => throw new AuthorSearchContractException("author_search_property_typed_shape_mismatch")
        };

    private static ArticlePropertyDefinition HoldDefinition(ArticlePropertyDefinition definition)
        => definition with
        {
            DisplayNames = definition.DisplayNames.ToImmutableArray(),
            Options = definition.Options.Select(option => option with
            {
                LocalizedLabels = option.LocalizedLabels.ToImmutableArray()
            }).ToImmutableArray(),
            DefaultValue = definition.DefaultValue is not null ? definition.DefaultValue with
            {
                OptionIds = definition.DefaultValue.OptionIds.ToImmutableArray(),
                ArticleIds = definition.DefaultValue.ArticleIds.ToImmutableArray()
            } : null,
            UrlPolicy = definition.UrlPolicy is not null ? definition.UrlPolicy with
            {
                AllowedSchemes = definition.UrlPolicy.AllowedSchemes.ToImmutableArray()
            } : null
        };
}
