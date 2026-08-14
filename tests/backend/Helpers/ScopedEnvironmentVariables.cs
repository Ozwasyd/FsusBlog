#nullable enable

using System.Collections;
using System.Runtime.ExceptionServices;

namespace FsusBlog.Server.Tests.Fixtures;

public sealed class ScopedEnvironmentVariables : IDisposable, IAsyncDisposable
{
    private readonly IReadOnlyDictionary<string, EnvironmentVariableSnapshot> _snapshots;
    private int _disposed;

    public ScopedEnvironmentVariables(IEnumerable<string> variableNames)
    {
        ArgumentNullException.ThrowIfNull(variableNames);

        StringComparer nameComparer = OperatingSystem.IsWindows()
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal;
        var snapshots = new Dictionary<string, EnvironmentVariableSnapshot>(nameComparer);
        IDictionary environment = Environment.GetEnvironmentVariables(EnvironmentVariableTarget.Process);

        foreach (string variableName in variableNames)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(variableName);
            if (!snapshots.TryAdd(
                    variableName,
                    new EnvironmentVariableSnapshot(
                        environment.Contains(variableName),
                        Environment.GetEnvironmentVariable(variableName, EnvironmentVariableTarget.Process))))
            {
                throw new ArgumentException(
                    $"Environment variable '{variableName}' was requested more than once.",
                    nameof(variableNames));
            }
        }

        _snapshots = snapshots;
    }

    public void Set(string variableName, string? value)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        ArgumentException.ThrowIfNullOrWhiteSpace(variableName);
        if (!_snapshots.ContainsKey(variableName))
        {
            throw new InvalidOperationException(
                $"Environment variable '{variableName}' was not included in this scope.");
        }

        Environment.SetEnvironmentVariable(variableName, value, EnvironmentVariableTarget.Process);
    }

    public static void Run(
        IEnumerable<string> variableNames,
        Action<ScopedEnvironmentVariables> action)
    {
        ArgumentNullException.ThrowIfNull(action);

        var scope = new ScopedEnvironmentVariables(variableNames);
        Exception? bodyFailure = null;
        try
        {
            action(scope);
        }
        catch (Exception exception)
        {
            bodyFailure = exception;
        }

        Exception? cleanupFailure = null;
        try
        {
            scope.Dispose();
        }
        catch (Exception exception)
        {
            cleanupFailure = exception;
        }

        if (bodyFailure is not null && cleanupFailure is not null)
        {
            throw new AggregateException(
                "The scoped environment-variable body and cleanup both failed.",
                bodyFailure,
                cleanupFailure);
        }

        if (bodyFailure is not null)
        {
            ExceptionDispatchInfo.Capture(bodyFailure).Throw();
        }

        if (cleanupFailure is not null)
        {
            ExceptionDispatchInfo.Capture(cleanupFailure).Throw();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        List<Exception>? failures = null;
        foreach ((string variableName, EnvironmentVariableSnapshot snapshot) in _snapshots)
        {
            try
            {
                Environment.SetEnvironmentVariable(
                    variableName,
                    snapshot.Exists ? snapshot.Value ?? string.Empty : null,
                    EnvironmentVariableTarget.Process);
            }
            catch (Exception exception)
            {
                (failures ??= []).Add(
                    new InvalidOperationException(
                        $"Failed to restore environment variable '{variableName}'.",
                        exception));
            }
        }

        if (failures is not null)
        {
            throw new AggregateException(
                "One or more environment variables could not be restored.",
                failures);
        }
    }

    public ValueTask DisposeAsync()
    {
        Dispose();
        return ValueTask.CompletedTask;
    }

    private sealed record EnvironmentVariableSnapshot(bool Exists, string? Value);
}
