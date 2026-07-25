using System.Collections.Frozen;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.StateControl;

namespace FsusBlog.Server.Infrastructure.Plugins;

public enum PluginHookType
{
    Filter = 0,
    Action = 1,
    Guard = 2,
    Provider = 3,
    Render = 4,
    Worker = 5
}

public enum PluginHookFailPolicy
{
    FailOpen = 0,
    FailClosed = 1,
    Ignore = 2,
    Quarantine = 3
}

public enum PluginHookExecutionMode
{
    Sync = 0,
    Async = 1,
    Background = 2
}

public enum PluginHookScope
{
    Local = 0,
    ClusterOnce = 1,
    PerNode = 2,
    Scheduled = 3,
    Leased = 4
}

public sealed record PluginHookDefinition(
    string Name,
    PluginHookType Type,
    PluginCapability Capability,
    PluginExecutionBudget MaximumBudget);

public static class PluginHookCatalog
{
    private static readonly IReadOnlyDictionary<string, PluginHookDefinition> s_hooks =
        CreateDefinitions().ToFrozenDictionary(static item => item.Name, StringComparer.Ordinal);

    public static IReadOnlyCollection<string> Names
    {
        get;
    } =
        Array.AsReadOnly(s_hooks.Keys.Order(StringComparer.Ordinal).ToArray());

    public static bool TryGet(string? name, out PluginHookDefinition definition)
        => s_hooks.TryGetValue(name ?? string.Empty, out definition!);

    public static PluginHookDefinition Get(string name)
        => TryGet(name, out PluginHookDefinition? definition)
            ? definition
            : throw new PluginHookDispatchException($"Plugin hook '{name}' is unsupported.");

    private static PluginHookDefinition[] CreateDefinitions()
    {
        PluginExecutionBudget content = new(
            TimeSpan.FromMilliseconds(100), 32 * 1024 * 1024, 250_000, 48, 512 * 1024, 64 * 1024);
        PluginExecutionBudget worker = new(
            TimeSpan.FromSeconds(60), 64 * 1024 * 1024, 5_000_000, 64, 4 * 1024 * 1024, 256 * 1024);
        return
        [
            D("article.beforeSave", PluginHookType.Filter, PluginCapability.ArticleWriteDraft, content),
            D("article.afterSave", PluginHookType.Action, PluginCapability.ArticleWriteDraft, content),
            D("article.beforeRenderMarkdown", PluginHookType.Filter, PluginCapability.ArticleRender, content),
            D("article.afterRenderHtml", PluginHookType.Render, PluginCapability.ArticleRender, content),
            D("article.beforePublish", PluginHookType.Guard, PluginCapability.ArticleWriteDraft, content),
            D("article.afterPublish", PluginHookType.Action, PluginCapability.ArticleWriteDraft, content),
            D("article.beforeDelete", PluginHookType.Guard, PluginCapability.ArticleWriteDraft, content),
            D("comment.beforeCreate", PluginHookType.Filter, PluginCapability.CommentCreate, content),
            D("comment.afterCreate", PluginHookType.Action, PluginCapability.CommentCreate, content),
            D("comment.beforeAudit", PluginHookType.Filter, PluginCapability.CommentModerate, content),
            D("comment.afterAudit", PluginHookType.Action, PluginCapability.CommentModerate, content),
            D("comment.beforeDisplay", PluginHookType.Filter, PluginCapability.CommentRead, content),
            D("comment.beforeDelete", PluginHookType.Guard, PluginCapability.CommentModerate, content),
            D("search.beforeIndex", PluginHookType.Filter, PluginCapability.SearchIndexWrite, content),
            D("search.afterIndex", PluginHookType.Action, PluginCapability.SearchIndexWrite, content),
            D("search.queryRewrite", PluginHookType.Filter, PluginCapability.SearchQueryRewrite, content),
            D("search.resultRank", PluginHookType.Filter, PluginCapability.SearchQueryRewrite, content),
            D("media.beforeUpload", PluginHookType.Guard, PluginCapability.MediaProcess, content),
            D("media.afterUpload", PluginHookType.Action, PluginCapability.MediaProcess, content),
            D("media.beforeProcess", PluginHookType.Filter, PluginCapability.MediaProcess, content),
            D("media.afterProcess", PluginHookType.Action, PluginCapability.MediaProcess, content),
            D("user.beforeLogin", PluginHookType.Guard, PluginCapability.UserAuthHook, content),
            D("user.afterLogin", PluginHookType.Action, PluginCapability.UserAuthHook, content),
            D("user.beforeRegister", PluginHookType.Guard, PluginCapability.UserAuthHook, content),
            D("system.startup", PluginHookType.Action, PluginCapability.PluginLogWrite, worker),
            D("system.shutdown", PluginHookType.Action, PluginCapability.PluginLogWrite, worker),
            D("scheduler.tick", PluginHookType.Worker, PluginCapability.SchedulerJobCreate, worker),
            D("plugin.activate", PluginHookType.Action, PluginCapability.PluginLogWrite, content),
            D("plugin.deactivate", PluginHookType.Action, PluginCapability.PluginLogWrite, content)
        ];
    }

