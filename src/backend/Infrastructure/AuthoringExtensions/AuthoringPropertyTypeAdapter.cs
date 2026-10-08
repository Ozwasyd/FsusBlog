using System.Collections.Immutable;
using System.Text.Json.Serialization;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>Presentation roles are data; no component, SQL, conversion or executable codec is accepted.</summary>
public enum AuthoringPropertyEditorRole
{
    Text = 0,
    Number = 1,
    Boolean = 2,
    Date = 3,
    SingleSelect = 4,
    MultiSelect = 5,
    ArticleReference = 6,
    Url = 7
}

/// <summary>One extension type maps to one exact canonical definition and its existing typed storage.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AuthoringPropertyTypeContribution(
    int SchemaVersion,
    string TypeId,
    string ExtensionId,
    string ExtensionVersion,
    string PackageSha256,
    string ContributionId,
    Guid DefinitionId,
    long DefinitionSchemaRevision,
    string DefinitionDigest,
    ArticlePropertyValueType StorageKind,
    AuthoringPropertyEditorRole EditorRole,
    int NormalizationVersion,
    AuthoringMigrationPolicy MigrationPolicy);

public sealed class AuthoringPropertyTypeRegistry
{
    private readonly ImmutableDictionary<string, AuthoringPropertyTypeContribution> _types;

    public AuthoringPropertyTypeRegistry(
        AuthoringExtensionRegistrySnapshot extensions,
        ImmutableArray<AuthoringPropertyTypeContribution> types)
    {
        ArgumentNullException.ThrowIfNull(extensions);
        AuthoringExtensionRegistrySnapshot verified = AuthoringExtensionContractValidator.CreateRegistry(extensions.Contracts, extensions.CoreAuthorities);
        if (verified.RegistryIdentity != extensions.RegistryIdentity)
        {
            throw Invalid();
        }
        if (types.IsDefault || types.Length > AuthoringExtensionContractValidator.MaximumContributions)
        {
            throw Invalid();
        }
        var held = ImmutableDictionary.CreateBuilder<string, AuthoringPropertyTypeContribution>(StringComparer.Ordinal);
        var definitions = new HashSet<Guid>();
        foreach (AuthoringPropertyTypeContribution type in types)
        {
            if (type is null || type.SchemaVersion != 1 || type.NormalizationVersion != 1
                || type.TypeId is not { Length: > 0 and <= 128 }
                || !type.TypeId.StartsWith(type.ExtensionId + ".", StringComparison.Ordinal)
                || type.TypeId.Any(static c => !char.IsAsciiLetterOrDigit(c) && c is not '.' and not '-' and not '_')
                || type.DefinitionId == Guid.Empty || type.DefinitionSchemaRevision <= 0
                || !ArticlePropertyValueMutationContract.IsDigest(type.DefinitionDigest)
                || !Enum.IsDefined(type.StorageKind) || !Enum.IsDefined(type.EditorRole)
                || (int)type.StorageKind != (int)type.EditorRole
                || type.MigrationPolicy != AuthoringMigrationPolicy.HostDeclarativeOnly
                || extensions.CoreAuthorities.PropertyIds.Contains(type.TypeId, StringComparer.Ordinal)
                || !definitions.Add(type.DefinitionId))
            {
                throw Invalid();
            }
            AuthoringExtensionManifest? manifest = extensions.Contracts.FirstOrDefault(contract =>
                contract.Manifest.Id == type.ExtensionId)?.Manifest;
            AuthoringContributionDeclaration? declaration = manifest?.Contributions.FirstOrDefault(item => item.Id == type.ContributionId);
            if (manifest is null || manifest.Version != type.ExtensionVersion || manifest.PackageSha256 != type.PackageSha256
                || declaration?.Kind != AuthoringContributionKind.ArticlePropertyType
                || declaration.ExecutionClass != AuthoringExecutionClass.IsolatedWorkerWasm
                || !held.TryAdd(type.TypeId, type))
            {
                throw Invalid();
            }
        }
        _types = held.ToImmutable();
    }

