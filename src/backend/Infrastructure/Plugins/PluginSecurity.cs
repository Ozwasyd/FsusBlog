using System.Collections.Concurrent;
using System.Collections.Frozen;

namespace FsusBlog.Server.Infrastructure.Plugins;

public enum PluginCapability
{
    ArticleRead = 0,
    ArticleRender = 1,
    ArticleWriteDraft = 2,
    CommentRead = 3,
    CommentCreate = 4,
    CommentModerate = 5,
    SearchIndexWrite = 6,
    SearchQueryRewrite = 7,
    MediaProcess = 8,
    PluginStorageKv = 9,
    PluginStorageObject = 10,
    PluginLogWrite = 11,
    NetworkHttpOutbound = 12,
    SchedulerJobCreate = 13,
    AdminUiExtend = 14,
    ThemeAssetRead = 15,
    UserAuthHook = 16
}

public enum PluginCapabilityRisk
{
    Safe = 0,
    Sensitive = 1,
    Dangerous = 2,
    Trusted = 3
}

public static class PluginCapabilityCatalog
{
    private static readonly IReadOnlyDictionary<string, PluginCapability> s_byName =
        new Dictionary<string, PluginCapability>(StringComparer.Ordinal)
        {
            ["article.read"] = PluginCapability.ArticleRead,
            ["article.render"] = PluginCapability.ArticleRender,
            ["article.write.draft"] = PluginCapability.ArticleWriteDraft,
            ["comment.read"] = PluginCapability.CommentRead,
            ["comment.create"] = PluginCapability.CommentCreate,
            ["comment.moderate"] = PluginCapability.CommentModerate,
            ["search.index.write"] = PluginCapability.SearchIndexWrite,
            ["search.query.rewrite"] = PluginCapability.SearchQueryRewrite,
            ["media.process"] = PluginCapability.MediaProcess,
            ["plugin.storage.kv"] = PluginCapability.PluginStorageKv,
            ["plugin.storage.object"] = PluginCapability.PluginStorageObject,
            ["plugin.log.write"] = PluginCapability.PluginLogWrite,
            ["network.http.outbound"] = PluginCapability.NetworkHttpOutbound,
            ["scheduler.job.create"] = PluginCapability.SchedulerJobCreate,
            ["admin.ui.extend"] = PluginCapability.AdminUiExtend,
            ["theme.asset.read"] = PluginCapability.ThemeAssetRead,
            ["user.auth.hook"] = PluginCapability.UserAuthHook
        };

    private static readonly IReadOnlyDictionary<PluginCapability, string> s_byCapability =
        s_byName.ToDictionary(static item => item.Value, static item => item.Key);
    private static readonly IReadOnlyCollection<string> s_names =
        Array.AsReadOnly(s_byName.Keys.Order(StringComparer.Ordinal).ToArray());

    public static IReadOnlyCollection<string> Names => s_names;

    public static bool TryParse(string? name, out PluginCapability capability)
        => s_byName.TryGetValue(name ?? string.Empty, out capability);

    public static PluginCapability Parse(string name)
        => TryParse(name, out PluginCapability capability)
            ? capability
            : throw new PluginPermissionApprovalException($"Plugin capability '{name}' is unsupported.");

    public static string GetName(PluginCapability capability)
        => s_byCapability.TryGetValue(capability, out string? name)
            ? name
            : throw new ArgumentOutOfRangeException(nameof(capability));

    public static PluginCapabilityRisk GetRisk(PluginCapability capability)
        => capability switch
        {
            PluginCapability.PluginStorageKv
                or PluginCapability.PluginStorageObject
                or PluginCapability.PluginLogWrite
                or PluginCapability.ThemeAssetRead => PluginCapabilityRisk.Safe,
            _ => PluginCapabilityRisk.Sensitive
        };
}

public sealed record PluginCapabilityRequest(
    PluginCapability Capability,
    string Name,
    PluginCapabilityRisk Risk,
    bool RequiresAdministratorConfirmation);

public sealed record PluginPermissionPlan(
    string PluginId,
    IReadOnlyList<PluginCapabilityRequest> Capabilities,
    IReadOnlyList<string> DeniedRawPermissions)
{
    public bool CanEnable => DeniedRawPermissions.Count == 0;
}