    private static PluginHookDefinition D(
        string name,
        PluginHookType type,
        PluginCapability capability,
        PluginExecutionBudget budget)
        => new(name, type, capability, budget);
}

public sealed record PluginHookContext(
    string HookName,
    string TraceId,
    string OperationId,
    object? Payload,
    IReadOnlyDictionary<string, object?> Items);

public sealed record PluginHookResult(bool Continue, object? Value = null)
{
    public static PluginHookResult Next(object? value = null) => new(true, value);

    public static PluginHookResult Stop(object? value = null) => new(false, value);
}

public sealed record PluginHookDispatchResult(
    bool Continue,
    object? Value,
    int ExecutedCount,
    int FailedCount,
    int SkippedCount);

public sealed record PluginHookRegistration(
    string PluginId,
    PluginRuntimeType Runtime,
    PluginHookDescriptor Descriptor);

public interface IPluginHookRegistry
{
    IReadOnlyList<PluginHookRegistration> Get(string hookName);

    void ReplacePlugin(string pluginId, PluginRuntimeType runtime, IReadOnlyList<PluginHookDescriptor> hooks);

    void RemovePlugin(string pluginId);
}

public sealed class PluginHookRegistry : IPluginHookRegistry
{
    private static readonly IReadOnlyList<PluginHookRegistration> s_empty =
        Array.Empty<PluginHookRegistration>();
    private readonly object _gate = new();
    private IReadOnlyDictionary<string, IReadOnlyList<PluginHookRegistration>> _snapshot =
        new Dictionary<string, IReadOnlyList<PluginHookRegistration>>(StringComparer.Ordinal)
            .ToFrozenDictionary(StringComparer.Ordinal);

    public IReadOnlyList<PluginHookRegistration> Get(string hookName)
        => Volatile.Read(ref _snapshot).GetValueOrDefault(hookName, s_empty);

    public void ReplacePlugin(
        string pluginId,
        PluginRuntimeType runtime,
        IReadOnlyList<PluginHookDescriptor> hooks)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pluginId);
        ArgumentNullException.ThrowIfNull(hooks);
        lock (_gate)
        {
            PluginHookRegistration[] all =
            [
                .. _snapshot.Values.SelectMany(static item => item)
                    .Where(item => !string.Equals(item.PluginId, pluginId, StringComparison.Ordinal)),
                .. hooks.Select(hook => new PluginHookRegistration(pluginId, runtime, hook))
            ];
            _snapshot = all
                .GroupBy(static item => item.Descriptor.Name, StringComparer.Ordinal)
                .ToFrozenDictionary(
                    static group => group.Key,
                    static group => (IReadOnlyList<PluginHookRegistration>)Array.AsReadOnly(
                        group.OrderByDescending(static item => item.Descriptor.Priority)
                            .ThenBy(static item => item.PluginId, StringComparer.Ordinal)
                            .ToArray()),
                    StringComparer.Ordinal);
        }
    }

    public void RemovePlugin(string pluginId)
        => ReplacePlugin(pluginId, PluginRuntimeType.Lua, []);
}

