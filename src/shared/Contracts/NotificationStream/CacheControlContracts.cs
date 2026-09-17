namespace FsusBlog.Shared.Contracts.NotificationStream;

/// <summary>
/// Defines the notification-stream transport contract represented by <c>CacheControlPayload</c>.
/// </summary>
public sealed record CacheControlPayload(
    string Type,
    string? Scope = null,
    string? Cache = null,
    IReadOnlyList<string>? Keys = null);

/// <summary>
/// Defines the notification-stream transport contract represented by <c>SearchIndexUpdatePayload</c>.
/// </summary>
public sealed record SearchIndexUpdatePayload(
    string Version,
    string ManifestUrl,
    DateTime GeneratedAt);
