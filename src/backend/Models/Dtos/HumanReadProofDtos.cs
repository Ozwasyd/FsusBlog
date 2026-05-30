namespace FsusBlog.Server.Models.Dtos;

public sealed record class HumanReadChallengeResponse(
    string Token,
    string Scope,
    string RouteKey,
    int? ArticleId,
    int MinDwellMs,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt);

public sealed record class HumanReadChallengeRequest(
    string Scope,
    string RouteKey,
    int? ArticleId);

public sealed record class HumanReadSubmitRequest(
    string Token,
    string Scope,
    string RouteKey,
    int? ArticleId,
    int DwellMs);

public sealed record class HumanReadSubmitResponse(
    bool Counted,
    string Status);

public sealed record class JsonApiResponse<T>(
    bool Success,
    T? Data,
    string? Message = null)
{
    public static JsonApiResponse<T> Ok(T data) => new(true, data);

    public static JsonApiResponse<T> Fail(string message) => new(false, default, message);
}