public sealed record PluginHookInvocation(
    string PluginId,
    PluginRuntimeType Runtime,
    PluginHookDefinition Definition,
    PluginHookDescriptor Descriptor,
    PluginHookContext Context,
    PluginExecutionBudgetGuard Budget,
    PluginHostApiProxy HostApi);

public interface IPluginHookRuntimeInvoker
{
    ValueTask<PluginHookResult> InvokeAsync(
        PluginHookInvocation invocation,
        CancellationToken cancellationToken);
}

public sealed class ScriptPluginHookRuntimeInvoker(
    IJavaScriptPluginRuntime javaScript,
    ILuaPluginRuntime lua) : IPluginHookRuntimeInvoker
{
    public ValueTask<PluginHookResult> InvokeAsync(
        PluginHookInvocation invocation,
        CancellationToken cancellationToken)
        => invocation.Runtime switch
        {
            PluginRuntimeType.JavaScript => javaScript.InvokeHookAsync(invocation, cancellationToken),
            PluginRuntimeType.Lua => lua.InvokeHookAsync(invocation, cancellationToken),
            _ => ValueTask.FromException<PluginHookResult>(
                new PluginHookDispatchException(
                    $"Plugin runtime '{invocation.Runtime}' is not available on this node."))
        };
}

public interface IPluginHookScopeCoordinator
{
    ValueTask<PluginHookScopeExecution> ExecuteAsync(
        PluginHookRegistration registration,
        PluginHookContext context,
        Func<CancellationToken, ValueTask<PluginHookResult>> operation,
        CancellationToken cancellationToken);
}

public sealed record PluginHookScopeExecution(bool Executed, PluginHookResult? Result);

public sealed class PluginHookScopeCoordinator(
    ILeaseManager leases,
    IDistributedTaskStateStore tasks,
    ClusterMembershipOptions cluster) : IPluginHookScopeCoordinator
{
    private static readonly TimeSpan s_leaseTtl = TimeSpan.FromMinutes(2);

    public async ValueTask<PluginHookScopeExecution> ExecuteAsync(
        PluginHookRegistration registration,
        PluginHookContext context,
        Func<CancellationToken, ValueTask<PluginHookResult>> operation,
        CancellationToken cancellationToken)
    {
        PluginHookScope scope = PluginHookWireNames.ParseScope(registration.Descriptor.Scope);
        if (scope is PluginHookScope.Local or PluginHookScope.PerNode)
        {
            return new(true, await operation(cancellationToken).ConfigureAwait(false));
        }
        if (!registration.Descriptor.Idempotent)
        {
            throw new PluginHookDispatchException(
                $"Distributed hook '{registration.Descriptor.Name}' must declare idempotent=true.");
        }

        string partition = Convert.ToHexStringLower(SHA256.HashData(
            Encoding.UTF8.GetBytes(
                $"{registration.PluginId}\n{registration.Descriptor.Name}\n{context.OperationId}")));
        var leaseKey = new LeaseKey("plugin-hook", partition);
        LeaseAcquireResult acquire = await leases.TryAcquireAsync(
            leaseKey, cluster.NodeId, s_leaseTtl, cancellationToken).ConfigureAwait(false);
        if (!acquire.Acquired)
        {
            return new(false, null);
        }
        DistributedLease lease = acquire.Lease!;
        try
        {
            var idempotencyKey = new IdempotencyKey(
                $"plugin-hook-{scope.ToString().ToLowerInvariant()}",
                registration.PluginId,
                partition);
            TaskStartResult start = await tasks.TryBeginAsync(
                idempotencyKey,
                lease,
                new TaskFailurePolicy(3, TimeSpan.FromSeconds(5), RequireCompensation: false),
                cancellationToken).ConfigureAwait(false);
            if (start.Disposition != TaskStartDisposition.Acquired)
            {
                return new(false, null);
            }
            try
            {
                PluginHookResult result = await operation(cancellationToken).ConfigureAwait(false);
                await tasks.CompleteAsync(start.Execution!, "hook-complete-v1", cancellationToken)
                    .ConfigureAwait(false);
                return new(true, result);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                await tasks.FailAsync(
                    start.Execution!,
                    exception.GetType().Name,
                    CancellationToken.None).ConfigureAwait(false);
                throw;
            }
        }
        finally
        {
            await leases.ReleaseAsync(
                lease.LeaseId, lease.FencingToken, CancellationToken.None).ConfigureAwait(false);
        }
    }
}

