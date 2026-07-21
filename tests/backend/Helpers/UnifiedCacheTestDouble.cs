using System.Reflection;

using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Infrastructure.Cache;

public interface IUnifiedCache :
    ICacheKeyResolver,
    ICacheTypedReader,
    ICacheRawReader,
    ICacheStringReader,
    ICacheRawWriter,
    ICacheStringWriter,
    ICacheCompareExchangeStore,
    ICacheCounterStore,
    ICacheOneTimeStore,
    ICacheInvalidationStore,
    ICacheLeaseStore,
    ICacheSingleFlightCoordinator,
    ICacheDiagnostics
{
    Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Legacy test double does not implement single-flight coordination.");

    Task<IAsyncDisposable> ICacheSingleFlightCoordinator.AcquireAsync(
        CachePolicyId policyId,
        string identity,
        CancellationToken cancellationToken)
        => AcquireSingleFlightAsync(policyId, identity, cancellationToken);
}

internal static class UnifiedCacheTestExtensions
{
    public static string BuildKey(this UnifiedCache cache, CachePolicyId policyId, string identity, string? version = null)
        => InvokeBuildKey(cache, [typeof(CachePolicyId), typeof(string), typeof(string)], [policyId, identity, version]);

    public static string BuildKey(this UnifiedCache cache, CachePolicyId policyId, int identity, string? version = null)
        => InvokeBuildKey(cache, [typeof(CachePolicyId), typeof(int), typeof(string)], [policyId, identity, version]);

    private static string InvokeBuildKey(UnifiedCache cache, Type[] parameterTypes, object?[] arguments)
    {
        MethodInfo method = typeof(UnifiedCache).GetMethod(
            "BuildKey",
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null,
            parameterTypes,
            modifiers: null) ?? throw new MissingMethodException(typeof(UnifiedCache).FullName, "BuildKey");
        return (string)method.Invoke(cache, arguments)!;
    }
}
