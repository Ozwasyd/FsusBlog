using System.Collections.Frozen;
using System.Globalization;

namespace FsusBlog.Server.Infrastructure.Cache;

internal enum CacheIdentityKind : byte
{
    String = 0,
    Integer = 1
}

/// <summary>
/// Process-local cache identity. It intentionally does not contain the final Redis key.
/// </summary>
internal readonly record struct CacheL1Key(
    string Scope,
    CachePolicyId PolicyId,
    CacheIdentityKind IdentityKind,
    string? StringIdentity,
    int IntegerIdentity,
    string? Version)
{
    public static CacheL1Key ForString(string scope, CachePolicyId policyId, string identity, string? version = null)
        => new(scope, policyId, CacheIdentityKind.String, CacheIdentity.Normalize(identity), 0, CacheIdentity.NormalizeVersion(version));

    public static CacheL1Key ForInteger(string scope, CachePolicyId policyId, int identity, string? version = null)
        => new(scope, policyId, CacheIdentityKind.Integer, null, identity, CacheIdentity.NormalizeVersion(version));
}

internal readonly record struct CacheIdentity(
    CacheIdentityKind Kind,
    string? StringValue,
    int IntegerValue,
    string? Version)
{
    public static CacheIdentity FromString(string value, string? version = null)
        => new(CacheIdentityKind.String, Normalize(value), 0, NormalizeVersion(version));

    public static CacheIdentity FromInteger(int value, string? version = null)
        => new(CacheIdentityKind.Integer, null, value, NormalizeVersion(version));

    public CacheL1Key ToL1Key(string scope, CachePolicyId policyId)
        => Kind == CacheIdentityKind.Integer
            ? CacheL1Key.ForInteger(scope, policyId, IntegerValue, Version)
            : CacheL1Key.ForString(scope, policyId, StringValue!, Version);

    public string BuildRedisKey(CachePolicy policy)
        => Kind == CacheIdentityKind.Integer
            ? policy.BuildKey(IntegerValue, Version)
            : policy.BuildKey(StringValue!, Version);

    internal static string Normalize(string value)
        => string.IsNullOrWhiteSpace(value) ? "default" : value.Trim();

    internal static string? NormalizeVersion(string? version)
        => string.IsNullOrWhiteSpace(version) ? null : version.Trim();
}

internal static class CachePolicyTelemetry
{
    private static readonly FrozenDictionary<CachePolicyId, string> Names =
        Enum.GetValues<CachePolicyId>()
            .ToFrozenDictionary(static id => id, static id => id.ToString());

    public static string Name(CachePolicyId policyId)
        => Names.TryGetValue(policyId, out string? name)
            ? name
            : ((int)policyId).ToString(CultureInfo.InvariantCulture);
}