public interface IPluginHookDispatcher
{
    ValueTask<PluginHookDispatchResult> DispatchAsync(
        PluginHookContext context,
        CancellationToken cancellationToken = default);
}

public sealed class PluginHookDispatcher(
    IPluginHookRegistry registry,
    IPluginHookRuntimeInvoker runtime,
    IPluginHookScopeCoordinator scopeCoordinator,
    PluginPermissionManager permissions,
    PluginIsolationController isolation,
    TimeProvider timeProvider,
    PluginObservabilityStore? observability = null) : IPluginHookDispatcher
{
    private static readonly ActivitySource s_activity = new("FsusBlog.PluginHooks");
    private static readonly Meter s_meter = new("FsusBlog.PluginHooks");
    private static readonly Histogram<double> s_duration =
        s_meter.CreateHistogram<double>("fsus.plugin.hook.duration", "ms");
    private static readonly Counter<long> s_failures =
        s_meter.CreateCounter<long>("fsus.plugin.hook.failures");

    public async ValueTask<PluginHookDispatchResult> DispatchAsync(
        PluginHookContext context,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        PluginHookDefinition definition = PluginHookCatalog.Get(context.HookName);
        IReadOnlyList<PluginHookRegistration> registrations = registry.Get(context.HookName);
        if (registrations.Count == 0)
        {
            return new(true, context.Payload, 0, 0, 0);
        }

        object? value = context.Payload;
        int executed = 0;
        int failed = 0;
        int skipped = 0;
        foreach (PluginHookRegistration registration in registrations)
        {
            PluginHookFailPolicy failPolicy =
                PluginHookWireNames.ParseFailPolicy(registration.Descriptor.FailPolicy);
            long started = Stopwatch.GetTimestamp();
            bool success = false;
            bool timeout = false;
            string? errorCode = null;
            long memoryUsedBytes = 0;
            long memoryBudgetBytes = 0;
            using Activity? activity = s_activity.StartActivity("plugin.hook", ActivityKind.Internal);
            activity?.SetTag("plugin.id", registration.PluginId);
            activity?.SetTag("hook.name", definition.Name);
            activity?.SetTag("trace.id", context.TraceId);
            try
            {
                permissions.Demand(registration.PluginId, definition.Capability);
                isolation.DemandExecutable(registration.PluginId);
                PluginExecutionBudget budget = ResolveBudget(registration.Descriptor, definition);
                using var guard = new PluginExecutionBudgetGuard(budget, timeProvider, cancellationToken);
                memoryBudgetBytes = guard.MemoryBudgetBytes;
                var hostApi = new PluginHostApiProxy(registration.PluginId, permissions);
                PluginHookScopeExecution outcome = await scopeCoordinator.ExecuteAsync(
                    registration,
                    context with
                    {
                        Payload = value
                    },
                    token => runtime.InvokeAsync(
                        new PluginHookInvocation(
                            registration.PluginId,
                            registration.Runtime,
                            definition,
                            registration.Descriptor,
                            context with
                            {
                                Payload = value
                            },
                            guard,
                            hostApi),
                        token),
                    guard.CancellationToken).ConfigureAwait(false);
                if (!outcome.Executed)
                {
                    success = true;
                    skipped++;
                    continue;
                }
                executed++;
                PluginHookResult result = outcome.Result;
                memoryUsedBytes = guard.MemoryUsedBytes;
                success = true;
                value = result.Value ?? value;
                if (!result.Continue)
                {
                    return new(false, value, executed, failed, skipped);
                }
            }
            catch (Exception exception) when (
                exception is not OperationCanceledException
                || !cancellationToken.IsCancellationRequested)
            {
                failed++;
                errorCode = exception.GetType().Name;
                s_failures.Add(1,
                    new KeyValuePair<string, object?>("plugin.id", registration.PluginId),
                    new KeyValuePair<string, object?>("hook.name", definition.Name));
                activity?.SetStatus(ActivityStatusCode.Error, exception.GetType().Name);
                timeout = exception is PluginResourceLimitException
                    || exception is OperationCanceledException;
                PluginIsolationSnapshot isolationSnapshot = isolation.RecordFailure(
                    registration.PluginId,
                    criticalHookTimeout: timeout || failPolicy == PluginHookFailPolicy.Quarantine);
                if (exception is PluginCapabilityDeniedException)
                {
                    observability?.RecordPermissionDenied(
                        registration.PluginId,
                        registration.Runtime,
                        definition.Name,
                        context.TraceId);
                }
                if (isolationSnapshot.State == PluginIsolationState.Quarantined)
                {
                    observability?.RecordQuarantine(registration.PluginId);
                }
                if (failPolicy == PluginHookFailPolicy.FailClosed)
                {
                    throw new PluginHookDispatchException(
                        $"Plugin '{registration.PluginId}' blocked hook '{definition.Name}'.",
                        exception);
                }
            }
            finally
            {
                double durationMilliseconds = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
                s_duration.Record(
                    durationMilliseconds,
                    new KeyValuePair<string, object?>("plugin.id", registration.PluginId),
                    new KeyValuePair<string, object?>("hook.name", definition.Name));
                observability?.RecordExecution(
                    registration.PluginId,
                    registration.Runtime,
                    definition.Name,
                    durationMilliseconds,
                    success,
                    errorCode,
                    timeout,
                    memoryUsedBytes,
                    memoryBudgetBytes,
                    context.TraceId,
                    registration.Descriptor.FailPolicy,
                    registration.Descriptor.Scope);
            }
        }
        return new(true, value, executed, failed, skipped);
    }

    private static PluginExecutionBudget ResolveBudget(
        PluginHookDescriptor descriptor,
        PluginHookDefinition definition)
    {
        TimeSpan declared = TimeSpan.FromMilliseconds(descriptor.TimeoutMs);
        if (declared > definition.MaximumBudget.Timeout)
        {
            throw new PluginHookDispatchException(
                $"Plugin hook '{descriptor.Name}' exceeds its maximum timeout.");
        }
        return definition.MaximumBudget with
        {
            Timeout = declared
        };
    }
}