public static class PluginPermissionPlanner
{
    public static PluginPermissionPlan Create(PluginManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        PluginCapabilityRequest[] capabilities =
        [
            .. manifest.Capabilities
                .Select(PluginCapabilityCatalog.Parse)
                .Order()
                .Select(static capability =>
                {
                    PluginCapabilityRisk risk = PluginCapabilityCatalog.GetRisk(capability);
                    return new PluginCapabilityRequest(
                        capability,
                        PluginCapabilityCatalog.GetName(capability),
                        risk,
                        risk != PluginCapabilityRisk.Safe);
                })
        ];
        var deniedRawPermissions = new List<string>(capacity: 3);
        if (manifest.Permissions.Database is not "none")
        {
            deniedRawPermissions.Add("database.raw");
        }
        if (manifest.Permissions.Filesystem)
        {
            deniedRawPermissions.Add("filesystem.raw");
        }
        if (manifest.Permissions.Network)
        {
            deniedRawPermissions.Add("network.unrestricted");
        }
        deniedRawPermissions.Sort(StringComparer.Ordinal);
        return new PluginPermissionPlan(
            manifest.Id,
            Array.AsReadOnly(capabilities),
            deniedRawPermissions.AsReadOnly());
    }
}

public interface IPluginPermissionGrantStore
{
    IReadOnlySet<PluginCapability> Get(string pluginId);

    void Replace(string pluginId, IReadOnlySet<PluginCapability> grants);
}

public sealed class InMemoryPluginPermissionGrantStore : IPluginPermissionGrantStore
{
    private static readonly IReadOnlySet<PluginCapability> s_empty =
        Array.Empty<PluginCapability>().ToFrozenSet();
    private readonly ConcurrentDictionary<string, IReadOnlySet<PluginCapability>> _grants =
        new(StringComparer.Ordinal);

    public IReadOnlySet<PluginCapability> Get(string pluginId)
        => _grants.TryGetValue(pluginId, out IReadOnlySet<PluginCapability>? grants)
            ? grants
            : s_empty;

    public void Replace(string pluginId, IReadOnlySet<PluginCapability> grants)
        => _grants[pluginId] = grants.ToFrozenSet();
}

public sealed class PluginPermissionManager(IPluginPermissionGrantStore store)
{
    private int _demandCount;

    public int DemandCount => Volatile.Read(ref _demandCount);

    public IReadOnlySet<PluginCapability> GetGrants(string pluginId)
    {
        ValidatePluginId(pluginId);
        return store.Get(pluginId);
    }

    public void Demand(string pluginId, PluginCapability capability)
    {
        ValidatePluginId(pluginId);
        Interlocked.Increment(ref _demandCount);
        if (!store.Get(pluginId).Contains(capability))
        {
            throw new PluginCapabilityDeniedException(
                $"Plugin '{pluginId}' was not granted capability '{PluginCapabilityCatalog.GetName(capability)}'.");
        }
    }

    public void ReplaceGrants(
        PluginPermissionPlan plan,
        IEnumerable<PluginCapability> grants,
        bool administratorConfirmedSensitive)
    {
        ArgumentNullException.ThrowIfNull(plan);
        string pluginId = plan.PluginId;
        ValidatePluginId(pluginId);
        ArgumentNullException.ThrowIfNull(grants);
        if (!plan.CanEnable)
        {
            throw new PluginPermissionApprovalException(
                $"Plugin '{pluginId}' requests raw permissions that cannot be granted.");
        }
        HashSet<PluginCapability> snapshot = grants.ToHashSet();
        HashSet<PluginCapability> requested =
            plan.Capabilities.Select(static item => item.Capability).ToHashSet();
        if (!snapshot.IsSubsetOf(requested))
        {
            throw new PluginPermissionApprovalException(
                $"Plugin '{pluginId}' cannot be granted a capability absent from its verified manifest.");
        }
        PluginCapability[] sensitive =
        [
            .. snapshot.Where(static capability =>
                PluginCapabilityCatalog.GetRisk(capability) != PluginCapabilityRisk.Safe)
        ];
        if (sensitive.Length > 0 && !administratorConfirmedSensitive)
        {
            throw new PluginPermissionApprovalException(
                $"Plugin '{pluginId}' requested sensitive capabilities without administrator confirmation.");
        }
        store.Replace(pluginId, snapshot);
    }

    private static void ValidatePluginId(string pluginId)
    {
        if (string.IsNullOrWhiteSpace(pluginId))
        {
            throw new ArgumentException("Plugin id cannot be empty.", nameof(pluginId));
        }
    }
}

