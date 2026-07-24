using System.Collections.Concurrent;

using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.Plugins;

/// <summary>
/// Bounded, plugin-scoped operational evidence. This store is intentionally a
/// node-local telemetry cache; cluster entries that have not reported to the
/// current node are represented as unknown by the admin read model.
/// </summary>
public sealed class PluginObservabilityStore(
    TimeProvider timeProvider,
    ClusterMembershipOptions cluster)
{
    private const int MaximumExecutionsPerPlugin = 200;
    private const int MaximumLogsPerPlugin = 200;
    private const int MaximumErrorsPerPlugin = 100;
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    public void RecordRuntimeLoad(
        string pluginId,
        string version,
        PluginRuntimeType runtime,
        IReadOnlyList<string> hooks,
        bool success,
        string? errorCode = null)
    {
        Entry entry = GetEntry(pluginId);
        lock (entry.Gate)
        {
            entry.Version = version;
            entry.Runtime = runtime;
            entry.RuntimeLoaded = success;
            entry.RegisteredHooks = success
                ? hooks.Order(StringComparer.Ordinal).ToArray()
                : [];
            entry.RuntimeLoadCount++;
            if (!success)
            {
                entry.RuntimeLoadFailureCount++;
                AddError(entry, pluginId, runtime, "runtime.load", string.Empty, errorCode ?? "runtime_load_failed");
            }
        }
    }

    public void RecordRuntimeUnload(string pluginId)
    {
        Entry entry = GetEntry(pluginId);
        lock (entry.Gate)
        {
            entry.RuntimeLoaded = false;
            entry.RegisteredHooks = [];
        }
    }

    public void RecordPermissionDenied(
        string pluginId,
        PluginRuntimeType runtime,
        string hookName,
        string traceId)
    {
        Entry entry = GetEntry(pluginId);
        lock (entry.Gate)
        {
            entry.PermissionDeniedCount++;
            AddError(entry, pluginId, runtime, hookName, traceId, "permission_denied");
        }
    }

    public void RecordQuarantine(string pluginId)
    {
        Entry entry = GetEntry(pluginId);
        lock (entry.Gate)
        {
            entry.QuarantineCount++;
        }
    }

    public void RecordExecution(
        string pluginId,
        PluginRuntimeType runtime,
        string hookName,
        double durationMilliseconds,
        bool success,
        string? errorCode,
        bool timeout,
        long memoryUsedBytes,
        long memoryBudgetBytes,
        string traceId,
        string failPolicy,
        string scope)
    {
        Entry entry = GetEntry(pluginId);
        lock (entry.Gate)
        {
            entry.Runtime = runtime;
            entry.ExecutionCount++;
            entry.TotalDurationMilliseconds += durationMilliseconds;
            entry.MaximumDurationMilliseconds =
                Math.Max(entry.MaximumDurationMilliseconds, durationMilliseconds);
            if (success)
            {
                entry.SuccessCount++;
            }
            else
            {
                entry.ErrorCount++;
                if (timeout)
                {
                    entry.TimeoutCount++;
                }
                AddError(entry, pluginId, runtime, hookName, traceId, errorCode ?? "hook_failed");
            }

            AddBounded(
                entry.Executions,
                new PluginAdminExecutionMetricDto(
                    pluginId,
                    entry.Version,
                    RuntimeName(runtime),
                    hookName,
                    durationMilliseconds,
                    success,
                    errorCode,
                    timeout,
                    memoryUsedBytes,
                    memoryBudgetBytes,
                    cluster.NodeId.Value,
                    traceId,
                    failPolicy,
                    scope,
                    timeProvider.GetUtcNow()),
                MaximumExecutionsPerPlugin);
        }
    }

    public void RecordLog(
        string pluginId,
        PluginRuntimeType runtime,
        string hookName,
        string traceId,
        string level,
        string message)
    {
        Entry entry = GetEntry(pluginId);
        lock (entry.Gate)
        {
            AddBounded(
                entry.Logs,
                new PluginAdminLogDto(
                    pluginId,
                    RuntimeName(runtime),
                    hookName,
                    cluster.NodeId.Value,
                    traceId,
                    level,
                    message,
                    timeProvider.GetUtcNow()),
                MaximumLogsPerPlugin);
        }
    }

    public PluginNodeObservabilitySnapshot Capture(string pluginId)
    {
        Entry entry = GetEntry(pluginId);
        lock (entry.Gate)
        {
            return new PluginNodeObservabilitySnapshot(
                entry.RuntimeLoaded,
                Array.AsReadOnly(entry.RegisteredHooks.ToArray()),
                entry.Errors.LastOrDefault()?.Code,
                new PluginAdminMetricSummaryDto(
                    entry.ExecutionCount,
                    entry.SuccessCount,
                    entry.ErrorCount,
                    entry.TimeoutCount,
                    entry.PermissionDeniedCount,
                    entry.QuarantineCount,
                    entry.RuntimeLoadCount,
                    entry.RuntimeLoadFailureCount,
                    entry.ExecutionCount == 0
                        ? 0
                        : entry.TotalDurationMilliseconds / entry.ExecutionCount,
                    entry.MaximumDurationMilliseconds),
                Array.AsReadOnly(entry.Executions.Reverse().ToArray()),
                Array.AsReadOnly(entry.Logs.Reverse().ToArray()),
                Array.AsReadOnly(entry.Errors.Reverse().ToArray()));
        }
    }

    private void AddError(
        Entry entry,
        string pluginId,
        PluginRuntimeType runtime,
        string hookName,
        string traceId,
        string code)
        => AddBounded(
            entry.Errors,
            new PluginAdminErrorDto(
                pluginId,
                RuntimeName(runtime),
                hookName,
                cluster.NodeId.Value,
                traceId,
                NormalizeCode(code),
                timeProvider.GetUtcNow()),
            MaximumErrorsPerPlugin);

    private Entry GetEntry(string pluginId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pluginId);
        return _entries.GetOrAdd(pluginId, static _ => new Entry());
    }

    private static void AddBounded<T>(Queue<T> queue, T value, int maximum)
    {
        queue.Enqueue(value);
        while (queue.Count > maximum)
        {
            queue.Dequeue();
        }
    }

    private static string RuntimeName(PluginRuntimeType runtime)
        => runtime == PluginRuntimeType.JavaScript ? "ts/js" : "lua";

    private static string NormalizeCode(string code)
    {
        string normalized = string.Concat(
            code.Trim().ToLowerInvariant().Select(static character =>
                char.IsAsciiLetterOrDigit(character) ? character : '_'));
        return normalized.Length is > 0 and <= 96
            ? normalized
            : "plugin_failure";
    }

    private sealed class Entry
    {
        public object Gate { get; } = new();

        public string Version { get; set; } = "unknown";

        public PluginRuntimeType Runtime
        {
            get;
            set;
        }

        public bool RuntimeLoaded
        {
            get;
            set;
        }

        public string[] RegisteredHooks { get; set; } = [];

        public long ExecutionCount
        {
            get;
            set;
        }

        public long SuccessCount
        {
            get;
            set;
        }

        public long ErrorCount
        {
            get;
            set;
        }

        public long TimeoutCount
        {
            get;
            set;
        }

        public long PermissionDeniedCount
        {
            get;
            set;
        }

        public long QuarantineCount
        {
            get;
            set;
        }

        public long RuntimeLoadCount
        {
            get;
            set;
        }

        public long RuntimeLoadFailureCount
        {
            get;
            set;
        }

        public double TotalDurationMilliseconds
        {
            get;
            set;
        }

        public double MaximumDurationMilliseconds
        {
            get;
            set;
        }

        public Queue<PluginAdminExecutionMetricDto> Executions { get; } = new();

        public Queue<PluginAdminLogDto> Logs { get; } = new();

        public Queue<PluginAdminErrorDto> Errors { get; } = new();
    }
}

