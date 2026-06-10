namespace FsusBlog.Shared.Contracts.NotificationStream;

public sealed record CacheControlPayload(
    string Type,
    string? Scope = null,
    string? Cache = null,
    IReadOnlyList<string>? Keys = null);

public sealed record SearchIndexUpdatePayload(
    string Version,
    string ManifestUrl,
    DateTime GeneratedAt);