    public AuthoringPropertyTypeContribution Get(string typeId)
        => _types.GetValueOrDefault(typeId) ?? throw Invalid();

    private static AuthoringExtensionContractException Invalid() => new("authoring_property_type_invalid");
}

/// <summary>Owner is explicit and independent of actor; coordinates come from the host's current article.</summary>
public sealed record AuthoringPropertyReadBinding(
    string TypeId,
    long ActorAdminPrincipalId,
    ArticlePropertyDefinitionOwner Owner,
    int ArticleId,
    long ArticleRevisionId,
    long PropertyRevision,
    string RequestId,
    string RuntimeIdentity,
    long LifecycleGeneration,
    string GrantReference,
    DateTimeOffset Deadline);

/// <summary>Required production admission; a definition, digest or current actor cannot manufacture a grant.</summary>
public interface IAuthoringPropertyContributionReadAdmission
{
    bool IsCurrent(AuthoringPropertyReadBinding binding, AuthoringPropertyTypeContribution contribution);
}

/// <summary>Scoped typed projection, not a permission, persisted receipt or plugin validation verdict.</summary>
public sealed record AuthoringPropertyReadProjection(
    AuthoringPropertyReadBinding Binding,
    AuthoringPropertyTypeContribution Contribution,
    ArticlePropertyValueEntry? Value,
    ArticlePropertyValueReconciliationStatus Status,
    Guid? SnapshotId,
    Guid? FactsetId,
    string? SnapshotDigest,
    Guid? AuditReference,
    bool CoreValueCurrent);

/// <summary>Reads the sole property authority; no mutation, SQL, string fallback or implicit owner path exists.</summary>
public sealed class AuthoringPropertyTypeAdapter
{
    private readonly IArticlePropertyValueAuthority _values;
    private readonly AuthoringPropertyTypeRegistry _registry;
    private readonly IAuthoringPropertyContributionReadAdmission _admission;
    private readonly TimeProvider _time;

    public AuthoringPropertyTypeAdapter(IArticlePropertyValueAuthority values, AuthoringPropertyTypeRegistry registry,
        IAuthoringPropertyContributionReadAdmission admission, TimeProvider? time = null)
    {
        _values = values ?? throw new ArgumentNullException(nameof(values));
        _registry = registry ?? throw new ArgumentNullException(nameof(registry));
        _admission = admission ?? throw new ArgumentNullException(nameof(admission));
        _time = time ?? TimeProvider.System;
    }

