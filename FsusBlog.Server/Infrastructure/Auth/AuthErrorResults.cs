using FsusBlog.Server.Infrastructure.Results;
using Microsoft.AspNetCore.Http.HttpResults;

namespace FsusBlog.Server.Infrastructure.Auth;

public static class AuthErrorResults
{
    public static JsonHttpResult<FsusBlog.Server.Models.Responses.ApiResponse> InvalidRequest(string message = "INVALID_REQUEST")
        => ApiResults.Unprocessable(message);

    public static JsonHttpResult<FsusBlog.Server.Models.Responses.ApiResponse> ChallengeRequired(string message = "CHALLENGE_TOKEN_REQUIRED")
        => ApiResults.Unprocessable(message);

    public static JsonHttpResult<FsusBlog.Server.Models.Responses.ApiResponse> ChallengeExpired(string message = "CHALLENGE_EXPIRED")
        => ApiResults.Unprocessable(message);

    public static JsonHttpResult<FsusBlog.Server.Models.Responses.ApiResponse> InvalidTotp(string message = "INVALID_TOTP")
        => ApiResults.Unprocessable(message);

    public static NotFound<FsusBlog.Server.Models.Responses.ApiResponse> UserNotFound(string message = "用户不存在")
        => ApiResults.NotFound(message);
}
