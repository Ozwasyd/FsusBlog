using System.Globalization;

using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Current definition observation separate from the signed historical value epoch.</summary>
public sealed record ArticlePackageCurrentPropertyDefinitionObservation(
    Guid DefinitionId,
    long SchemaRevision,
    string ContentDigest,
    ArticlePropertyValueType ValueType,
    ArticlePropertyDefinitionStatus Status);

/// <summary>Backend-only observed provenance; audit data is never added to portable property JSON.</summary>
public sealed class ArticlePackageCurrentPropertyProjection
{
    internal ArticlePackageCurrentPropertyProjection(
        long actorAdminPrincipalId,
        ArticlePropertyValuePersistedSnapshot source,
        ArticlePackageManifestPropertyCandidate component,
        IReadOnlyList<ArticlePropertyValueReconciliation> reconciliation,
        IReadOnlyList<ArticlePackageCurrentPropertyDefinitionObservation> definitions)
    {
        ActorAdminPrincipalId = actorAdminPrincipalId;
        Source = source;
        Component = component;
        Reconciliation = Array.AsReadOnly(reconciliation.ToArray());
        Definitions = Array.AsReadOnly(definitions.ToArray());
    }

    public long ActorAdminPrincipalId
    {
        get;
    }
    public ArticlePropertyValuePersistedSnapshot Source
    {
        get;
    }
    public ArticlePackageManifestPropertyCandidate Component
    {
        get;
    }
    public IReadOnlyList<ArticlePropertyValueReconciliation> Reconciliation
    {
        get;
    }
    public IReadOnlyList<ArticlePackageCurrentPropertyDefinitionObservation> Definitions
    {
        get;
    }
}

/// <summary>Read/mapping status only, never export, transaction, persistence or permission admission.</summary>
public sealed record ArticlePackageCurrentPropertyReadResult(
    bool IsValid,
    string? ReasonCode,
    ArticlePackageCurrentPropertyProjection? Projection);

