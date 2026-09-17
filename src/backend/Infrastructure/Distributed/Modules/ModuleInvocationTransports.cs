using System.Collections.Concurrent;

using FsusBlog.Server.Infrastructure.Distributed.Cluster;

namespace FsusBlog.Server.Infrastructure.Distributed.Modules;

public sealed record RemoteModuleInvocationRequest(NodeId TargetNode, ModuleInvocationEnvelope Envelope);

public interface IRemoteModuleTransport
{
    ValueTask<object?> SendAsync(
        RemoteModuleInvocationRequest request,
        CancellationToken cancellationToken);
}

public interface IModuleQueueTransport
{
    ValueTask<object?> EnqueueAsync(
        ModuleInvocationEnvelope envelope,
        CancellationToken cancellationToken);
}

public interface IModuleEventTransport
{
    ValueTask<object?> PublishAsync(
        ModuleInvocationEnvelope envelope,
        CancellationToken cancellationToken);
}

public sealed record RemoteModuleInvocationOptions(
    int MaxConcurrency,
    int MaxAttempts,
    int CircuitFailureThreshold,
    TimeSpan CircuitOpenDuration,
    TimeSpan RetryDelay)
{
    public static RemoteModuleInvocationOptions Default
    {
        get;
    } =
        new(128, 3, 5, TimeSpan.FromSeconds(15), TimeSpan.FromMilliseconds(25));

    public RemoteModuleInvocationOptions Validate()
    {
        if (MaxConcurrency is < 1 or > 4096
            || MaxAttempts is < 1 or > 5
            || CircuitFailureThreshold is < 1 or > 100
            || CircuitOpenDuration <= TimeSpan.Zero
            || CircuitOpenDuration > TimeSpan.FromMinutes(5)
            || RetryDelay < TimeSpan.Zero
            || RetryDelay > TimeSpan.FromSeconds(5))
        {
            throw new InvalidOperationException("module_remote_policy_invalid");
        }
        return this;
    }
}

public sealed class ResilientRemoteModuleInvocationPath : IModuleInvocationPath
{
    private readonly IRemoteModuleTransport _transport;
    private readonly RemoteModuleInvocationOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly SemaphoreSlim _capacity;
    private readonly ConcurrentDictionary<ModuleContractId, CircuitState> _circuits = new();

    public ResilientRemoteModuleInvocationPath(
        IRemoteModuleTransport transport,
        RemoteModuleInvocationOptions options,
        TimeProvider timeProvider)
    {
        _transport = transport;
        _options = options.Validate();
        _timeProvider = timeProvider;
        _capacity = new SemaphoreSlim(options.MaxConcurrency, options.MaxConcurrency);
    }

    public ModuleInvocationPathKind Kind => ModuleInvocationPathKind.Remote;

    public async ValueTask<object?> InvokeAsync(
        ModuleInvocationRoute route,
        ModuleInvocationEnvelope envelope,
        CancellationToken cancellationToken)
    {
        NodeId target = route.TargetNode
            ?? throw new InvalidOperationException("module_remote_target_required");
        CircuitState circuit = _circuits.GetOrAdd(envelope.Contract, static _ => new CircuitState());
        DateTimeOffset now = _timeProvider.GetUtcNow();
        lock (circuit)
        {
            if (circuit.OpenUntil > now)
            {
                throw new ModuleCircuitOpenException(envelope.Contract);
            }
            if (circuit.OpenUntil != default)
            {
                circuit.OpenUntil = default;
                circuit.ConsecutiveFailures = 0;
            }
        }

        if (!await _capacity.WaitAsync(0, cancellationToken).ConfigureAwait(false))
        {
            throw new ModuleBackpressureException(envelope.Contract);
        }
        try
        {
            int attempts = envelope.IdempotencyKey is null ? 1 : _options.MaxAttempts;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(envelope.Timeout);
            for (int attempt = 1; ; attempt++)
            {
                try
                {
                    object? result = await _transport.SendAsync(
                        new RemoteModuleInvocationRequest(target, envelope),
                        timeout.Token).ConfigureAwait(false);
                    lock (circuit)
                    {
                        circuit.ConsecutiveFailures = 0;
                        circuit.OpenUntil = default;
                    }
                    return result;
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception) when (attempt < attempts)
                {
                    await Task.Delay(_options.RetryDelay, _timeProvider, timeout.Token)
                        .ConfigureAwait(false);
                }
                catch
                {
                    lock (circuit)
                    {
                        circuit.ConsecutiveFailures++;
                        if (circuit.ConsecutiveFailures >= _options.CircuitFailureThreshold)
                        {
                            circuit.OpenUntil = _timeProvider.GetUtcNow().Add(_options.CircuitOpenDuration);
                        }
                    }
                    throw;
                }
            }
        }
        finally
        {
            _capacity.Release();
        }
    }

    private sealed class CircuitState
    {
        public int ConsecutiveFailures
        {
            get; set;
        }

        public DateTimeOffset OpenUntil
        {
            get; set;
        }
    }
}

public sealed class QueueModuleInvocationPath(IModuleQueueTransport transport) : IModuleInvocationPath
{
    public ModuleInvocationPathKind Kind => ModuleInvocationPathKind.Queue;

    public ValueTask<object?> InvokeAsync(
        ModuleInvocationRoute route,
        ModuleInvocationEnvelope envelope,
        CancellationToken cancellationToken)
        => transport.EnqueueAsync(envelope, cancellationToken);
}

public sealed class EventModuleInvocationPath(IModuleEventTransport transport) : IModuleInvocationPath
{
    public ModuleInvocationPathKind Kind => ModuleInvocationPathKind.Event;

    public ValueTask<object?> InvokeAsync(
        ModuleInvocationRoute route,
        ModuleInvocationEnvelope envelope,
        CancellationToken cancellationToken)
        => transport.PublishAsync(envelope, cancellationToken);
}
