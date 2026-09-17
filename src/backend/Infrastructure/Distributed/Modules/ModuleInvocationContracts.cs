using System.Diagnostics;

using FsusBlog.Server.Infrastructure.Distributed.Cluster;

namespace FsusBlog.Server.Infrastructure.Distributed.Modules;

public readonly record struct ModuleContractId
{
    public ModuleContractId(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        string normalized = value.Trim().ToLowerInvariant();
        if (normalized.Length > 64
            || normalized.Any(static character =>
                !char.IsAsciiLetterOrDigit(character) && character is not '.' and not '-'))
        {
            throw new ArgumentOutOfRangeException(nameof(value), value, "Invalid module contract id.");
        }
        Value = normalized;
    }

    public string Value
    {
        get;
    }

    public override string ToString() => Value;
}

public readonly record struct ModuleContractVersion
{
    public ModuleContractVersion(ushort major, ushort minor)
    {
        if (major == 0)
        {
            throw new ArgumentOutOfRangeException(nameof(major));
        }
        Major = major;
        Minor = minor;
    }

    public ushort Major
    {
        get;
    }

    public ushort Minor
    {
        get;
    }

    public bool Accepts(ModuleContractVersion requested)
        => Major == requested.Major && Minor >= requested.Minor;

    public override string ToString() => $"{Major}.{Minor}";
}

public sealed record ModuleContractDescriptor(
    ModuleContractId Id,
    ModuleContractVersion Version,
    CapabilityId Capability,
    string Owner,
    IReadOnlyList<string> OwnedStoragePrefixes);

public static class CoreModuleContracts
{
    public static readonly ModuleContractDescriptor Comment = Contract(
        "comment", ClusterCapabilities.CommentApi, "Comment", "comment", "comment_");
    public static readonly ModuleContractDescriptor Audit = Contract(
        "audit", ClusterCapabilities.CommentAudit, "Audit", "audit_", "security_audit_");
    public static readonly ModuleContractDescriptor Search = Contract(
        "search", ClusterCapabilities.SearchQuery, "Search", "search_");
    public static readonly ModuleContractDescriptor Media = Contract(
        "media", ClusterCapabilities.MediaProcessor, "Media", "media_", "upload_");
    public static readonly ModuleContractDescriptor Notification = Contract(
        "notification", ClusterCapabilities.WebApi, "Notification", "msg_", "notification_");

    public static IReadOnlyList<ModuleContractDescriptor> All
    {
        get;
    } =
        [Comment, Audit, Search, Media, Notification];

    public static ModuleContractDescriptor Get(ModuleContractId id)
        => All.SingleOrDefault(contract => contract.Id == id)
            ?? throw new InvalidOperationException($"module_contract_unknown:{id}");

    private static ModuleContractDescriptor Contract(
        string id,
        CapabilityId capability,
        string owner,
        params string[] storagePrefixes)
        => new(new ModuleContractId(id), new ModuleContractVersion(1, 0), capability, owner, storagePrefixes);
}

public enum ModuleDeliveryKind
{
    RequestResponse = 0,
    Queue = 1,
    Event = 2
}

public sealed record ModuleCall<TRequest, TResult>(
    ModuleContractDescriptor Contract,
    string Operation,
    TRequest Request,
    ModuleDeliveryKind Delivery = ModuleDeliveryKind.RequestResponse,
    string? IdempotencyKey = null,
    TimeSpan? Timeout = null)
{
    public ModuleCall<TRequest, TResult> Validate()
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(Operation);
        if (Operation.Length > 96)
        {
            throw new ArgumentOutOfRangeException(nameof(Operation));
        }
        if (Timeout.HasValue
            && (Timeout.Value <= TimeSpan.Zero || Timeout.Value > TimeSpan.FromMinutes(5)))
        {
            throw new ArgumentOutOfRangeException(nameof(Timeout));
        }
        if (Delivery == ModuleDeliveryKind.Queue && string.IsNullOrWhiteSpace(IdempotencyKey))
        {
            throw new InvalidOperationException("module_queue_idempotency_required");
        }
        return this;
    }
}

