using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public sealed class LocalAuthoringCapabilityGrantStore :
    IAuthoringCapabilityGrantStore,
    IAuthoringCapabilityGrantCatalog
{
    private static readonly JsonSerializerOptions s_json = ClosedJson();
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _path;
    private readonly TimeProvider _timeProvider;
    private Dictionary<string, AuthoringCapabilityGrant> _grants;

    public LocalAuthoringCapabilityGrantStore(string rootPath, TimeProvider timeProvider)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootPath);
        ArgumentNullException.ThrowIfNull(timeProvider);
        _path = Path.Combine(LocalAuthoringHostStorage.PrepareRoot(rootPath), "capability-grants.v1.json");
        _timeProvider = timeProvider;
        _grants = Load();
    }

    public async ValueTask<AuthoringCapabilityGrant?> FindAsync(
        string grantId,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return _grants.TryGetValue(grantId, out AuthoringCapabilityGrant? grant)
                ? grant
                : null;
        }
        finally
        {
            _gate.Release();
        }
    }
    public async ValueTask StoreAsync(AuthoringCapabilityGrant grant, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(grant);
        ValidateGrant(grant);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var next = new Dictionary<string, AuthoringCapabilityGrant>(_grants, StringComparer.Ordinal);
            if (!next.TryAdd(grant.GrantId, grant))
            {
                throw new AuthoringExtensionContractException("Capability grant receipt already exists.");
            }

            await PersistAsync(next, cancellationToken);
            _grants = next;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask RevokeAsync(string grantId, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var next = new Dictionary<string, AuthoringCapabilityGrant>(_grants, StringComparer.Ordinal);
            if (next.Remove(grantId))
            {
                await PersistAsync(next, cancellationToken);
                _grants = next;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindActiveAsync(
        string extensionId,
        string contributionId,
        string runtimeIdentity,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            DateTimeOffset now = _timeProvider.GetUtcNow();
            return
            [
                .. _grants.Values
                    .Where(grant => grant.ExpiresAt > now &&
                        string.Equals(grant.ExtensionId, extensionId, StringComparison.Ordinal) &&
                        string.Equals(grant.ContributionId, contributionId, StringComparison.Ordinal) &&
                        string.Equals(grant.RuntimeIdentity, runtimeIdentity, StringComparison.Ordinal))
                    .OrderBy(static grant => grant.GrantId, StringComparer.Ordinal)
            ];
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindActiveExactAsync(
        string extensionId,
        string extensionVersion,
        string contributionId,
        string runtimeIdentity,
        AuthoringExecutionClass executionClass,
        string documentId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(extensionId) || string.IsNullOrWhiteSpace(extensionVersion) ||
            string.IsNullOrWhiteSpace(contributionId) || string.IsNullOrWhiteSpace(documentId) ||
            !Enum.IsDefined(executionClass))
        {
            throw new AuthoringExtensionContractException("Exact capability grant scope is missing or unknown.");
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            DateTimeOffset now = _timeProvider.GetUtcNow();
            return
            [
                .. _grants.Values
                    .Where(grant => grant.ExpiresAt > now &&
                        string.Equals(grant.ExtensionId, extensionId, StringComparison.Ordinal) &&
                        string.Equals(grant.ExtensionVersion, extensionVersion, StringComparison.Ordinal) &&
                        string.Equals(grant.ContributionId, contributionId, StringComparison.Ordinal) &&
                        string.Equals(grant.RuntimeIdentity, runtimeIdentity, StringComparison.Ordinal) &&
                        grant.ExecutionClass == executionClass &&
                        string.Equals(grant.DocumentId, documentId, StringComparison.Ordinal))
                    .OrderBy(static grant => grant.GrantId, StringComparer.Ordinal)
            ];
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask<int> RevokeExtensionAsync(string extensionId, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var next = new Dictionary<string, AuthoringCapabilityGrant>(_grants, StringComparer.Ordinal);
            string[] grantIds =
            [
                .. next.Values
                    .Where(grant => string.Equals(grant.ExtensionId, extensionId, StringComparison.Ordinal))
                    .Select(static grant => grant.GrantId)
            ];
            foreach (string grantId in grantIds)
            {
                next.Remove(grantId);
            }

            if (grantIds.Length > 0)
            {
                await PersistAsync(next, cancellationToken);
                _grants = next;
            }

            return grantIds.Length;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask<int> RevokeRuntimesAsync(
        string extensionId,
        ImmutableHashSet<string> runtimeIdentities,
        CancellationToken cancellationToken)
    {
        if (runtimeIdentities is null || runtimeIdentities.Count == 0)
        {
            return 0;
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var next = new Dictionary<string, AuthoringCapabilityGrant>(_grants, StringComparer.Ordinal);
            string[] grantIds =
            [
                .. next.Values
                    .Where(grant => string.Equals(grant.ExtensionId, extensionId, StringComparison.Ordinal) &&
                        runtimeIdentities.Contains(grant.RuntimeIdentity))
                    .Select(static grant => grant.GrantId)
            ];
            foreach (string grantId in grantIds)
            {
                next.Remove(grantId);
            }

            if (grantIds.Length > 0)
            {
                await PersistAsync(next, cancellationToken);
                _grants = next;
            }

            return grantIds.Length;
        }
        finally
        {
            _gate.Release();
        }
    }

    private Dictionary<string, AuthoringCapabilityGrant> Load()
    {
        if (!File.Exists(_path))
        {
            return new(StringComparer.Ordinal);
        }

        try
        {
            AuthoringCapabilityGrant[] grants = JsonSerializer.Deserialize<AuthoringCapabilityGrant[]>(
                File.ReadAllBytes(_path),
                s_json) ?? [];
            foreach (AuthoringCapabilityGrant grant in grants)
            {
                ValidateGrant(grant);
            }
            return grants.ToDictionary(static grant => grant.GrantId, StringComparer.Ordinal);
        }
        catch (Exception exception) when (exception is IOException or JsonException or ArgumentException)
        {
            throw new AuthoringExtensionContractException(
                $"Capability grant store is malformed: {exception.GetType().Name}.");
        }
    }

    private ValueTask PersistAsync(
        Dictionary<string, AuthoringCapabilityGrant> grants,
        CancellationToken cancellationToken) =>
        LocalAuthoringHostStorage.WriteAtomicAsync(
            _path,
            JsonSerializer.SerializeToUtf8Bytes(
                grants.Values.OrderBy(static grant => grant.GrantId, StringComparer.Ordinal),
                s_json),
            cancellationToken);

    private static void ValidateGrant(AuthoringCapabilityGrant grant)
    {
        if (grant is null ||
            !Enum.IsDefined(grant.ExecutionClass) ||
            !Enum.IsDefined(grant.Capability) ||
            !IsSha256(grant.GrantId) ||
            !IsSha256(grant.RuntimeIdentity) ||
            !string.Equals(grant.GrantId, grant.GrantDigest, StringComparison.Ordinal) ||
            !string.Equals(
                grant.GrantDigest,
                AuthoringCapabilityGrantAuthority.ComputeGrantDigest(grant),
                StringComparison.Ordinal) ||
            !IsBoundedField(grant.RequestId, 256) ||
            !IsBoundedField(grant.ExtensionId, 128) ||
            !IsBoundedField(grant.ExtensionVersion, 64) ||
            !IsBoundedField(grant.ContributionId, 256) ||
            !IsBoundedField(grant.DocumentId, 256) ||
            !IsBoundedField(grant.SiteIdentity, 256) ||
            !IsBoundedField(grant.Purpose, 256) ||
            grant.Purpose.Equals("all", StringComparison.OrdinalIgnoreCase) ||
            grant.ExpiresAt <= grant.IssuedAt || grant.ExpiresAt - grant.IssuedAt > TimeSpan.FromHours(24) ||
            !IsBoundedField(grant.ApprovalReceiptId, 256) ||
            !HasExactIoScope(grant))
        {
            throw new AuthoringExtensionContractException("Capability grant store contains a malformed or tampered grant.");
        }
    }

    private static bool HasExactIoScope(AuthoringCapabilityGrant grant) =>
        grant.Capability switch
        {
            AuthoringCapability.NetworkDestination =>
                IsBoundedField(grant.Destination, 2048) && grant.CanonicalRoot is null,
            AuthoringCapability.FileSystemRootRead or AuthoringCapability.FileSystemRootProposeWrite =>
                grant.Destination is null && IsBoundedField(grant.CanonicalRoot, 4096),
            _ => grant.Destination is null && grant.CanonicalRoot is null
        };

    private static bool IsBoundedField(string? value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value) &&
        value.Length <= maximumLength &&
        value == value.Trim() &&
        !value.ContainsAny(['\0', '\r', '\n']);

    private static bool IsSha256(string? value) =>
        value?.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static JsonSerializerOptions ClosedJson() => new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
}

public sealed class LocalAuthoringLifecycleReceiptStore : IAuthoringLifecycleReceiptStore
{
    private static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _path;
    private Dictionary<string, List<AuthoringLifecycleReceipt>> _receipts;

    public LocalAuthoringLifecycleReceiptStore(string rootPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootPath);
        _path = Path.Combine(LocalAuthoringHostStorage.PrepareRoot(rootPath), "lifecycle-receipts.v1.json");
        _receipts = Load();
    }

    public async ValueTask<AuthoringLifecycleReceipt?> GetLatestAsync(
        string extensionId,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return _receipts.TryGetValue(extensionId, out List<AuthoringLifecycleReceipt>? receipts)
                ? receipts[^1]
                : null;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask AppendAsync(AuthoringLifecycleReceipt receipt, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var next = _receipts.ToDictionary(
                static item => item.Key,
                static item => new List<AuthoringLifecycleReceipt>(item.Value),
                StringComparer.Ordinal);
            List<AuthoringLifecycleReceipt> receipts = next.GetValueOrDefault(receipt.ExtensionId) ?? [];
            AuthoringLifecycleReceipt? previous = receipts.LastOrDefault();
            if (!IsClosed(receipt) ||
                receipt.Sequence != (previous?.Sequence ?? 0) + 1 ||
                receipt.Generation != (previous?.Generation ?? 0) + 1 ||
                receipt.PreviousState != (previous?.State ?? AuthoringLifecycleState.Installed) ||
                !AuthoringExtensionLifecycleCoordinator.IsTransitionAllowed(
                    receipt.PreviousState,
                    receipt.State) ||
                !string.Equals(
                    receipt.PreviousReceiptSha256,
                    previous?.ReceiptSha256 ?? new string('0', 64),
                    StringComparison.Ordinal) ||
                !string.Equals(
                    receipt.ReceiptSha256,
                    AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(receipt),
                    StringComparison.Ordinal))
            {
                throw new AuthoringExtensionContractException("Lifecycle receipt chain is stale, malformed, or not append-only.");
            }

            receipts.Add(receipt);
            next[receipt.ExtensionId] = receipts;
            await PersistAsync(next, cancellationToken);
            _receipts = next;
        }
        finally
        {
            _gate.Release();
        }
    }

    private Dictionary<string, List<AuthoringLifecycleReceipt>> Load()
    {
        if (!File.Exists(_path))
        {
            return new(StringComparer.Ordinal);
        }

        try
        {
            AuthoringLifecycleReceipt[] values = JsonSerializer.Deserialize<AuthoringLifecycleReceipt[]>(
                File.ReadAllBytes(_path),
                s_json) ?? [];
            var result = new Dictionary<string, List<AuthoringLifecycleReceipt>>(StringComparer.Ordinal);
            foreach (IGrouping<string, AuthoringLifecycleReceipt> group in values.GroupBy(
                static receipt => receipt.ExtensionId,
                StringComparer.Ordinal))
            {
                List<AuthoringLifecycleReceipt> chain = [.. group.OrderBy(static receipt => receipt.Sequence)];
                AuthoringLifecycleReceipt? previous = null;
                foreach (AuthoringLifecycleReceipt receipt in chain)
                {
                    if (!IsClosed(receipt) ||
                        receipt.Sequence != (previous?.Sequence ?? 0) + 1 ||
                        receipt.Generation != (previous?.Generation ?? 0) + 1 ||
                        receipt.PreviousState != (previous?.State ?? AuthoringLifecycleState.Installed) ||
                        !AuthoringExtensionLifecycleCoordinator.IsTransitionAllowed(
                            receipt.PreviousState,
                            receipt.State) ||
                        !string.Equals(
                            receipt.PreviousReceiptSha256,
                            previous?.ReceiptSha256 ?? new string('0', 64),
                            StringComparison.Ordinal) ||
                        !string.Equals(
                            receipt.ReceiptSha256,
                            AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(receipt),
                            StringComparison.Ordinal))
                    {
                        throw new AuthoringExtensionContractException("Persisted lifecycle receipt chain is invalid.");
                    }

                    previous = receipt;
                }

                result.Add(group.Key, chain);
            }

            return result;
        }
        catch (Exception exception) when (exception is IOException or JsonException or ArgumentException)
        {
            throw new AuthoringExtensionContractException(
                $"Lifecycle receipt store is malformed: {exception.GetType().Name}.");
        }
    }

    private static bool IsClosed(AuthoringLifecycleReceipt receipt) =>
        receipt is not null &&
        receipt.SchemaVersion == 1 &&
        receipt.Sequence >= 1 &&
        receipt.Generation >= 1 &&
        !string.IsNullOrWhiteSpace(receipt.ExtensionId) &&
        receipt.ExtensionId.Length <= 128 &&
        !string.IsNullOrWhiteSpace(receipt.Version) &&
        receipt.Version.Length <= 64 &&
        receipt.StateSchemaVersion >= 1 &&
        receipt.DataSchemaVersion >= 1 &&
        Enum.IsDefined(receipt.PreviousState) &&
        Enum.IsDefined(receipt.State) &&
        IsSha256(receipt.PackageSha256) &&
        IsSha256(receipt.ScopeDigest) &&
        IsSha256(receipt.PreviousReceiptSha256) &&
        IsSha256(receipt.ReceiptSha256) &&
        (receipt.FailureCode is null ||
            !string.IsNullOrWhiteSpace(receipt.FailureCode) && receipt.FailureCode.Length <= 128);

    private static bool IsSha256(string? value) =>
        value?.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private ValueTask PersistAsync(
        Dictionary<string, List<AuthoringLifecycleReceipt>> receipts,
        CancellationToken cancellationToken) =>
        LocalAuthoringHostStorage.WriteAtomicAsync(
            _path,
            JsonSerializer.SerializeToUtf8Bytes(
                receipts.Values.SelectMany(static values => values)
                    .OrderBy(static receipt => receipt.ExtensionId, StringComparer.Ordinal)
                    .ThenBy(static receipt => receipt.Sequence),
                s_json),
            cancellationToken);
}

public interface IAuthoringExtensionStateAuthority
{
    ValueTask PutAsync(
        AuthoringStateScope scope,
        string key,
        ImmutableArray<byte> value,
        CancellationToken cancellationToken);
}

public sealed class LocalAuthoringExtensionStateStore :
    IAuthoringExtensionStateStore,
    IAuthoringExtensionStateAuthority
{
    private static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _path;
    private StateFile _state;

    public LocalAuthoringExtensionStateStore(string rootPath)
    {
        _path = Path.Combine(LocalAuthoringHostStorage.PrepareRoot(rootPath), "extension-state.v2.json");
        _state = Load();
    }

    public async ValueTask PutAsync(
        AuthoringStateScope scope,
        string key,
        ImmutableArray<byte> value,
        CancellationToken cancellationToken)
    {
        _ = ScopeKey(scope);
        ValidateKey(key);
        if (value.IsDefault || value.Length > 16 * 1024 * 1024)
        {
            throw new AuthoringExtensionContractException("Extension state value is missing or outside its bound.");
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            StateFile next = CloneState(_state);
            Dictionary<string, string> values = GetOrCreateScope(next, scope);
            values[key] = Convert.ToBase64String(value.AsSpan());
            await PersistAsync(next, cancellationToken);
            _state = next;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask BackupAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            StateFile next = CloneState(_state);
            string scope = ScopeKey(plan.From);
            StoredStateScope? stored = next.Scopes.GetValueOrDefault(scope);
            if (stored is not null && stored.Scope != plan.From)
            {
                throw new AuthoringExtensionContractException("State backup scope identity collided or drifted.");
            }
            Dictionary<string, string> values = stored?.Values ?? new(StringComparer.Ordinal);
            if (!next.Backups.TryAdd(plan.BackupReference, new StoredStateBackup(
                plan.From,
                values.ToDictionary(
                    static item => item.Key,
                    static item => item.Value,
                    StringComparer.Ordinal))))
            {
                throw new AuthoringExtensionContractException("State backup authority already exists.");
            }
            await PersistAsync(next, cancellationToken);
            _state = next;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask ApplyAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            StateFile next = CloneState(_state);
            StoredStateScope? stored = next.Scopes.GetValueOrDefault(ScopeKey(plan.From));
            if (stored is not null && stored.Scope != plan.From)
            {
                throw new AuthoringExtensionContractException("State migration scope identity collided or drifted.");
            }
            Dictionary<string, string> source = stored?.Values ?? new(StringComparer.Ordinal);
            var target = source.ToDictionary(static item => item.Key, static item => item.Value, StringComparer.Ordinal);
            foreach (AuthoringStateTransform transform in plan.Transforms)
            {
                ValidateKey(transform.SourceKey);
                if (transform.DestinationKey is not null)
                {
                    ValidateKey(transform.DestinationKey);
                }

                switch (transform.Kind)
                {
                    case AuthoringStateTransformKind.RenameKey:
                        if (transform.DestinationKey is null || !target.Remove(transform.SourceKey, out string? renamed) ||
                            !target.TryAdd(transform.DestinationKey, renamed))
                        {
                            throw new AuthoringExtensionContractException("State rename is missing or conflicts with an existing key.");
                        }
                        break;
                    case AuthoringStateTransformKind.DeleteExtensionKey:
                        target.Remove(transform.SourceKey);
                        break;
                    case AuthoringStateTransformKind.SetDefault:
                        if (transform.DefaultValue.IsDefault || transform.DefaultValue.Length > 16 * 1024 * 1024)
                        {
                            throw new AuthoringExtensionContractException("State default value is missing or outside its bound.");
                        }
                        target.TryAdd(transform.SourceKey, Convert.ToBase64String(transform.DefaultValue.AsSpan()));
                        break;
                    default:
                        throw new AuthoringExtensionContractException("State transform kind is not registered.");
                }
            }

            EnsureBound(target, plan.MaximumRecords, plan.MaximumBytes);
            next.Scopes[ScopeKey(plan.To)] = new StoredStateScope(plan.To, target);
            await PersistAsync(next, cancellationToken);
            _state = next;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask RollbackAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            StateFile next = CloneState(_state);
            if (!next.Backups.Remove(plan.BackupReference, out StoredStateBackup? backup) ||
                backup.Scope != plan.From)
            {
                throw new AuthoringExtensionContractException("State rollback has no exact backup authority.");
            }

            next.Scopes.Remove(ScopeKey(plan.To));
            next.Scopes[ScopeKey(plan.From)] = new StoredStateScope(
                plan.From,
                new Dictionary<string, string>(backup.Values, StringComparer.Ordinal));
            await PersistAsync(next, cancellationToken);
            _state = next;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask<(long Records, long Bytes)> MeasureAsync(
        AuthoringStateScope scope,
        CancellationToken cancellationToken)
    {
        _ = ScopeKey(scope);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            StoredStateScope[] owned =
            [
                .. _state.Scopes.Values.Where(stored => IsOwnedBy(stored.Scope, scope))
            ];
            StoredStateBackup[] backups =
            [
                .. _state.Backups.Values.Where(stored => IsOwnedBy(stored.Scope, scope))
            ];
            return (
                owned.Sum(static stored => (long)stored.Values.Count) +
                    backups.Sum(static stored => (long)stored.Values.Count),
                owned.Sum(static stored => MeasureBytes(stored.Values)) +
                    backups.Sum(static stored => MeasureBytes(stored.Values)));
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask DeleteAsync(AuthoringStateScope scope, CancellationToken cancellationToken)
    {
        _ = ScopeKey(scope);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            StateFile next = CloneState(_state);
            string[] scopeKeys =
            [
                .. next.Scopes
                    .Where(item => IsOwnedBy(item.Value.Scope, scope))
                    .Select(static item => item.Key)
            ];
            string[] backupKeys =
            [
                .. next.Backups
                    .Where(item => IsOwnedBy(item.Value.Scope, scope))
                    .Select(static item => item.Key)
            ];
            foreach (string scopeKey in scopeKeys)
            {
                next.Scopes.Remove(scopeKey);
            }
            foreach (string backupKey in backupKeys)
            {
                next.Backups.Remove(backupKey);
            }

            if (scopeKeys.Length > 0 || backupKeys.Length > 0)
            {
                await PersistAsync(next, cancellationToken);
                _state = next;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private static Dictionary<string, string> GetOrCreateScope(StateFile state, AuthoringStateScope scope)
    {
        string key = ScopeKey(scope);
        if (!state.Scopes.TryGetValue(key, out StoredStateScope? stored))
        {
            stored = new StoredStateScope(scope, new(StringComparer.Ordinal));
            state.Scopes.Add(key, stored);
        }
        else if (stored.Scope != scope)
        {
            throw new AuthoringExtensionContractException("Extension state scope identity collided or drifted.");
        }

        return stored.Values;
    }

    private StateFile Load()
    {
        if (!File.Exists(_path))
        {
            return new StateFile(2, new(StringComparer.Ordinal), new(StringComparer.Ordinal));
        }

        try
        {
            StateFile state = JsonSerializer.Deserialize<StateFile>(File.ReadAllBytes(_path), s_json) ??
                throw new JsonException("State file is empty.");
            if (state.SchemaVersion != 2 || state.Scopes is null || state.Backups is null ||
                state.Scopes.Any(item => item.Value is null || item.Value.Scope is null || item.Value.Values is null ||
                    !string.Equals(item.Key, ScopeKey(item.Value.Scope), StringComparison.Ordinal) ||
                    !AreStoredValuesValid(item.Value.Values)) ||
                state.Backups.Any(item => string.IsNullOrWhiteSpace(item.Key) || item.Key.Length > 256 ||
                    item.Value is null || item.Value.Scope is null || item.Value.Values is null ||
                    !AreStoredValuesValid(item.Value.Values)))
            {
                throw new JsonException("State file schema is invalid.");
            }

            return state;
        }
        catch (Exception exception) when (exception is IOException or JsonException or ArgumentException or FormatException)
        {
            throw new AuthoringExtensionContractException(
                $"Extension state store is malformed: {exception.GetType().Name}.");
        }
    }

    private ValueTask PersistAsync(StateFile state, CancellationToken cancellationToken) =>
        LocalAuthoringHostStorage.WriteAtomicAsync(
            _path,
            JsonSerializer.SerializeToUtf8Bytes(state, s_json),
            cancellationToken);

    private static StateFile CloneState(StateFile state) => new(
        state.SchemaVersion,
        state.Scopes.ToDictionary(
            static item => item.Key,
            static item => new StoredStateScope(
                item.Value.Scope,
                new Dictionary<string, string>(item.Value.Values, StringComparer.Ordinal)),
            StringComparer.Ordinal),
        state.Backups.ToDictionary(
            static item => item.Key,
            static item => new StoredStateBackup(
                item.Value.Scope,
                new Dictionary<string, string>(item.Value.Values, StringComparer.Ordinal)),
            StringComparer.Ordinal));

    private static string ScopeKey(AuthoringStateScope scope)
    {
        ArgumentNullException.ThrowIfNull(scope);
        if (!IsBoundedField(scope.ExtensionId, 128) ||
            !IsBoundedField(scope.ExtensionVersion, 64) ||
            !IsBoundedField(scope.SiteId, 256) ||
            !IsBoundedField(scope.UserId, 256) ||
            scope.SchemaVersion < 1 ||
            scope.DocumentId is not null && !IsBoundedField(scope.DocumentId, 256))
        {
            throw new AuthoringExtensionContractException("Extension state scope is missing or outside its bound.");
        }

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n',
            scope.ExtensionId,
            scope.ExtensionVersion,
            scope.SiteId,
            scope.UserId,
            scope.DocumentId ?? string.Empty,
            scope.SchemaVersion))));
    }

    private static void ValidateKey(string key)
    {
        if (!IsBoundedField(key, 256))
        {
            throw new AuthoringExtensionContractException("Extension state key is missing or outside its bound.");
        }
    }

    private static bool IsBoundedField(string? value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value) &&
        value.Length <= maximumLength &&
        value == value.Trim() &&
        !value.Any(static character => char.IsControl(character));

    private static long MeasureBytes(Dictionary<string, string> values) =>
        values.Sum(static item => Encoding.UTF8.GetByteCount(item.Key) + Convert.FromBase64String(item.Value).LongLength);

    private static bool AreStoredValuesValid(Dictionary<string, string> values)
    {
        foreach ((string key, string value) in values)
        {
            ValidateKey(key);
            if (Convert.FromBase64String(value).Length > 16 * 1024 * 1024)
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsOwnedBy(AuthoringStateScope candidate, AuthoringStateScope approval) =>
        string.Equals(candidate.ExtensionId, approval.ExtensionId, StringComparison.Ordinal) &&
        string.Equals(candidate.SiteId, approval.SiteId, StringComparison.Ordinal) &&
        string.Equals(candidate.UserId, approval.UserId, StringComparison.Ordinal) &&
        (approval.DocumentId is null || string.Equals(candidate.DocumentId, approval.DocumentId, StringComparison.Ordinal));

    private static void EnsureBound(Dictionary<string, string> values, long maximumRecords, long maximumBytes)
    {
        if (values.Count > maximumRecords || MeasureBytes(values) > maximumBytes)
        {
            throw new AuthoringExtensionContractException("Migrated extension state exceeded its declared bound.");
        }
    }

    private sealed record StateFile(
        int SchemaVersion,
        Dictionary<string, StoredStateScope> Scopes,
        Dictionary<string, StoredStateBackup> Backups);

    private sealed record StoredStateScope(
        AuthoringStateScope Scope,
        Dictionary<string, string> Values);

    private sealed record StoredStateBackup(
        AuthoringStateScope Scope,
        Dictionary<string, string> Values);
}

public sealed record AuthoringDocumentSessionSnapshot(
    string DocumentId,
    long DocumentEpoch,
    long SourceRevision,
    string SnapshotSha256,
    string Source,
    string SelectionIdentity,
    long HistoryDepth);

public interface IAuthoringDocumentSessionAuthority
{
    ValueTask<AuthoringDocumentSessionSnapshot> OpenOrResetAsync(
        string documentId,
        long documentEpoch,
        long sourceRevision,
        string source,
        string selectionIdentity,
        CancellationToken cancellationToken = default);

    ValueTask<AuthoringDocumentSessionSnapshot?> ReadAsync(
        string documentId,
        CancellationToken cancellationToken = default);
}

public sealed class FsusUiAuthoringDocumentAuthority :
    IAuthoringDocumentSessionAuthority,
    IAuthoringDocumentRevisionGate,
    IAuthoringCanonicalDocumentTransaction,
    IAuthoringCoreContinuityProbe
{
    private readonly ConcurrentDictionary<string, Session> _sessions = new(StringComparer.Ordinal);

    public ValueTask<AuthoringDocumentSessionSnapshot> OpenOrResetAsync(
        string documentId,
        long documentEpoch,
        long sourceRevision,
        string source,
        string selectionIdentity,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateIdentity(documentId, documentEpoch, sourceRevision, source, selectionIdentity);
        var session = new Session(documentId, documentEpoch, sourceRevision, source, selectionIdentity);
        _sessions[documentId] = session;
        return ValueTask.FromResult(session.Snapshot());
    }

    public ValueTask<AuthoringDocumentSessionSnapshot?> ReadAsync(
        string documentId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(
            _sessions.TryGetValue(documentId, out Session? session) ? session.Snapshot() : null);
    }

    public ValueTask<bool> IsCurrentAsync(
        string documentId,
        long documentEpoch,
        long sourceRevision,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(
            _sessions.TryGetValue(documentId, out Session? session) &&
            session.IsCurrent(documentEpoch, sourceRevision));
    }

    public ValueTask<AuthoringTransactionReceipt> ApplyAsync(
        AuthoringMutationPlan plan,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_sessions.TryGetValue(plan.DocumentId, out Session? session))
        {
            throw new AuthoringExtensionContractException("Canonical FsusUI document session is not open.");
        }

        return ValueTask.FromResult(session.Apply(plan));
    }

    public ValueTask<bool> IsCoreAvailableAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(_sessions.Values.All(static session => session.IsValid()));
    }

    private static void ValidateIdentity(
        string documentId,
        long documentEpoch,
        long sourceRevision,
        string source,
        string selectionIdentity)
    {
        if (string.IsNullOrWhiteSpace(documentId) || documentId.Length > 256 || documentEpoch < 1 ||
            sourceRevision < 0 || source is null || source.Length > 16 * 1024 * 1024 ||
            string.IsNullOrWhiteSpace(selectionIdentity) || selectionIdentity.Length > 256)
        {
            throw new AuthoringExtensionContractException("Canonical FsusUI document identity is missing or outside its bound.");
        }
    }

    private sealed class Session(
        string documentId,
        long epoch,
        long revision,
        string source,
        string selectionIdentity)
    {
        private readonly Lock _lock = new();
        private long _historyDepth;
        private long _revision = revision;
        private string _selectionIdentity = selectionIdentity;
        private string _source = source;

        public bool IsCurrent(long expectedEpoch, long expectedRevision)
        {
            lock (_lock)
            {
                return epoch == expectedEpoch && _revision == expectedRevision;
            }
        }

        public bool IsValid()
        {
            lock (_lock)
            {
                return epoch > 0 && _revision >= 0 && _source.Length <= 16 * 1024 * 1024 && _historyDepth >= 0;
            }
        }

        public AuthoringDocumentSessionSnapshot Snapshot()
        {
            lock (_lock)
            {
                return new AuthoringDocumentSessionSnapshot(
                    documentId,
                    epoch,
                    _revision,
                    Digest(_source),
                    _source,
                    _selectionIdentity,
                    _historyDepth);
            }
        }

        public AuthoringTransactionReceipt Apply(AuthoringMutationPlan plan)
        {
            lock (_lock)
            {
                if (plan.DocumentEpoch != epoch || plan.ExpectedSourceRevision != _revision ||
                    !string.Equals(plan.ExpectedSnapshotSha256, Digest(_source), StringComparison.Ordinal) ||
                    string.IsNullOrWhiteSpace(plan.PlanId) || string.IsNullOrWhiteSpace(plan.SelectionIdentity) ||
                    plan.Mutations.IsDefault || plan.Mutations.Length is < 1 or > 1000)
                {
                    throw new AuthoringExtensionContractException("Canonical FsusUI transaction is stale or malformed.");
                }

                AuthoringMutation[] mutations = [.. plan.Mutations.OrderBy(static mutation => mutation.Range.Start)];
                int previousEnd = -1;
                foreach (AuthoringMutation mutation in mutations)
                {
                    if (!Enum.IsDefined(mutation.Operation) || mutation.Range.Start < 0 ||
                        mutation.Range.End < mutation.Range.Start || mutation.Range.End > _source.Length ||
                        mutation.Range.Start < previousEnd || mutation.Text is null ||
                        mutation.Text.Length > 16 * 1024 * 1024 ||
                        mutation.Operation == AuthoringMutationOperation.Insert && mutation.Range.Start != mutation.Range.End ||
                        mutation.Operation == AuthoringMutationOperation.Delete && mutation.Text.Length != 0)
                    {
                        throw new AuthoringExtensionContractException("Canonical FsusUI transaction change is invalid or overlapping.");
                    }

                    previousEnd = mutation.Range.End;
                }

                string next = _source;
                foreach (AuthoringMutation mutation in mutations.Reverse())
                {
                    next = next[..mutation.Range.Start] + mutation.Text + next[mutation.Range.End..];
                    if (next.Length > 16 * 1024 * 1024)
                    {
                        throw new AuthoringExtensionContractException("Canonical FsusUI transaction exceeded its document bound.");
                    }
                }

                long previousRevision = _revision;
                _source = next;
                _revision++;
                _historyDepth++;
                _selectionIdentity = plan.SelectionIdentity;
                string transactionId = Digest(string.Join('\n',
                    plan.PlanId,
                    documentId,
                    epoch,
                    previousRevision,
                    _revision,
                    Digest(next)));
                string historyEntryId = Digest($"history\n{transactionId}\n{_historyDepth}");
                string receiptDigest = Digest(string.Join('\n',
                    transactionId,
                    plan.PlanId,
                    documentId,
                    previousRevision,
                    _revision,
                    historyEntryId,
                    plan.SelectionIdentity));
                return new AuthoringTransactionReceipt(
                    transactionId,
                    plan.PlanId,
                    documentId,
                    previousRevision,
                    _revision,
                    historyEntryId,
                    plan.SelectionIdentity,
                    true,
                    receiptDigest);
            }
        }

        private static string Digest(string value) =>
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    }
}

public sealed class LocalAuthoringBudgetTelemetrySink : IAuthoringBudgetTelemetrySink
{
    private static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _path;

    public LocalAuthoringBudgetTelemetrySink(string rootPath)
    {
        _path = Path.Combine(LocalAuthoringHostStorage.PrepareRoot(rootPath), "budget-telemetry.v1.jsonl");
    }

    public async ValueTask RecordAsync(AuthoringBudgetTelemetry telemetry, CancellationToken cancellationToken)
    {
        byte[] line = [.. JsonSerializer.SerializeToUtf8Bytes(telemetry, s_json), (byte)'\n'];
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var stream = new FileStream(
                _path,
                FileMode.Append,
                FileAccess.Write,
                FileShare.Read,
                16 * 1024,
                FileOptions.Asynchronous | FileOptions.WriteThrough);
            await stream.WriteAsync(line, cancellationToken);
            await stream.FlushAsync(cancellationToken);
            LocalAuthoringHostStorage.RestrictFile(_path);
        }
        finally
        {
            _gate.Release();
        }
    }
}

internal static class LocalAuthoringHostStorage
{
    public static string PrepareRoot(string rootPath)
    {
        if (!Path.IsPathFullyQualified(rootPath) ||
            Path.GetPathRoot(rootPath) == Path.TrimEndingDirectorySeparator(rootPath))
        {
            throw new AuthoringExtensionContractException("Authoring extension host root is missing or broad.");
        }

        Directory.CreateDirectory(rootPath);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(rootPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        return rootPath;
    }

    public static async ValueTask WriteAtomicAsync(
        string path,
        ReadOnlyMemory<byte> content,
        CancellationToken cancellationToken)
    {
        string temporary = path + "." + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)) + ".tmp";
        try
        {
            await using (var stream = new FileStream(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                16 * 1024,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(content, cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }

            RestrictFile(temporary);
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }

    public static void RestrictFile(string path)
    {
        if (!OperatingSystem.IsWindows() && File.Exists(path))
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }
}