public sealed record PluginSecurityAdministrativeSnapshot(
    string PluginId,
    PluginInstallState InstallState,
    bool Enabled,
    PluginRuntimeType Runtime,
    PluginPermissionPlan PermissionPlan,
    IReadOnlyList<PluginCapabilityRequest> GrantedCapabilities,
    PluginIsolationSnapshot Isolation);

public sealed class PluginSecurityAdministrativeSnapshotService(
    IPluginRegistry registry,
    PluginPermissionManager permissionManager,
    PluginIsolationController isolationController)
{
    public async Task<IReadOnlyList<PluginSecurityAdministrativeSnapshot>> ListAsync(
        CancellationToken cancellationToken = default)
    {
        IReadOnlyList<PluginRegistryEntry> entries =
            await registry.ListAsync(cancellationToken).ConfigureAwait(false);
        return
        [
            .. entries
                .OrderBy(static entry => entry.Manifest.Id, StringComparer.Ordinal)
                .Select(entry =>
                {
                    PluginPermissionPlan plan = PluginPermissionPlanner.Create(entry.Manifest);
                    IReadOnlySet<PluginCapability> grants =
                        permissionManager.GetGrants(entry.Manifest.Id);
                    PluginCapabilityRequest[] granted =
                    [
                        .. plan.Capabilities.Where(request => grants.Contains(request.Capability))
                    ];
                    return new PluginSecurityAdministrativeSnapshot(
                        entry.Manifest.Id,
                        entry.InstallState,
                        entry.Enabled,
                        entry.Manifest.Runtime.Type,
                        plan,
                        Array.AsReadOnly(granted),
                        isolationController.GetSnapshot(entry.Manifest.Id));
                })
        ];
    }
}

