using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Infrastructure.Filters;

internal static partial class PowValidationLogic
{
    private const string PowQueryName = "pow";

    public static async Task<IActionResult?> ValidateAsync(HttpContext httpContext, ILogger logger, IPowService powService, AdaptivePowGovernor governor)
    {
        if (!httpContext.Request.Headers.TryGetValue(PowProofCodec.HeaderName, out var encodedProof) || encodedProof.Count != 1)
        {
            await AddRiskAsync(httpContext, SecurityRiskReason.PowInvalid, 5);
            return new UnauthorizedObjectResult(Fail(httpContext, ErrorCode.Unauthorized, "安全校验凭证缺失 (Header)"));
        }

        return await CoreValidationAsync(httpContext, encodedProof[0]!, logger, powService, governor);
    }

    public static async Task<IActionResult?> ValidateFromQueryAsync(HttpContext httpContext, ILogger logger, IPowService powService, AdaptivePowGovernor governor)
    {
        if (!httpContext.Request.Query.TryGetValue(PowQueryName, out var encodedProof) || encodedProof.Count != 1)
        {
            await AddRiskAsync(httpContext, SecurityRiskReason.PowInvalid, 5);
            return new UnauthorizedObjectResult(Fail(httpContext, ErrorCode.Unauthorized, "安全校验凭证缺失 (Query)"));
        }

        return await CoreValidationAsync(httpContext, encodedProof[0]!, logger, powService, governor);
    }

    private static async Task<IActionResult?> CoreValidationAsync(HttpContext httpContext, string encodedProof, ILogger logger, IPowService powService, AdaptivePowGovernor governor)
    {
        var clientIp = httpContext.GetClientIp();
        governor.RecordInboundRequest();

        if (!PowProofCodec.TryDecodeBase64Proof(encodedProof, out var powRequest, out PowProofDecodeFailure failure))
        {
            await AddRiskAsync(httpContext, SecurityRiskReason.PowInvalid, 5);
            string message = failure == PowProofDecodeFailure.Base64
                ? "安全凭证格式异常 (Base64)"
                : "安全凭证解析失败 (binary)";
            return new BadRequestObjectResult(Fail(httpContext, ErrorCode.Validation, message));
        }

        int requiredDifficulty = await governor.GetDifficultyForIpAsync(clientIp);
        if (powRequest.Difficulty < requiredDifficulty)
        {
            await AddRiskAsync(httpContext, SecurityRiskReason.PowInvalid, 5);
            return new ObjectResult(Fail(httpContext, ErrorCode.Forbidden, "算力凭证已失效，请重试")) { StatusCode = 403 };
        }

        bool isValid;
        try
        {
            isValid = await powService.VerifyAsync(powRequest, clientIp);
        }
        catch (Exception ex)
        {
            string clientIpHash = ResolveClientIpHashForLog(httpContext, clientIp);
            logger.LogWarning(ex, "PoW 内部校验异常已归一为拒绝 | ClientIpHash: {ClientIpHash} | TraceId: {TraceId}", clientIpHash, httpContext.TraceIdentifier);
            await AddRiskAsync(httpContext, SecurityRiskReason.PowInvalid, 10);
            return new UnauthorizedObjectResult(Fail(httpContext, ErrorCode.Unauthorized, "安全校验未通过或凭证已过期"));
        }

        if (!isValid)
        {
            string clientIpHash = ResolveClientIpHashForLog(httpContext, clientIp);
            LogAccessDenied(logger, clientIpHash, httpContext.TraceIdentifier, "Signature/Nonce Verification Failed");
            await AddRiskAsync(httpContext, SecurityRiskReason.PowInvalid, 10);
            return new UnauthorizedObjectResult(Fail(httpContext, ErrorCode.Unauthorized, "安全校验未通过或凭证已过期"));
        }

        return null;
    }

    private static ErrorDetail Fail(HttpContext httpContext, ErrorCode code, string message)
        => ErrorDetail.Create(code, message, traceId: httpContext.TraceIdentifier);

    private static async Task AddRiskAsync(HttpContext httpContext, SecurityRiskReason reason, int score)
    {
        var risk = httpContext.RequestServices.GetService<ISecurityRiskSignalSink>();
        if (risk is null)
        {
            return;
        }

        try
        {
            await risk.AddRiskAsync(new SecurityRiskSignal(
                httpContext,
                reason,
                score,
                TimeSpan.FromMinutes(10),
                SecurityRiskSources.Pow,
                "pow_invalid",
                "pow_validation"), httpContext.RequestAborted);
        }
        catch
        {
            // PoW validation result must not depend on telemetry persistence.
        }
    }

    private static string ResolveClientIpHashForLog(HttpContext httpContext, string clientIp)
    {
        var pseudonymizer = httpContext.RequestServices.GetService<IVisitLogIpPseudonymizer>();
        if (pseudonymizer is null)
        {
            return "ip_hash_unavailable";
        }

        try
        {
            TimeProvider timeProvider = httpContext.RequestServices.GetService<TimeProvider>() ?? TimeProvider.System;
            return pseudonymizer.PseudonymizeCurrent(
                VisitLogIpPseudonymScope.SecurityLog,
                clientIp,
                timeProvider.GetUtcNow()).Hash;
        }
        catch
        {
            return "ip_hash_unavailable";
        }
    }

    [LoggerMessage(EventId = 101, Level = LogLevel.Information, Message = "PoW 验证逻辑拒绝访问 | ClientIpHash: {ClientIpHash} | TraceId: {TraceId} | 原因: {Reason}")]
    private static partial void LogAccessDenied(ILogger logger, string clientIpHash, string traceId, string reason);
}
