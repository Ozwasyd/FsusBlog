using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services;

public readonly record struct AuthBinaryClientContext(
    string ClientIp,
    string? DeviceFingerprint,
    string? UserAgent)
{
    private const string DeviceFingerprintHeader = "X-Fsus-Device-Fp";

    public static AuthBinaryClientContext From(HttpContext httpContext)
        => new(
            httpContext.GetClientIp(),
            GetDeviceFingerprint(httpContext),
            httpContext.Request.Headers.UserAgent.ToString());

    private static string? GetDeviceFingerprint(HttpContext httpContext)
    {
        if (!httpContext.Request.Headers.TryGetValue(DeviceFingerprintHeader, out var raw))
        {
            return null;
        }

        string? value = raw.ToString();
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return value.Length <= 128 ? value : value[..128];
    }
}

public readonly record struct AuthBinarySessionTokens(
    string AccessToken,
    DateTimeOffset AccessTokenExpiresAtUtc,
    string RefreshToken,
    string SessionId,
    DateTime RefreshTokenExpiresAt);

public readonly record struct AuthBinaryFlowResult(
    bool Success,
    ErrorDetail Error,
    AuthLoginFlowDto Flow,
    AuthBinarySessionTokens? SessionTokens,
    AuthBinaryEnrollmentCredential? EnrollmentCredential = null);

public readonly record struct AuthBinaryEnrollmentCredential(string Token, DateTime ExpiresAt);

public sealed class AuthBinaryApplicationFacade(
    IAnonymousAccountBootstrapService anonymousBootstrap)
{
    public async Task<AuthBinaryFlowResult> BootstrapAnonymousAccountAsync(AuthAnonymousBootstrapRequestCoreModel request, AuthBinaryClientContext client, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!request.AcceptedGuidelines)
        {
            return Fail(ErrorCode.Validation, "请先确认匿名账号使用规范");
        }

        var bootstrap = await anonymousBootstrap.BootstrapAsync(request.PublicHandle, cancellationToken);
        if (!bootstrap.Success || bootstrap.User is null)
        {
            var code = string.Equals(bootstrap.Message, "公开称呼已被占用", StringComparison.Ordinal)
                ? ErrorCode.Conflict
                : bootstrap.Message.Contains("匿名身份模式", StringComparison.Ordinal)
                    ? ErrorCode.Forbidden
                    : ErrorCode.Validation;
            return Fail(code, bootstrap.Message);
        }

        var flow = new AuthLoginFlowDto(
            bootstrap.User.Value.Id,
            ResolveIdentityKind(bootstrap.User.Value.IdentityKind),
            "enrollment_required",
            null,
            null);
        return new AuthBinaryFlowResult(
            true,
            ErrorDetail.None,
            flow,
            null,
            new AuthBinaryEnrollmentCredential(bootstrap.EnrollmentToken!, bootstrap.EnrollmentExpiresAt!.Value));
    }

    private static AuthBinaryFlowResult Fail(ErrorCode code, string message)
        => new(false, ErrorDetail.Create(code, message), default, null, null);

    private static string ResolveIdentityKind(string? identityKind)
        => string.IsNullOrWhiteSpace(identityKind) ? AnonymousIdentityRuntime.AnonymousAccountKind : identityKind.Trim();
}