    public async Task<AuthoringPropertyReadProjection> ReadAsync(AuthoringPropertyReadBinding binding,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(binding);
        ArticlePropertyDefinitionContract.ValidateOwner(binding.Owner);
        if (binding.ActorAdminPrincipalId <= 0 || binding.ArticleId <= 0 || binding.ArticleRevisionId <= 0
            || binding.PropertyRevision < 0 || binding.LifecycleGeneration < 0
            || !Identifier(binding.RequestId) || !Identifier(binding.RuntimeIdentity) || !Identifier(binding.GrantReference))
        {
            throw Invalid();
        }
        AuthoringPropertyTypeContribution type = _registry.Get(binding.TypeId);
        EnsureCurrent(binding, type, cancellationToken);
        using var timeout = new CancellationTokenSource(binding.Deadline - _time.GetUtcNow(), _time);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        ArticlePropertyValueReadModel read = await _values.ReadAsync(binding.ActorAdminPrincipalId,
            binding.Owner, binding.ArticleId, linked.Token).ConfigureAwait(false);
        EnsureCurrent(binding, type, linked.Token);
        if (read is null || read.ArticleId != binding.ArticleId || read.ArticleRevisionId != binding.ArticleRevisionId
            || read.PropertyRevision != binding.PropertyRevision || read.Definitions is null || read.Reconciliation is null
            || read.Definitions.Count > 1000 || read.Reconciliation.Count > 1000
            || read.Definitions.Any(static d => d is null)
            || read.Definitions.Select(static d => d.DefinitionId).Distinct().Count() != read.Definitions.Count
            || read.Reconciliation.Any(static r => r is null || !Enum.IsDefined(r.Status))
            || read.Reconciliation.Select(static r => r.DefinitionId).Distinct().Count() != read.Reconciliation.Count)
        {
            throw Invalid();
        }
        ArticlePropertyDefinition? definition = read.Definitions.FirstOrDefault(d => d.DefinitionId == type.DefinitionId);
        if (definition is null || definition.Owner != binding.Owner || definition.SchemaRevision != type.DefinitionSchemaRevision
            || definition.ContentDigest != type.DefinitionDigest || definition.ValueType != type.StorageKind)
        {
            throw Invalid();
        }
        ArticlePropertyDefinitionContract.ValidateDefinition(definition);
        ArticlePropertyValuePersistedSnapshot? current = read.Current;
        if (current is not null)
        {
            ArticlePropertyValueValidator.ValidateSnapshotCandidate(current.Snapshot);
            ArticlePropertySnapshotCoordinates coordinates = current.Snapshot.Coordinates;
            if (coordinates.DefinitionOwnerUserId != binding.Owner.UserId || coordinates.SiteScope != binding.Owner.SiteScope
                || coordinates.ArticleId != binding.ArticleId || coordinates.ArticleRevisionId != binding.ArticleRevisionId
                || coordinates.PropertyRevision != binding.PropertyRevision || coordinates.DraftId is not null
                || current.SnapshotId == Guid.Empty || current.FactsetId == Guid.Empty || current.AuditReference != current.SnapshotId
                || string.IsNullOrWhiteSpace(current.AuditChainId) || !ArticlePropertyValueMutationContract.IsDigest(current.AuditRecordHash))
            {
                throw Invalid();
            }
        }
        else if (read.PropertyRevision != 0)
        {
            throw Invalid();
        }
        ArticlePropertyValueEntry? entry = current?.Snapshot.Values.FirstOrDefault(v => v.DefinitionId == type.DefinitionId);
        ArticlePropertyValueReconciliation? reconciliation = read.Reconciliation.FirstOrDefault(r => r.DefinitionId == type.DefinitionId);
        if (entry is not null)
        {
            if (entry.DefinitionSchemaRevision != type.DefinitionSchemaRevision || entry.DefinitionDigest != type.DefinitionDigest)
            {
                throw Invalid();
            }
            ArticlePropertyValuePersistence.ValidateStorageEntries([entry], new Dictionary<Guid, ArticlePropertyValueType>
            {
                [type.DefinitionId] = type.StorageKind
            });
            if (reconciliation is null)
            {
                throw Invalid();
            }
        }
        ArticlePropertyValueReconciliationStatus status = reconciliation?.Status ?? ArticlePropertyValueReconciliationStatus.Current;
        var projection = new AuthoringPropertyReadProjection(binding, type, entry, status,
            current?.SnapshotId, current?.FactsetId, current?.Snapshot.ContentDigest, current?.AuditReference,
            definition.Status == ArticlePropertyDefinitionStatus.Active && status == ArticlePropertyValueReconciliationStatus.Current);
        EnsureCurrent(binding, type, linked.Token);
        return projection;
    }

    private void EnsureCurrent(AuthoringPropertyReadBinding binding, AuthoringPropertyTypeContribution type, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (binding.Deadline <= _time.GetUtcNow() || binding.Deadline - _time.GetUtcNow() > TimeSpan.FromMinutes(1)
            || !_admission.IsCurrent(binding, type))
        {
            throw new AuthoringExtensionContractException("authoring_property_read_not_current");
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (binding.Deadline <= _time.GetUtcNow())
        {
            throw new AuthoringExtensionContractException("authoring_property_read_not_current");
        }
    }

    private static bool Identifier(string? value) => value is { Length: > 0 and <= 128 }
        && value.All(static c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '_' or ':');

    private static AuthoringExtensionContractException Invalid() => new("authoring_property_read_binding_invalid");
}