/// <summary>
/// Reads through the sole current article authority and maps its actual immutable rows. A second
/// authorized read detects observed drift; it is not an atomic export fence or operation grant.
/// </summary>
public sealed class ArticlePackageCurrentPropertyReader(IArticlePropertyValueAuthority authority)
{
    /// <summary>
    /// Binds explicit portable identities to the exact selected current revision, owner and snapshot.
    /// No caller snapshot or persisted receipt is accepted. Drafts and nonempty references need their
    /// original operation authorities; missing heads are never manufactured as empty snapshots.
    /// </summary>
    public async Task<ArticlePackageCurrentPropertyReadResult> ReadAndMapAsync(
        long actorAdminPrincipalId,
        ArticlePackagePropertyMappingBindings bindings,
        ArticlePackageManifestPropertyCandidate? decoded = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(bindings);
        cancellationToken.ThrowIfCancellationRequested();
        ArticlePropertySnapshotCoordinates expected = bindings.SourceCoordinates;
        if (actorAdminPrincipalId <= 0 || expected.ArticleId <= 0 || expected.ArticleRevisionId <= 0
            || expected.PropertyRevision <= 0)
        {
            return Refuse("article_package_property_read_coordinates_invalid");
        }
        if (expected.DraftId.HasValue || expected.DraftServerRevision.HasValue)
        {
            return Refuse("article_package_property_draft_read_authority_unavailable");
        }
        var owner = new ArticlePropertyDefinitionOwner(expected.DefinitionOwnerUserId, expected.SiteScope);
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        // ReadAsync performs actual current actor/session/site/article/definition authorization.
        // Exceptions (including access denial and cancellation) retain the canonical owner's semantics.
        ArticlePropertyValueReadModel observed = await authority.ReadAsync(actorAdminPrincipalId, owner,
            expected.ArticleId, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        ArticlePackageCurrentPropertyReadResult first = MapObserved(observed, actorAdminPrincipalId, owner, expected, bindings, decoded);
        if (!first.IsValid)
        {
            return first;
        }
        ArticlePropertyValueReadModel current = await authority.ReadAsync(actorAdminPrincipalId, owner,
            expected.ArticleId, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        ArticlePackageCurrentPropertyReadResult second = MapObserved(current, actorAdminPrincipalId, owner, expected, bindings, decoded);
        if (!second.IsValid)
        {
            return second;
        }
        ArticlePackageCurrentPropertyProjection before = first.Projection!;
        ArticlePackageCurrentPropertyProjection after = second.Projection!;
        if (before.Source.SnapshotId != after.Source.SnapshotId
            || before.Source.FactsetId != after.Source.FactsetId
            || before.Source.AuditReference != after.Source.AuditReference
            || before.Source.AuditChainId != after.Source.AuditChainId
            || before.Source.AuditRecordHash != after.Source.AuditRecordHash
            || before.Component.ComponentDigest != after.Component.ComponentDigest
            || !before.Reconciliation.SequenceEqual(after.Reconciliation)
            || !before.Definitions.SequenceEqual(after.Definitions))
        {
            return Refuse("article_package_property_read_drift");
        }
        return new(true, null, after);
    }

    private static ArticlePackageCurrentPropertyReadResult MapObserved(
        ArticlePropertyValueReadModel observed,
        long actorAdminPrincipalId,
        ArticlePropertyDefinitionOwner owner,
        ArticlePropertySnapshotCoordinates expected,
        ArticlePackagePropertyMappingBindings bindings,
        ArticlePackageManifestPropertyCandidate? decoded)
    {
        ArticlePropertyValuePersistedSnapshot? source = observed?.Current;
        if (observed is null || source is null || source.Snapshot is null)
        {
            return Refuse("article_package_property_persisted_head_unavailable");
        }
        if (observed.ArticleId != expected.ArticleId || observed.ArticleRevisionId != expected.ArticleRevisionId
            || observed.PropertyRevision != expected.PropertyRevision || source.Snapshot.Coordinates != expected
            || source.Snapshot.ContentDigest != bindings.SourceSnapshotDigest)
        {
            return Refuse("article_package_property_read_coordinates_mismatch");
        }
        if (source.SnapshotId == Guid.Empty || source.FactsetId == Guid.Empty || source.AuditReference != source.SnapshotId
            || !DateOnly.TryParseExact(source.AuditChainId, "yyyyMMdd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out _) || !ArticlePropertyValueMutationContract.IsDigest(source.AuditRecordHash))
        {
            return Refuse("article_package_property_persisted_provenance_invalid");
        }
        try
        {
            if (observed.Definitions is null || observed.Reconciliation is null)
            {
                return Refuse("article_package_property_definition_read_invalid");
            }
            ArticlePropertyValueValidator.ValidateSnapshotCandidate(source.Snapshot);
            ArticlePropertyDefinition[] definitions = observed.Definitions
                .Take(ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner + 1).ToArray();
            ArticlePropertyValueReconciliation[] reconciliation = observed.Reconciliation
                .Take(ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner + 1).ToArray();
            if (definitions.Length > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner
                || definitions.Any(static definition => definition is null)
                || definitions.Select(static definition => definition.DefinitionId).Distinct().Count() != definitions.Length
                || reconciliation.Length > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner
                || reconciliation.Any(static item => item is null || !Enum.IsDefined(item.Status)
                    || item.DefinitionId == Guid.Empty || string.IsNullOrWhiteSpace(item.ReasonCode))
                || reconciliation.Select(static item => item.DefinitionId).Distinct().Count() != reconciliation.Length)
            {
                return Refuse("article_package_property_definition_read_invalid");
            }
            var byId = definitions.ToDictionary(static definition => definition.DefinitionId);
            foreach (ArticlePropertyDefinition definition in definitions)
            {
                if (definition.Owner != owner)
                {
                    return Refuse("article_package_property_definition_read_mismatch");
                }
                ArticlePropertyDefinitionContract.ValidateDefinition(definition);
            }
            if (reconciliation.Any(item => !byId.ContainsKey(item.DefinitionId)))
            {
                return Refuse("article_package_property_definition_read_mismatch");
            }
            var definitionObservations = new List<ArticlePackageCurrentPropertyDefinitionObservation>();
            foreach (ArticlePropertyValueEntry row in source.Snapshot.Values)
            {
                if (!byId.TryGetValue(row.DefinitionId, out ArticlePropertyDefinition? definition)
                    || definition.Owner != owner || definition.SchemaRevision < row.DefinitionSchemaRevision
                    || definition.SchemaRevision == row.DefinitionSchemaRevision && definition.ContentDigest != row.DefinitionDigest)
                {
                    return Refuse("article_package_property_definition_read_mismatch");
                }
                if (!MatchesDefinitionType(row.Value, definition.ValueType))
                {
                    return Refuse("article_package_property_definition_type_mismatch");
                }
                definitionObservations.Add(new(definition.DefinitionId, definition.SchemaRevision,
                    definition.ContentDigest, definition.ValueType, definition.Status));
                IEnumerable<Guid> optionIds = row.Value switch
                {
                    ArticlePropertySingleSelectValue single => [single.OptionId],
                    ArticlePropertyMultiSelectValue multi => multi.OptionIds,
                    _ => []
                };
                if (optionIds.Any(id => !definition.Options.Any(option => option.OptionId == id)))
                {
                    return Refuse("article_package_property_option_read_mismatch");
                }
                // Historical inactive options are retained verbatim. Current reconciliation is
                // backend provenance, not permission to reuse/create a value at the destination.
                if (row.Value is ArticlePropertyArticleReferenceValue { ArticleIds.Count: > 0 })
                {
                    return Refuse("article_package_property_reference_operation_authority_unavailable");
                }
            }
            ArticlePackagePropertyMappingResult mapped = ArticlePackagePropertyMapper.TryMapCandidate(
                source.Snapshot, bindings, out ArticlePackagePropertyMappingCandidate? mapping);
            if (!mapped.IsValid)
            {
                return Refuse(mapped.ReasonCode!);
            }
            ArticlePackageManifestCandidateResult result = decoded is null
                ? ArticlePackageManifestCandidateCodec.TryCreatePropertyCandidate(mapping!, out var component)
                : ArticlePackageManifestPropertyBinder.TryBindCandidate(decoded, source.Snapshot, bindings, out component);
            if (!result.IsValid)
            {
                return Refuse(result.ReasonCode!);
            }
            return new(true, null, new(actorAdminPrincipalId, source, component!,
                reconciliation.OrderBy(static item => item.DefinitionId).ToArray(),
                definitionObservations.OrderBy(static item => item.DefinitionId).ToArray()));
        }
        catch (ArticlePropertyDefinitionValidationException)
        {
            return Refuse("article_package_property_definition_read_invalid");
        }
        catch (ArticlePropertyDefinitionIntegrityException)
        {
            return Refuse("article_package_property_persisted_provenance_invalid");
        }
        catch (ArgumentException)
        {
            return Refuse("article_package_property_read_shape_invalid");
        }
    }

    private static ArticlePackageCurrentPropertyReadResult Refuse(string reason)
        => new(false, reason, null);

    private static bool MatchesDefinitionType(ArticlePropertyTypedValue? value, ArticlePropertyValueType type)
        => value is null || (value, type) switch
        {
            (ArticlePropertyTextValue, ArticlePropertyValueType.Text) => true,
            (ArticlePropertyNumberValue, ArticlePropertyValueType.Number) => true,
            (ArticlePropertyBooleanValue, ArticlePropertyValueType.Boolean) => true,
            (ArticlePropertyDateValue, ArticlePropertyValueType.Date) => true,
            (ArticlePropertySingleSelectValue, ArticlePropertyValueType.SingleSelect) => true,
            (ArticlePropertyMultiSelectValue, ArticlePropertyValueType.MultiSelect) => true,
            (ArticlePropertyArticleReferenceValue, ArticlePropertyValueType.ArticleReference) => true,
            (ArticlePropertyUrlValue, ArticlePropertyValueType.Url) => true,
            _ => false
        };
}
