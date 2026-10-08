using System.Collections.Frozen;
using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Operations;

/// <summary>
/// Immutable read-only source contribution. This is not the current-run observation
/// contract or a readiness receipt: the existing diagnostic sources do not prove
/// namespace, immutable watermark, worker incarnation and commit coverage.
/// </summary>
public sealed record QuiescenceSourceCapture(
    string DomainId,
    string SourceApi,
    bool SourceAvailable,
    IReadOnlyDictionary<string, long?> Metrics,
    IReadOnlyList<string> Blockers,
    string SemanticDigest)
{
    public bool RuntimeQualified => false;

    internal static QuiescenceSourceCapture Create(
        string domainId,
        string sourceApi,
        bool available,
        IReadOnlyDictionary<string, long?> metrics,
        IEnumerable<string> blockers)
    {
        KeyValuePair<string, long?>[] orderedMetrics = metrics.OrderBy(static item => item.Key, StringComparer.Ordinal).ToArray();
        string[] orderedBlockers = blockers.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        byte[] canonical = JsonSerializer.SerializeToUtf8Bytes(new
        {
            DomainId = domainId,
            SourceApi = sourceApi,
            SourceAvailable = available,
            Metrics = orderedMetrics,
            Blockers = orderedBlockers
        });
        return new QuiescenceSourceCapture(
            domainId,
            sourceApi,
            available,
            orderedMetrics.ToFrozenDictionary(static item => item.Key, static item => item.Value, StringComparer.Ordinal),
            Array.AsReadOnly(orderedBlockers),
            "sha256:" + Convert.ToHexStringLower(SHA256.HashData(canonical)));
    }
}
