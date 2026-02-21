using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using StackExchange.Redis;
using System.Buffers.Text;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Services;

/// <summary>
/// 基于 Redis 的工作量证明 (PoW) 校验服务 
/// </summary>
public class RedisPowService : IPowService
{
    private readonly IDatabase _redis;
    private readonly byte[] _cachedPowKey;
    private readonly ILogger<RedisPowService> _logger;
    private readonly AdaptivePowGovernor _governor;

    public RedisPowService(
        IConnectionMultiplexer redis,
        IConfiguration config,
        ILogger<RedisPowService> logger,
        AdaptivePowGovernor governor)
    {
        _logger = logger;
        _redis = redis.GetDatabase();
        _governor = governor;

        string? secretKey = config["Jwt:SecretKey"];
        if (string.IsNullOrEmpty(secretKey))
            throw new ArgumentException("POW SecretKey (Jwt:SecretKey) is missing");

        _cachedPowKey = SHA256.HashData(Encoding.UTF8.GetBytes(secretKey));
    }

    public async Task<bool> VerifyAsync(IPowRequest req, string clientIp)
    {
        // 1. 签名校验 (恢复原版逻辑：包含 IP)
        if (!BasicValidate(req, clientIp))
        {
            _logger.LogWarning("PoW 签名非法 | Salt: {Salt}", req.PowSalt);
            return false;
        }

        // 2. 算力验算 (保持 C++ 引擎的高性能)
        if (!CheckWorkloadWithSpan(req)) return false;

        // 依靠 5 分钟时间戳窗口实现自然防线，允许窗口内多次验证。
        return true;
    }

    public async Task<PowChallenge> GenerateChallengeAsync(string clientIp)
    {
        string normalizedIp = NormalizeIp(clientIp);
        string salt = GenerateRandomSalt();
        long timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        int difficulty = await _governor.GetDifficultyForIpAsync(normalizedIp);

        Span<byte> buffer = stackalloc byte[128];
        if (!TryFormatSignatureData(buffer, normalizedIp, salt, difficulty, timestamp, out int bytesWritten))
        {
            return await GenerateChallengeFallbackAsync(normalizedIp, salt, difficulty, timestamp);
        }

        Span<byte> hashResult = stackalloc byte[32];
        HMACSHA256.HashData(_cachedPowKey, buffer[..bytesWritten], hashResult);

        return new PowChallenge(salt, difficulty, timestamp, Convert.ToBase64String(hashResult));
    }

    private bool BasicValidate(IPowRequest req, string ip)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (Math.Abs(now - req.PowTimestamp) > 300) return false;

        string normalizedIp = NormalizeIp(ip);
        Span<byte> buffer = stackalloc byte[128];
        if (!TryFormatSignatureData(buffer, normalizedIp, req.PowSalt, req.Difficulty, req.PowTimestamp, out int bytesWritten))
            return false;

        Span<byte> computedHash = stackalloc byte[32];
        HMACSHA256.HashData(_cachedPowKey, buffer[..bytesWritten], computedHash);

        try
        {
            byte[] clientSignature = Convert.FromBase64String(req.PowSignature);
            return CryptographicOperations.FixedTimeEquals(computedHash, clientSignature);
        }
        catch { return false; }
    }

    private static bool TryFormatSignatureData(Span<byte> destination, string ip, string salt, int diff, long ts, out int bytesWritten)
    {
        int offset = 0;
        Encoding.UTF8.GetBytes(ip, destination[offset..]);
        offset += Encoding.UTF8.GetByteCount(ip);
        destination[offset++] = (byte)':';

        Encoding.UTF8.GetBytes(salt, destination[offset..]);
        offset += Encoding.UTF8.GetByteCount(salt);
        destination[offset++] = (byte)':';

        Utf8Formatter.TryFormat(diff, destination[offset..], out int diffBytes);
        offset += diffBytes;
        destination[offset++] = (byte)':';

        Utf8Formatter.TryFormat(ts, destination[offset..], out int tsBytes);
        offset += tsBytes;

        bytesWritten = offset;
        return true;
    }

    private static bool CheckWorkloadWithSpan(IPowRequest req)
    {
        Span<byte> dataBuffer = stackalloc byte[256];
        int offset = 0;
        TryWriteUtf8(req.PowSalt, dataBuffer, ref offset);
        dataBuffer[offset++] = (byte)':';
        TryWriteUtf8(req.PowNonce, dataBuffer, ref offset);
        dataBuffer[offset++] = (byte)':';
        TryWriteUtf8(req.BrowserFp, dataBuffer, ref offset);
        return PowNativeInterop.VerifyPowWorkload(in MemoryMarshal.GetReference(dataBuffer), offset, req.Difficulty);
    }

    private static bool TryWriteUtf8(string value, Span<byte> destination, ref int offset)
    {
        if (string.IsNullOrEmpty(value)) return true;
        offset += Encoding.UTF8.GetBytes(value, destination[offset..]);
        return true;
    }

    private static string NormalizeIp(string ip) => System.Net.IPAddress.TryParse(ip, out var parsed) ? parsed.ToString() : ip;

    private static string GenerateRandomSalt()
    {
        Span<byte> saltBytes = stackalloc byte[16];
        RandomNumberGenerator.Fill(saltBytes);
        return Convert.ToHexString(saltBytes);
    }

    private async Task<PowChallenge> GenerateChallengeFallbackAsync(string ip, string salt, int diff, long ts)
    {
        byte[] data = Encoding.UTF8.GetBytes($"{NormalizeIp(ip)}:{salt}:{diff}:{ts}");
        byte[] hash = HMACSHA256.HashData(_cachedPowKey, data);
        return new PowChallenge(salt, diff, ts, Convert.ToBase64String(hash));
    }
}

internal static partial class PowNativeInterop
{
    [LibraryImport("FsusPowEngine", EntryPoint = "verify_pow_workload")]
    [return: MarshalAs(UnmanagedType.U1)]
    internal static partial bool VerifyPowWorkload(in byte data, int length, int difficulty);
}