public sealed record ModuleInvocationEnvelope(
    ModuleContractId Contract,
    ModuleContractVersion Version,
    string Operation,
    ModuleDeliveryKind Delivery,
    object Request,
    string? IdempotencyKey,
    TimeSpan Timeout,
    string? TraceParent,
    string? TraceState,
    IReadOnlyDictionary<string, string> Baggage)
{
    public static ModuleInvocationEnvelope Create<TRequest, TResult>(ModuleCall<TRequest, TResult> call)
    {
        call.Validate();
        Activity? current = Activity.Current;
        return new ModuleInvocationEnvelope(
            call.Contract.Id,
            call.Contract.Version,
            call.Operation.Trim(),
            call.Delivery,
            call.Request!,
            NormalizeIdempotencyKey(call.IdempotencyKey),
            call.Timeout ?? TimeSpan.FromSeconds(10),
            current?.Id,
            current?.TraceStateString,
            current?.Baggage.ToDictionary(
                static item => item.Key,
                static item => item.Value ?? string.Empty,
                StringComparer.Ordinal) ?? new Dictionary<string, string>(StringComparer.Ordinal));
    }

    private static string? NormalizeIdempotencyKey(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }
        string normalized = value.Trim();
        if (normalized.Length > 160)
        {
            throw new ArgumentOutOfRangeException(nameof(value));
        }
        return normalized;
    }
}

public interface IModuleInvoker
{
    ValueTask<TResult> InvokeAsync<TRequest, TResult>(
        ModuleCall<TRequest, TResult> call,
        CancellationToken cancellationToken = default);
}

public enum ModuleInvocationPathKind
{
    Local = 0,
    Remote = 1,
    Queue = 2,
    Event = 3
}

public sealed record ModuleInvocationRoute(ModuleInvocationPathKind Path, NodeId? TargetNode);

public interface IModuleRouteResolver
{
    ValueTask<ModuleInvocationRoute> ResolveAsync(
        ModuleContractDescriptor contract,
        ModuleDeliveryKind delivery,
        CancellationToken cancellationToken);
}

public interface IModuleInvocationPath
{
    ModuleInvocationPathKind Kind
    {
        get;
    }

    ValueTask<object?> InvokeAsync(
        ModuleInvocationRoute route,
        ModuleInvocationEnvelope envelope,
        CancellationToken cancellationToken);
}

public interface ILocalModuleOperation
{
    ModuleContractId Contract
    {
        get;
    }

    string Operation
    {
        get;
    }

    ModuleContractVersion Version
    {
        get;
    }

    Type RequestType
    {
        get;
    }

    Type ResultType
    {
        get;
    }

    ValueTask<object?> InvokeAsync(object request, CancellationToken cancellationToken);
}

public abstract class LocalModuleOperation<TRequest, TResult> : ILocalModuleOperation
{
    protected LocalModuleOperation(ModuleContractDescriptor contract, string operation)
    {
        Contract = contract.Id;
        Version = contract.Version;
        ArgumentException.ThrowIfNullOrWhiteSpace(operation);
        Operation = operation.Trim();
    }

    public ModuleContractId Contract
    {
        get;
    }

    public string Operation
    {
        get;
    }

    public ModuleContractVersion Version
    {
        get;
    }

    public Type RequestType => typeof(TRequest);

    public Type ResultType => typeof(TResult);

    public abstract ValueTask<TResult> InvokeTypedAsync(
        TRequest request,
        CancellationToken cancellationToken);

    async ValueTask<object?> ILocalModuleOperation.InvokeAsync(
        object request,
        CancellationToken cancellationToken)
        => await InvokeTypedAsync((TRequest)request, cancellationToken).ConfigureAwait(false);
}
