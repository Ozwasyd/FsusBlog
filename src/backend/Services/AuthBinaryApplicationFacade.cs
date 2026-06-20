using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Security;
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
    string RefreshToken,
    DateTime RefreshTokenExpiresAt);

public readonly record struct AuthBinaryFlowResult(
    bool Success,
    ErrorDetail Error,
    AuthLoginFlowDto Flow,
    AuthBinarySessionTokens? SessionTokens);

public sealed class AuthBinaryApplicationFacade(
    IUserRegistrationService registration,
    IAnonymousAccountBootstrapService anonymousBootstrap,
    IUserAccountReader users,
    IUserLoginWorkflowService loginWorkflow,
    IMfaChallengeService mfaChallengeService)
{
    public async Task<AuthBinaryFlowResult> LoginAsync(AuthLoginRequestCoreModel request, AuthBinaryClientContext client, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(request.Username) || string.IsNullOrWhiteSpace(request.Password))
        {
            return Fail(ErrorCode.Validation, "用户名或密码不能为空");
        }

        var dto = new LoginDto { Username = request.Username, Password = request.Password, RememberMe = request.RememberMe };
        var check = await loginWorkflow.ValidateCredentialsAsync(dto, client.ClientIp, cancellationToken);
        if (!check.Success || check.User == null)
        {
            return Fail(ErrorCode.Unauthorized, check.Message);
        }

        if (check.User.Value.MfaEnabled)
        {
            var risk = await loginWorkflow.EvaluateLoginRiskAsync(check.User.Value.Id, client.ClientIp, client.DeviceFingerprint, client.UserAgent, cancellationToken);
            var ticket = await mfaChallengeService.CreateLoginChallengeAsync(check.User.Value.Id, risk.RequiresMfa, request.RememberMe);
            var flow = new AuthLoginFlowDto(
                new AuthIdentitySnapshotDto(
                    check.User.Value.Id,
                    check.User.Value.Username,
                    AnonymousIdentityRuntime.ResolveBackendRole(check.User.Value.Role, check.User.Value.IdentityKind)),
                "mfa_required",
                risk.RequiresMfa ? "risk" : "standard",
                ticket.TicketId);
            return new AuthBinaryFlowResult(true, ErrorDetail.None, flow, null);
        }

        return await CompleteLoginAsync(check.User.Value.Id, client, mfaVerified: true, rememberMe: request.RememberMe, cancellationToken: cancellationToken);
    }

    public async Task<AuthBinaryFlowResult> RegisterAsync(AuthRegisterRequestCoreModel request, AuthBinaryClientContext client, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var dto = new RegisterDto
        {
            Username = request.Username,
            Password = request.Password,
            ConfirmPassword = request.ConfirmPassword
        };
        var (success, message) = await registration.RegisterAsync(dto, cancellationToken);
        if (!success)
        {
            var code = string.Equals(message, "用户名已存在", StringComparison.Ordinal) ||
                string.Equals(message, "用户名已被占用", StringComparison.Ordinal)
                    ? ErrorCode.Conflict
                    : ErrorCode.Validation;
            return Fail(code, message);
        }

        UserAccountSnapshot? user = await users.GetAccountByUsernameAsync(request.Username.Trim());
        if (user == null)
        {
            return Fail(ErrorCode.InfraFailure, "注册成功，但初始化会话失败，请改用登录继续");
        }

        var login = await CompleteLoginAsync(user.Value.Id, client, mfaVerified: true, rememberMe: false, cancellationToken: cancellationToken);
        return login.Success
            ? login
            : Fail(ErrorCode.InfraFailure, "注册成功，但自动登录失败，请改用登录继续");
    }

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

        var login = await CompleteLoginAsync(bootstrap.User.Value.Id, client, mfaVerified: true, rememberMe: false, cancellationToken: cancellationToken);
        return login.Success
            ? login
            : Fail(ErrorCode.InfraFailure, "匿名账号已创建，但初始化会话失败，请使用 Recovery Key 或 Passkey 继续");
    }

    private async Task<AuthBinaryFlowResult> CompleteLoginAsync(
        int userId,
        AuthBinaryClientContext client,
        bool mfaVerified,
        bool rememberMe,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var login = await loginWorkflow.CompleteLoginAsync(
            userId,
            client.ClientIp,
            client.DeviceFingerprint,
            client.UserAgent,
            mfaVerified,
            rememberMe,
            cancellationToken);
        if (!login.Success || login.Data == null || login.User == null)
        {
            return Fail(ErrorCode.Unauthorized, login.Message);
        }

        var flow = new AuthLoginFlowDto(
            new AuthIdentitySnapshotDto(
                login.User.Value.Id,
                login.User.Value.Username,
                AnonymousIdentityRuntime.ResolveBackendRole(login.User.Value.Role, login.User.Value.IdentityKind)),
            "authenticated",
            null,
            null);
        var tokens = new AuthBinarySessionTokens(
            login.Data.Value.AccessToken,
            login.Data.Value.RefreshToken,
            login.Data.Value.RefreshTokenExpiresAt);
        return new AuthBinaryFlowResult(true, ErrorDetail.None, flow, tokens);
    }

    private static AuthBinaryFlowResult Fail(ErrorCode code, string message)
        => new(false, ErrorDetail.Create(code, message), default, null);
}
