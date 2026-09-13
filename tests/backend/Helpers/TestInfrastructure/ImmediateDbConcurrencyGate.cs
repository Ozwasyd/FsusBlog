using FsusBlog.Server.Infrastructure.Execution;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal sealed class ImmediateDbConcurrencyGate : IClassifiedDbConcurrencyGate
{
    public Task<T> ExecuteAsync<T>(
        string operation,
        Func<CancellationToken, Task<T>> action,
        Func<CancellationToken, Task<T>> onTimeout,
        CancellationToken cancellationToken = default)
        => action(cancellationToken);

    public Task<T> ExecuteClassifiedAsync<T>(
        DbWorkloadClass workload,
        string operation,
        Func<CancellationToken, Task<T>> action,
        Func<CancellationToken, Task<T>> onTimeout,
        CancellationToken cancellationToken = default)
        => action(cancellationToken);

    public DbConcurrencyGateSnapshot GetSnapshot() => new(1, 0, 0);

    public DbConcurrencyGateDiagnostics GetDiagnostics()
        => new(1, 1, new Dictionary<string, DbWorkloadGateSnapshot>(StringComparer.Ordinal));
}