public sealed class PluginHostApiProxy(
    string pluginId,
    PluginPermissionManager permissionManager)
{
    public async ValueTask InvokeAsync(
        PluginCapability capability,
        Func<CancellationToken, ValueTask> operation,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(operation);
        permissionManager.Demand(pluginId, capability);
        await operation(cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<T> InvokeAsync<T>(
        PluginCapability capability,
        Func<CancellationToken, ValueTask<T>> operation,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(operation);
        permissionManager.Demand(pluginId, capability);
        return await operation(cancellationToken).ConfigureAwait(false);
    }
}

public enum PluginSandboxLevel
{
    Level0 = 0,
    Level1 = 1,
    Level2 = 2,
    Level3 = 3,
    Level4 = 4
}

public sealed record PluginSandboxProfile(
    PluginRuntimeType Runtime,
    PluginSandboxLevel Level,
    bool AllowClrAccess,
    bool AllowAssemblyLoad,
    bool AllowReflection,
    bool AllowServiceProvider,
    bool AllowRawFileSystem,
    bool AllowUnrestrictedNetwork,
    bool AllowProcessSpawn,
    IReadOnlyList<string> ImportedClrTypes);

public static class PluginSandboxPolicy
{
    public static PluginSandboxProfile CreateLevelOne(PluginRuntimeType runtime)
    {
        if (runtime is not (PluginRuntimeType.JavaScript or PluginRuntimeType.Lua))
        {
            throw new ArgumentOutOfRangeException(nameof(runtime));
        }
        return new PluginSandboxProfile(
            runtime,
            PluginSandboxLevel.Level1,
            AllowClrAccess: false,
            AllowAssemblyLoad: false,
            AllowReflection: false,
            AllowServiceProvider: false,
            AllowRawFileSystem: false,
            AllowUnrestrictedNetwork: false,
            AllowProcessSpawn: false,
            ImportedClrTypes: Array.Empty<string>());
    }
}

public sealed record PluginExecutionBudget(
    TimeSpan Timeout,
    long MemoryBytes,
    long InstructionCount,
    int MaximumCallDepth,
    long OutputBytes,
    long LogBytes)
{
    public static PluginExecutionBudget DefaultFor(string hookName)
        => hookName switch
        {
            "request.beforeResponse" => new(
                TimeSpan.FromMilliseconds(1),
                8 * 1024 * 1024,
                5_000,
                16,
                64 * 1024,
                16 * 1024),
            "article.beforeRender" => new(
                TimeSpan.FromMilliseconds(5),
                16 * 1024 * 1024,
                25_000,
                32,
                512 * 1024,
                32 * 1024),
            "comment.beforeCreate" => new(
                TimeSpan.FromMilliseconds(30),
                16 * 1024 * 1024,
                100_000,
                32,
                128 * 1024,
                32 * 1024),
            "comment.beforeAudit" => new(
                TimeSpan.FromMilliseconds(100),
                32 * 1024 * 1024,
                250_000,
                48,
                256 * 1024,
                64 * 1024),
            "search.queryRewrite" => new(
                TimeSpan.FromMilliseconds(5),
                8 * 1024 * 1024,
                25_000,
                24,
                64 * 1024,
                16 * 1024),
            "background.worker" => new(
                TimeSpan.FromSeconds(60),
                64 * 1024 * 1024,
                5_000_000,
                64,
                4 * 1024 * 1024,
                256 * 1024),
            _ => throw new PluginResourceLimitException($"Plugin hook '{hookName}' has no execution budget.")
        };
}

public sealed class PluginExecutionBudgetGuard : IDisposable
{
    private readonly PluginExecutionBudget _budget;
    private readonly TimeProvider _timeProvider;
    private readonly DateTimeOffset _deadlineUtc;
    private readonly CancellationTokenSource _timeoutSource;
    private long _memoryBytes;
    private long _instructionCount;
    private int _callDepth;
    private long _outputBytes;
    private long _logBytes;

    public PluginExecutionBudgetGuard(
        PluginExecutionBudget budget,
        TimeProvider timeProvider,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(budget);
        ArgumentNullException.ThrowIfNull(timeProvider);
        ValidateBudget(budget);
        _budget = budget;
        _timeProvider = timeProvider;
        _deadlineUtc = timeProvider.GetUtcNow() + budget.Timeout;
        _timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _timeoutSource.CancelAfter(budget.Timeout);
    }

    public CancellationToken CancellationToken => _timeoutSource.Token;

    public long MemoryUsedBytes => Volatile.Read(ref _memoryBytes);

    public long MemoryBudgetBytes => _budget.MemoryBytes;

    public void ReserveMemory(long bytes)
        => AddBounded(ref _memoryBytes, bytes, _budget.MemoryBytes, "memory");

    public void ConsumeInstructions(long instructions)
        => AddBounded(ref _instructionCount, instructions, _budget.InstructionCount, "instruction");

    public IDisposable EnterCall()
    {
        int depth = Interlocked.Increment(ref _callDepth);
        if (depth > _budget.MaximumCallDepth)
        {
            Interlocked.Decrement(ref _callDepth);
            throw new PluginResourceLimitException("Plugin maximum call depth exceeded.");
        }
        return new CallScope(this);
    }

    public void RecordOutput(long bytes)
        => AddBounded(ref _outputBytes, bytes, _budget.OutputBytes, "output");

    public void RecordLog(long bytes)
        => AddBounded(ref _logBytes, bytes, _budget.LogBytes, "log");

    public void ThrowIfTimeoutExceeded()
    {
        if (_timeProvider.GetUtcNow() >= _deadlineUtc || _timeoutSource.IsCancellationRequested)
        {
            throw new PluginResourceLimitException("Plugin execution timeout exceeded.");
        }
    }

    public void Dispose() => _timeoutSource.Dispose();

    private static void AddBounded(ref long current, long increment, long limit, string resource)
    {
        if (increment < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(increment));
        }
        while (true)
        {
            long observed = Volatile.Read(ref current);
            long updated;
            try
            {
                updated = checked(observed + increment);
            }
            catch (OverflowException)
            {
                throw new PluginResourceLimitException($"Plugin {resource} limit exceeded.");
            }
            if (updated > limit)
            {
                throw new PluginResourceLimitException($"Plugin {resource} limit exceeded.");
            }
            if (Interlocked.CompareExchange(ref current, updated, observed) == observed)
            {
                return;
            }
        }
    }

    private static void ValidateBudget(PluginExecutionBudget budget)
    {
        if (budget.Timeout <= TimeSpan.Zero
            || budget.MemoryBytes <= 0
            || budget.InstructionCount <= 0
            || budget.MaximumCallDepth <= 0
            || budget.OutputBytes <= 0
            || budget.LogBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(budget), "Every plugin execution budget must be positive.");
        }
    }

    private sealed class CallScope(PluginExecutionBudgetGuard owner) : IDisposable
    {
        private PluginExecutionBudgetGuard? _owner = owner;

        public void Dispose()
        {
            PluginExecutionBudgetGuard? snapshot = Interlocked.Exchange(ref _owner, null);
            if (snapshot is not null)
            {
                Interlocked.Decrement(ref snapshot._callDepth);
            }
        }
    }
}

