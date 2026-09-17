using System.Text.Json;

using FsusBlog.Shared.Contracts.Validation;

namespace FsusBlog.Server.Services.Security;

public readonly record struct AnonymitySetDecision(
    bool Allowed,
    string EffectiveRateClass,
    int SetSize,
    int MinimumSetSize,
    string Status);

public sealed class AnonymitySetPolicy(IConfiguration configuration)
{
    public const int ProductionMinimumSetSize = 20;
    private const int MaximumConfiguredMinimum = 10_000;

    public int MinimumSetSize
    {
        get
        {
            int configured = Math.Clamp(
                configuration.GetValue("AnonymousIdentity:AnonymitySet:MinimumSetSize", ProductionMinimumSetSize),
                1,
                MaximumConfiguredMinimum);
            return IsProduction() ? Math.Max(ProductionMinimumSetSize, configured) : configured;
        }
    }

    public AnonymitySetDecision Evaluate(
        bool isEligible,
        bool mayComment,
        string? rateClass,
        bool requiresModeration,
        ReadOnlySpan<byte> rootMetadata)
    {
        string normalizedRateClass = NormalizeRateClass(rateClass);
        if (!isEligible || !mayComment || rootMetadata.IsEmpty)
        {
            return Reject(normalizedRateClass, 0, "predicate_not_eligible");
        }

        IReadOnlyList<VisibleAnonymitySet> sets = Parse(rootMetadata);
        VisibleAnonymitySet? exact = sets.FirstOrDefault(item =>
            item.IsEligible == isEligible &&
            item.MayComment == mayComment &&
            item.RequiresModeration == requiresModeration &&
            string.Equals(item.RateClass, normalizedRateClass, StringComparison.Ordinal));
        if (exact is not null && exact.Size >= MinimumSetSize && IsPublicRateClass(normalizedRateClass))
        {
            return new(true, normalizedRateClass, exact.Size, MinimumSetSize, "allowed");
        }

        string mergedClass = AnonymousPrivacyContract.CommonRateClass;
        VisibleAnonymitySet? merged = sets.FirstOrDefault(item =>
            item.IsEligible == isEligible &&
            item.MayComment == mayComment &&
            item.RequiresModeration == requiresModeration &&
            string.Equals(item.RateClass, mergedClass, StringComparison.Ordinal));
        if (merged is not null && merged.Size >= MinimumSetSize)
        {
            return new(false, mergedClass, merged.Size, MinimumSetSize, "merge_required");
        }

        mergedClass = AnonymousPrivacyContract.UnknownRateClass;
        merged = sets.FirstOrDefault(item =>
            item.IsEligible == isEligible &&
            item.MayComment == mayComment &&
            item.RequiresModeration == requiresModeration &&
            string.Equals(item.RateClass, mergedClass, StringComparison.Ordinal));
        return merged is not null && merged.Size >= MinimumSetSize
            ? new(false, mergedClass, merged.Size, MinimumSetSize, "merge_required")
            : Reject(normalizedRateClass, exact?.Size ?? 0, "anonymity_set_too_small");
    }

    private AnonymitySetDecision Reject(string rateClass, int size, string status)
        => new(false, rateClass, size, MinimumSetSize, status);

    private bool IsProduction()
        => string.Equals(
            configuration["ASPNETCORE_ENVIRONMENT"] ?? Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT"),
            "Production",
            StringComparison.OrdinalIgnoreCase);

    private static bool IsPublicRateClass(string value)
        => string.Equals(value, AnonymousPrivacyContract.CommonRateClass, StringComparison.Ordinal) ||
            string.Equals(value, AnonymousPrivacyContract.UnknownRateClass, StringComparison.Ordinal);

    private static string NormalizeRateClass(string? value)
        => string.IsNullOrWhiteSpace(value)
            ? AnonymousPrivacyContract.UnknownRateClass
            : value.Trim().ToLowerInvariant();

    private static IReadOnlyList<VisibleAnonymitySet> Parse(ReadOnlySpan<byte> metadata)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(metadata.ToArray());
            if (!document.RootElement.TryGetProperty("anonymity_sets", out JsonElement sets) ||
                sets.ValueKind != JsonValueKind.Array)
            {
                return [];
            }

            var result = new List<VisibleAnonymitySet>();
            foreach (JsonElement item in sets.EnumerateArray())
            {
                if (item.TryGetProperty("is_eligible", out JsonElement eligible) &&
                    item.TryGetProperty("may_comment", out JsonElement mayComment) &&
                    item.TryGetProperty("rate_class", out JsonElement rateClass) &&
                    item.TryGetProperty("requires_moderation", out JsonElement requiresModeration) &&
                    item.TryGetProperty("size", out JsonElement size) &&
                    (eligible.ValueKind is JsonValueKind.True or JsonValueKind.False) &&
                    (mayComment.ValueKind is JsonValueKind.True or JsonValueKind.False) &&
                    (requiresModeration.ValueKind is JsonValueKind.True or JsonValueKind.False) &&
                    size.TryGetInt32(out int count) && count >= 0)
                {
                    result.Add(new(
                        eligible.GetBoolean(),
                        mayComment.GetBoolean(),
                        NormalizeRateClass(rateClass.GetString()),
                        requiresModeration.GetBoolean(),
                        count));
                }
            }

            return result;
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private sealed record VisibleAnonymitySet(
        bool IsEligible,
        bool MayComment,
        string RateClass,
        bool RequiresModeration,
        int Size);
}
