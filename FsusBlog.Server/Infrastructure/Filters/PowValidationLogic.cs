using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Mvc;
using System.Buffers;
using System.Buffers.Text;
using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Filters;

internal static partial class PowValidationLogic
{
    private const string PowHeaderName = "X-Fsus-Pow-Proof";
    private const string PowQueryName = "pow";

    public static Task<IActionResult?> ValidateAsync(HttpContext httpContext, ILogger logger, IPowService powService, AdaptivePowGovernor governor)
    {
        if (!httpContext.Request.Headers.TryGetValue(PowHeaderName, out var encodedProof) || encodedProof.Count != 1)
        {
            return Task.FromResult<IActionResult?>(new UnauthorizedObjectResult(Fail(httpContext, "安全校验凭证缺失 (Header)", 401)));
        }
        return CoreValidationAsync(httpContext, encodedProof[0]!, logger, powService, governor);
    }

    public static Task<IActionResult?> ValidateFromQueryAsync(HttpContext httpContext, ILogger logger, IPowService powService, AdaptivePowGovernor governor)
    {
        if (!httpContext.Request.Query.TryGetValue(PowQueryName, out var encodedProof) || encodedProof.Count != 1)
        {
            return Task.FromResult<IActionResult?>(new UnauthorizedObjectResult(Fail(httpContext, "安全校验凭证缺失 (Query)", 401)));
        }
        return CoreValidationAsync(httpContext, encodedProof[0]!, logger, powService, governor);
    }

    private static async Task<IActionResult?> CoreValidationAsync(HttpContext httpContext, string encodedProof, ILogger logger, IPowService powService, AdaptivePowGovernor governor)
    {
        var clientIp = httpContext.GetClientIp();
        governor.RecordInboundRequest();

        byte[]? rentedBuffer = null;
        try
        {
            int bufferSize = Base64.GetMaxDecodedFromUtf8Length(encodedProof.Length);
            rentedBuffer = ArrayPool<byte>.Shared.Rent(bufferSize);

            if (!Convert.TryFromBase64String(encodedProof, rentedBuffer, out int bytesWritten))
            {
                return new BadRequestObjectResult(Fail(httpContext, "安全凭证格式异常 (Base64)", 400));
            }

            var powRequest = JsonSerializer.Deserialize(rentedBuffer.AsSpan(0, bytesWritten), PowJsonContext.Default.VirtualPowRequest);
            if (powRequest is null) return new BadRequestObjectResult(Fail(httpContext, "安全凭证解析失败 (JSON)", 400));

            int requiredDifficulty = await governor.GetDifficultyForIpAsync(clientIp);
            if (powRequest.Difficulty < requiredDifficulty)
            {
                return new ObjectResult(Fail(httpContext, "算力凭证已失效，请重试", 403)) { StatusCode = 403 };
            }

            // [修复 2026-02-24] 核心重构：代理穿透与 IP 漂移自动修正逻辑
            // 逻辑自洽：由于 Docker 桥接网络可能导致 WebSocket 握手时丢头，我们需要测试可能的候选 IP
            bool isValid = await powService.VerifyAsync(powRequest, clientIp);

            if (!isValid)
            {
                var rawIp = httpContext.Connection.RemoteIpAddress?.MapToIPv4().ToString();
                int lastDot = clientIp.LastIndexOf('.');
                string? gatewayIp = lastDot > 0 ? string.Concat(clientIp.AsSpan(0, lastDot + 1), "1") : null;

                isValid = await TryProbeCandidateAsync(powService, powRequest, clientIp, rawIp, logger)
                          || await TryProbeCandidateAsync(powService, powRequest, clientIp, gatewayIp, logger)
                          || await TryProbeCandidateAsync(powService, powRequest, clientIp, "127.0.0.1", logger)
                          || await TryProbeCandidateAsync(powService, powRequest, clientIp, "172.17.0.1", logger)
                          || await TryProbeCandidateAsync(powService, powRequest, clientIp, "172.18.0.1", logger);
            }

            if (!isValid)
            {
                LogAccessDenied(logger, clientIp, "Signature/Nonce Verification Failed");
                return new UnauthorizedObjectResult(Fail(httpContext, "安全校验未通过或凭证已过期", 401));
            }

            return null;
        }
        catch (JsonException)
        {
            return new BadRequestObjectResult(Fail(httpContext, "安全凭证解析失败 (JSON)", 400));
        }
        finally
        {
            if (rentedBuffer != null) ArrayPool<byte>.Shared.Return(rentedBuffer, clearArray: true);
        }
    }

    private static ApiResponse Fail(HttpContext httpContext, string message, int statusCode)
        => ApiResponse.Fail(message, statusCode, httpContext.TraceIdentifier);

    [LoggerMessage(EventId = 101, Level = LogLevel.Warning, Message = "PoW 验证逻辑拒绝访问 | IP: {IP} | 原因: {Reason}")]
    private static partial void LogAccessDenied(ILogger logger, string ip, string reason);

    [LoggerMessage(EventId = 102, Level = LogLevel.Information, Message = "PoW 代理穿透修正成功 | 原始 IP: {RealIp} | 退化 IP: {ProxyIp}")]
    private static partial void LogProxyDriftCorrected(ILogger logger, string realIp, string proxyIp);

    private static async Task<bool> TryProbeCandidateAsync(
        IPowService powService,
        IPowRequest powRequest,
        string currentIp,
        string? candidateIp,
        ILogger logger)
    {
        if (string.IsNullOrWhiteSpace(candidateIp) || string.Equals(candidateIp, currentIp, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (!await powService.VerifyAsync(powRequest, candidateIp))
        {
            return false;
        }

        LogProxyDriftCorrected(logger, candidateIp, currentIp);
        return true;
    }
}