public enum PluginIsolationState
{
    Healthy = 0,
    Degraded = 1,
    Quarantined = 2,
    Disabled = 3
}

public sealed record PluginIsolationSnapshot(
    string PluginId,
    PluginIsolationState State,
    int FailuresInWindow,
    DateTimeOffset UpdatedAtUtc);

public sealed class PluginIsolationController(TimeProvider timeProvider)
{
    private static readonly TimeSpan s_failureWindow = TimeSpan.FromMinutes(1);
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    public PluginIsolationSnapshot GetSnapshot(string pluginId)
    {
        ValidatePluginId(pluginId);
        Entry entry = _entries.GetOrAdd(pluginId, static _ => new Entry());
        lock (entry)
        {
            TrimFailures(entry, timeProvider.GetUtcNow());
            return ToSnapshot(pluginId, entry);
        }
    }

    public PluginIsolationSnapshot RecordFailure(string pluginId, bool criticalHookTimeout)
    {
        ValidatePluginId(pluginId);
        Entry entry = _entries.GetOrAdd(pluginId, static _ => new Entry());
        lock (entry)
        {
            DateTimeOffset now = timeProvider.GetUtcNow();
            TrimFailures(entry, now);
            entry.Failures.Enqueue(now);
            if (entry.State != PluginIsolationState.Disabled)
            {
                entry.State = criticalHookTimeout || entry.State == PluginIsolationState.Degraded
                    ? PluginIsolationState.Quarantined
                    : entry.Failures.Count >= 5
                        ? PluginIsolationState.Degraded
                        : entry.State;
            }
            entry.UpdatedAtUtc = now;
            return ToSnapshot(pluginId, entry);
        }
    }

    public PluginIsolationSnapshot Disable(string pluginId)
    {
        ValidatePluginId(pluginId);
        Entry entry = _entries.GetOrAdd(pluginId, static _ => new Entry());
        lock (entry)
        {
            entry.State = PluginIsolationState.Disabled;
            entry.UpdatedAtUtc = timeProvider.GetUtcNow();
            return ToSnapshot(pluginId, entry);
        }
    }

    public PluginIsolationSnapshot Restore(string pluginId, bool administratorConfirmed)
    {
        ValidatePluginId(pluginId);
        if (!administratorConfirmed)
        {
            throw new PluginIsolationException(
                $"Plugin '{pluginId}' isolation state can only be restored by an administrator.");
        }
        Entry entry = _entries.GetOrAdd(pluginId, static _ => new Entry());
        lock (entry)
        {
            entry.Failures.Clear();
            entry.State = PluginIsolationState.Healthy;
            entry.UpdatedAtUtc = timeProvider.GetUtcNow();
            return ToSnapshot(pluginId, entry);
        }
    }

    public void DemandExecutable(string pluginId)
    {
        PluginIsolationSnapshot snapshot = GetSnapshot(pluginId);
        if (snapshot.State is PluginIsolationState.Quarantined or PluginIsolationState.Disabled)
        {
            throw new PluginIsolationException(
                $"Plugin '{pluginId}' cannot execute while its isolation state is {snapshot.State}.");
        }
    }

    private static void TrimFailures(Entry entry, DateTimeOffset now)
    {
        while (entry.Failures.TryPeek(out DateTimeOffset failure)
            && now - failure > s_failureWindow)
        {
            entry.Failures.Dequeue();
        }
    }

    private static PluginIsolationSnapshot ToSnapshot(string pluginId, Entry entry)
        => new(pluginId, entry.State, entry.Failures.Count, entry.UpdatedAtUtc);

    private static void ValidatePluginId(string pluginId)
    {
        if (string.IsNullOrWhiteSpace(pluginId))
        {
            throw new ArgumentException("Plugin id cannot be empty.", nameof(pluginId));
        }
    }

    private sealed class Entry
    {
        public Queue<DateTimeOffset> Failures
        {
            get;
        } = new();

        public PluginIsolationState State
        {
            get;
            set;
        } = PluginIsolationState.Healthy;

        public DateTimeOffset UpdatedAtUtc
        {
            get;
            set;
        }
    }
}

public sealed class PluginCapabilityDeniedException(string message) : UnauthorizedAccessException(message);

public sealed class PluginPermissionApprovalException(string message) : InvalidOperationException(message);

public sealed class PluginResourceLimitException(string message, Exception? innerException = null)
    : InvalidOperationException(message, innerException);

public sealed class PluginIsolationException(string message) : InvalidOperationException(message);