public sealed record PluginNodeObservabilitySnapshot(
    bool RuntimeLoaded,
    IReadOnlyList<string> RegisteredHooks,
    string? LastErrorCode,
    PluginAdminMetricSummaryDto Metrics,
    IReadOnlyList<PluginAdminExecutionMetricDto> RecentExecutions,
    IReadOnlyList<PluginAdminLogDto> RecentLogs,
    IReadOnlyList<PluginAdminErrorDto> RecentErrors);

internal static class PluginExecutionAmbientContext
{
    private static readonly AsyncLocal<Context?> s_current = new();

    public static Context? Current => s_current.Value;

    public static IDisposable Push(
        string pluginId,
        PluginRuntimeType runtime,
        string hookName,
        string traceId)
    {
        Context? previous = s_current.Value;
        s_current.Value = new Context(pluginId, runtime, hookName, traceId);
        return new Scope(previous);
    }

    internal sealed record Context(
        string PluginId,
        PluginRuntimeType Runtime,
        string HookName,
        string TraceId);

    private sealed class Scope(Context? previous) : IDisposable
    {
        private Context? _previous = previous;

        public void Dispose()
        {
            Context? snapshot = Interlocked.Exchange(ref _previous, null);
            s_current.Value = snapshot;
        }
    }
}
