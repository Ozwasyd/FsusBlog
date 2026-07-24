using System.Diagnostics;

using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.Scheduling;
using FsusBlog.Server.Infrastructure.Observability;

namespace FsusBlog.Server.Infrastructure.Distributed.Modules;

public sealed class ClusterModuleRouteResolver(
    ClusterMembershipOptions cluster,
    IClusterMembershipStore membership,
    IResponsibilityActivationView? localAssignments = null) : IModuleRouteResolver
{
    public async ValueTask<ModuleInvocationRoute> ResolveAsync(
        ModuleContractDescriptor contract,
        ModuleDeliveryKind delivery,
        CancellationToken cancellationToken)
    {
        if (delivery == ModuleDeliveryKind.Queue)
        {
            return new ModuleInvocationRoute(ModuleInvocationPathKind.Queue, null);
        }
        if (delivery == ModuleDeliveryKind.Event)
        {
            return new ModuleInvocationRoute(ModuleInvocationPathKind.Event, null);
        }
        if (cluster.Mode == ClusterRuntimeMode.Single)
        {
            return new ModuleInvocationRoute(ModuleInvocationPathKind.Local, cluster.NodeId);
        }

        IReadOnlyList<NodeDescriptor> nodes =
            await membership.ListAliveNodesAsync(cancellationToken).ConfigureAwait(false);
        NodeDescriptor? local = nodes.FirstOrDefault(node =>
            node.NodeId == cluster.NodeId
            && node.Status == ClusterMemberStatus.Alive
            && node.Capabilities.Contains(contract.Capability)
            && (cluster.Mode != ClusterRuntimeMode.Adaptive
                || localAssignments is null
                || localAssignments.IsCapabilityActive(contract.Capability)));
        if (local is not null)
        {
            return new ModuleInvocationRoute(ModuleInvocationPathKind.Local, local.NodeId);
        }

        NodeDescriptor? remote = nodes
            .Where(node => node.NodeId != cluster.NodeId)
            .Where(static node => node.Status == ClusterMemberStatus.Alive)
            .Where(node => node.Capabilities.Contains(contract.Capability))
            .Where(node => cluster.Mode != ClusterRuntimeMode.Adaptive
                || node.ActiveResponsibilities.Contains(contract.Capability))
            .OrderByDescending(node => node.ActiveResponsibilities.Contains(contract.Capability))
            .ThenBy(static node => node.Resources.QueueLength)
            .ThenBy(static node => node.Resources.P95LatencyMilliseconds)
            .ThenBy(static node => node.NodeId.Value, StringComparer.Ordinal)
            .FirstOrDefault();
        return remote is null
            ? throw new ModuleRouteUnavailableException(contract.Id)
            : new ModuleInvocationRoute(ModuleInvocationPathKind.Remote, remote.NodeId);
    }
}

public sealed class ModuleInvoker(
    IModuleRouteResolver router,
    IEnumerable<IModuleInvocationPath> paths) : IModuleInvoker
{
    private readonly IReadOnlyDictionary<ModuleInvocationPathKind, IModuleInvocationPath> _paths =
        paths.ToDictionary(static path => path.Kind);

    public async ValueTask<TResult> InvokeAsync<TRequest, TResult>(
        ModuleCall<TRequest, TResult> call,
        CancellationToken cancellationToken = default)
    {
        call.Validate();
        ModuleInvocationRoute route = await router.ResolveAsync(
            call.Contract,
            call.Delivery,
            cancellationToken).ConfigureAwait(false);
        if (!_paths.TryGetValue(route.Path, out IModuleInvocationPath? path))
        {
            throw new ModuleRouteUnavailableException(call.Contract.Id);
        }

        using Activity? activity = FsusObservability.ActivitySource.StartActivity(
            "module.invoke",
            route.Path == ModuleInvocationPathKind.Remote
                ? ActivityKind.Client
                : ActivityKind.Internal);
        activity?.SetTag("module.contract", call.Contract.Id.Value);
        activity?.SetTag("module.version", call.Contract.Version.ToString());
        activity?.SetTag("module.operation", call.Operation);
        activity?.SetTag("module.path", route.Path.ToString().ToLowerInvariant());
        activity?.SetTag("server.address", route.TargetNode?.Value);

        ModuleInvocationEnvelope envelope = ModuleInvocationEnvelope.Create(call);
        object? result = await path.InvokeAsync(route, envelope, cancellationToken).ConfigureAwait(false);
        return result is TResult typed
            ? typed
            : throw new InvalidOperationException(
                $"module_result_type_mismatch:{call.Contract.Id}:{call.Operation}");
    }
}

public sealed class LocalModuleInvocationPath(IEnumerable<ILocalModuleOperation> operations)
    : IModuleInvocationPath
{
    private readonly IReadOnlyDictionary<(ModuleContractId Contract, string Operation), ILocalModuleOperation>
        _operations = operations.ToDictionary(
            static operation => (operation.Contract, operation.Operation),
            static operation => operation);

    public ModuleInvocationPathKind Kind => ModuleInvocationPathKind.Local;

    public ValueTask<object?> InvokeAsync(
        ModuleInvocationRoute route,
        ModuleInvocationEnvelope envelope,
        CancellationToken cancellationToken)
    {
        if (!_operations.TryGetValue((envelope.Contract, envelope.Operation), out ILocalModuleOperation? operation)
            || !operation.Version.Accepts(envelope.Version))
        {
            throw new ModuleRouteUnavailableException(envelope.Contract);
        }
        if (!operation.RequestType.IsInstanceOfType(envelope.Request))
        {
            throw new InvalidOperationException(
                $"module_request_type_mismatch:{envelope.Contract}:{envelope.Operation}");
        }
        return operation.InvokeAsync(envelope.Request, cancellationToken);
    }
}

public sealed class ModuleRouteUnavailableException(ModuleContractId contract)
    : InvalidOperationException($"module_route_unavailable:{contract}");

public sealed class ModuleBackpressureException(ModuleContractId contract)
    : InvalidOperationException($"module_backpressure:{contract}");

public sealed class ModuleCircuitOpenException(ModuleContractId contract)
    : InvalidOperationException($"module_circuit_open:{contract}");
