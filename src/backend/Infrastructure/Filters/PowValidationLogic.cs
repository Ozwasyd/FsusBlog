using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using Microsoft.AspNetCore.Mvc;
using System.Buffers;
using System.Buffers.Binary;
using System.Buffers.Text;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Filters;

internal static partial class PowValidationLogic
{
    private const string PowHeaderName = "X-Fsus-Pow-Proof";
    private const string PowQueryName = "pow";
    private const int MaxSaltUtf8Bytes = 128;
    private const int MaxNonceUtf8Bytes = 64;
    private const int MaxSignatureUtf8Bytes = 128;
    private const int MaxBrowserFingerprintUtf8Bytes = 256;

    public static async Task<IActionResult?> ValidateAsync(HttpContext httpContext, ILogger logger, IPowService powService, AdaptivePowGovernor governor)
    {
        if (!httpContext.Request.Headers.TryGetValue(PowHeaderName, out var encodedProof) || encodedProof.Count != 1)
        {
            await AddRiskAsync(httpContext, CrawlerRiskReason.PowInvalid, 5);
            return new UnauthorizedObjectResult(Fail(httpContext, ErrorCode.Unauthorized, "安全校验凭证缺失 (Header)"));
        }

        return await CoreValidationAsync(httpContext, encodedProof[0]!, logger, powService, governor);
    }

    public static async Task<IActionResult?> ValidateFromQueryAsync(HttpContext httpContext, ILogger logger, IPowService powService, AdaptivePowGovernor governor)
    {
        if (!httpContext.Request.Query.TryGetValue(PowQueryName, out var encodedProof) || encodedProof.Count != 1)
        {
            await AddRiskAsync(httpContext, CrawlerRiskReason.PowInvalid, 5);
            return new UnauthorizedObjectResult(Fail(httpContext, ErrorCode.Unauthorized, "安全校验凭证缺失 (Query)"));
        }

        return await CoreValidationAsync(httpContext, encodedProof[0]!, logger, powService, governor);
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
                await AddRiskAsync(httpContext, CrawlerRiskReason.PowInvalid, 5);
                return new BadRequestObjectResult(Fail(httpContext, ErrorCode.Validation, "安全凭证格式异常 (Base64)"));
            }

            var proofSpan = rentedBuffer.AsSpan(0, bytesWritten);
            if (!TryDecodeBinaryProof(proofSpan, out var powRequest))
            {
                await AddRiskAsync(httpContext, CrawlerRiskReason.PowInvalid, 5);
                return new BadRequestObjectResult(Fail(httpContext, ErrorCode.Validation, "安全凭证解析失败 (binary)"));
            }

            int requiredDifficulty = await governor.GetDifficultyForIpAsync(clientIp);
            if (powRequest.Difficulty < requiredDifficulty)
            {
                await AddRiskAsync(httpContext, CrawlerRiskReason.PowInvalid, 5);
                return new ObjectResult(Fail(httpContext, ErrorCode.Forbidden, "算力凭证已失效，请重试")) { StatusCode = 403 };
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
                await AddRiskAsync(httpContext, CrawlerRiskReason.PowInvalid, 10);
                return new UnauthorizedObjectResult(Fail(httpContext, ErrorCode.Unauthorized, "安全校验未通过或凭证已过期"));
            }

            return null;
        }
        finally
        {
            if (rentedBuffer != null) ArrayPool<byte>.Shared.Return(rentedBuffer, clearArray: true);
        }
    }

    private static ErrorDetail Fail(HttpContext httpContext, ErrorCode code, string message)
        => ErrorDetail.Create(code, message, traceId: httpContext.TraceIdentifier);

    private static async Task AddRiskAsync(HttpContext httpContext, CrawlerRiskReason reason, int score)
    {
        var risk = httpContext.RequestServices.GetService<ICrawlerRiskService>();
        if (risk is null)
        {
            return;
        }

        try
        {
            await risk.AddRiskAsync(httpContext, reason, score, TimeSpan.FromMinutes(10), httpContext.RequestAborted);
        }
        catch
        {
            // PoW validation result must not depend on telemetry persistence.
        }
    }

    private static bool TryDecodeBinaryProof(ReadOnlySpan<byte> source, out VirtualPowRequest proof)
    {
        proof = new VirtualPowRequest();
        if (source.Length < 17
            || source[0] != (byte)'F'
            || source[1] != (byte)'P'
            || source[2] != (byte)'O'
            || source[3] != (byte)'W'
            || source[4] != 1)
        {
            return false;
        }

        int difficulty = BinaryPrimitives.ReadInt32LittleEndian(source.Slice(5, sizeof(int)));
        long timestamp = BinaryPrimitives.ReadInt64LittleEndian(source.Slice(9, sizeof(long)));
        int offset = 17;
        if (!TryReadString(source, ref offset, MaxSaltUtf8Bytes, out string salt)
            || !TryReadString(source, ref offset, MaxNonceUtf8Bytes, out string nonce)
            || !TryReadString(source, ref offset, MaxSignatureUtf8Bytes, out string signature)
            || !TryReadString(source, ref offset, MaxBrowserFingerprintUtf8Bytes, out string browserFp)
            || offset != source.Length)
        {
            proof = new VirtualPowRequest();
            return false;
        }

        proof = new VirtualPowRequest
        {
            PowSalt = salt,
            PowNonce = nonce,
            Difficulty = difficulty,
            PowTimestamp = timestamp,
            PowSignature = signature,
            BrowserFp = browserFp
        };
        return true;
    }

    private static bool TryReadString(ReadOnlySpan<byte> source, ref int offset, int maxUtf8Bytes, out string value)
    {
        value = string.Empty;
        if (offset + sizeof(ushort) > source.Length)
        {
            return false;
        }

        int length = BinaryPrimitives.ReadUInt16LittleEndian(source.Slice(offset, sizeof(ushort)));
        offset += sizeof(ushort);
        if (length < 0 || length > maxUtf8Bytes || offset + length > source.Length)
        {
            return false;
        }

        value = Encoding.UTF8.GetString(source.Slice(offset, length));
        offset += length;
        return true;
    }

    [LoggerMessage(EventId = 101, Level = LogLevel.Information, Message = "PoW 验证逻辑拒绝访问 | IP: {IP} | 原因: {Reason}")]
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
