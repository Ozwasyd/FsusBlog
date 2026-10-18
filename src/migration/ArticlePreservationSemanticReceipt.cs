using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

internal static class ArticlePreservationSemanticReceipt
{
    private static readonly UTF8Encoding s_strictUtf8 = new(false, true);
    private static readonly JsonSerializerOptions s_json = new() { WriteIndented = false };

    // Artifact hashes bind all bytes; semantic digests are separate, domain-separated values.
    internal static byte[] Serialize<T>(T value) => JsonSerializer.SerializeToUtf8Bytes(value, s_json);
    internal static string HashBytes(ReadOnlySpan<byte> bytes)
        => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    internal static string HashMarkdown(string value) => HashBytes(s_strictUtf8.GetBytes(value));
    internal static string Digest<T>(string domain, T value)
        => HashBytes(Serialize(new
        {
            Domain = domain,
            Value = value
        }));

    internal static void RequireArtifact<T>(CurrentSchemaArtifactReference reference, ImmutableArray<byte> bytes, T data)
    {
        if (reference is null || string.IsNullOrWhiteSpace(reference.Reference)
            || bytes.IsDefaultOrEmpty || !IsDigest(reference.Sha256)
            || HashBytes(bytes.AsSpan()) != reference.Sha256
            || !bytes.AsSpan().SequenceEqual(Serialize(data)))
            throw new InvalidOperationException("article_preservation_artifact_binding");
    }

    internal static bool IsDigest(string? value)
        => value is { Length: 64 } && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    internal static string ComputePlanDigest(ArticlePreservationWritePlan plan)
        => Digest("article-preservation-write-plan-v1", plan with
        {
            ContentDigest = string.Empty
        });
}