public static class PluginHookWireNames
{
    public static PluginHookFailPolicy ParseFailPolicy(string value) => value switch
    {
        "fail-open" => PluginHookFailPolicy.FailOpen,
        "fail-closed" => PluginHookFailPolicy.FailClosed,
        "ignore" => PluginHookFailPolicy.Ignore,
        "quarantine" => PluginHookFailPolicy.Quarantine,
        _ => throw new PluginHookDispatchException($"Unknown plugin hook fail policy '{value}'.")
    };

    public static PluginHookExecutionMode ParseExecutionMode(string value) => value switch
    {
        "sync" => PluginHookExecutionMode.Sync,
        "async" => PluginHookExecutionMode.Async,
        "background" => PluginHookExecutionMode.Background,
        _ => throw new PluginHookDispatchException($"Unknown plugin hook execution mode '{value}'.")
    };

    public static PluginHookScope ParseScope(string value) => value switch
    {
        "local" => PluginHookScope.Local,
        "cluster-once" => PluginHookScope.ClusterOnce,
        "per-node" => PluginHookScope.PerNode,
        "scheduled" => PluginHookScope.Scheduled,
        "leased" => PluginHookScope.Leased,
        _ => throw new PluginHookDispatchException($"Unknown plugin hook scope '{value}'.")
    };
}

public sealed class UnavailablePluginHookRuntimeInvoker : IPluginHookRuntimeInvoker
{
    public ValueTask<PluginHookResult> InvokeAsync(
        PluginHookInvocation invocation,
        CancellationToken cancellationToken)
        => ValueTask.FromException<PluginHookResult>(
            new PluginHookDispatchException(
                $"Plugin runtime '{invocation.Runtime}' is not available on this node."));
}

public sealed class PluginHookDispatchException(string message, Exception? innerException = null)
    : InvalidOperationException(message, innerException);
