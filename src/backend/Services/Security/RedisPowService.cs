using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using System.Buffers.Text;
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Services;

/// <summary>
/// 基于 Redis 的工作量证明 (PoW) 校验服务
/// 修复日期: 2026-02-22 (彻底移除 C++ 依赖启用 SHA-NI 硬件加速，消除所有异常控制流与字符串分配)
/// </summary>
public class RedisPowService : IPowService
{
    private const int MaxSaltUtf8Bytes = 128;
    private const int MaxNonceUtf8Bytes = 64;
    private const int MaxSignatureUtf8Bytes = 128;
    private const int MaxBrowserFingerprintUtf8Bytes = 256;
    private static readonly TimeSpan ProofReplayTtl = TimeSpan.FromMinutes(5);
    private static long _lastFallbackWarningTicks;
    private readonly byte[] _cachedPowKey;
    private readonly bool _isFallbackKey;
    private readonly ILogger<RedisPowService> _logger;
    private readonly AdaptivePowGovernor _governor;
    private readonly IUnifiedCache _cache;

    public RedisPowService(
        IConfiguration config,
        ILogger<RedisPowService> logger,
        AdaptivePowGovernor governor,
        IUnifiedCache cache)
    {
        _logger = logger;
        _governor = governor;
        _cache = cache;

        string? secretKey = config["Jwt:SecretKey"];
        if (string.IsNullOrEmpty(secretKey))
        {
            _isFallbackKey = true;
            var fallback = string.Concat("FsusBlog:Pow:Fallback:", Environment.MachineName, ":", AppContext.BaseDirectory);
            _cachedPowKey = SHA256.HashData(Encoding.UTF8.GetBytes(fallback));
            _logger.LogCritical("POW SecretKey 缺失，已启用降级密钥。请立即配置 Jwt:SecretKey。");
        }
        else
        {
            _isFallbackKey = false;
            _cachedPowKey = SHA256.HashData(Encoding.UTF8.GetBytes(secretKey));
        }
    }

    public async Task<bool> VerifyAsync(IPowRequest req, string clientIp)
    {
        if (_isFallbackKey)
        {
            LogFallbackModeThrottled();
        }

        if (!HasValidFieldLengths(req))
        {
            _logger.LogWarning("PoW 字段长度超限 | Salt: {Salt}", req.PowSalt);
            return false;
        }

        // 1. 签名校验 (防重放与篡改)
        if (!BasicValidate(req, clientIp))
        {
            _logger.LogInformation("PoW 签名非法 | Salt: {Salt}", req.PowSalt);
            return false;
        }

        // 2. 算力验算 (纯 C# SHA-NI 硬件加速)
        if (!CheckWorkloadWithSpan(req)) return false;

        // 3. Redis-backed consume-once protection: the same normalized proof can be accepted only once.
        return await TryConsumeProofOnceAsync(req, clientIp).ConfigureAwait(false);
    }

    private void LogFallbackModeThrottled()
    {
        long now = DateTime.UtcNow.Ticks;
        long last = Interlocked.Read(ref _lastFallbackWarningTicks);
        if (now - last < TimeSpan.FromMinutes(5).Ticks)
        {
            return;
        }

        Interlocked.Exchange(ref _lastFallbackWarningTicks, now);
        _logger.LogWarning("POW 当前运行在降级密钥模式。");
    }

    public async Task<PowChallenge> GenerateChallengeAsync(string clientIp)
    {
        string normalizedIp = NormalizeIp(clientIp);
        string salt = GenerateRandomSalt();
        long timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        int difficulty = await _governor.GetDifficultyForIpAsync(normalizedIp);

        // 性能保障：容量从 128 扩充至 256，物理杜绝溢出可能，彻底消灭 Fallback 回退分配
        Span<byte> buffer = stackalloc byte[256];
        if (!TryFormatSignatureData(buffer, normalizedIp, salt, difficulty, timestamp, out int bytesWritten))
        {
            throw new InvalidOperationException("PoW signature input exceeds fixed buffer capacity.");
        }

        Span<byte> hashResult = stackalloc byte[32];
        HMACSHA256.HashData(_cachedPowKey, buffer[..bytesWritten], hashResult);

        return new PowChallenge(salt, difficulty, timestamp, Convert.ToBase64String(hashResult));
    }

    private bool BasicValidate(IPowRequest req, string ip)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (!IsTimestampWithinWindow(req.PowTimestamp, now)) return false;

        string normalizedIp = NormalizeIp(ip);
        Span<byte> buffer = stackalloc byte[256];
        if (!TryFormatSignatureData(buffer, normalizedIp, req.PowSalt, req.Difficulty, req.PowTimestamp, out int bytesWritten))
        {
            return false;
        }

        Span<byte> computedHash = stackalloc byte[32];
        HMACSHA256.HashData(_cachedPowKey, buffer[..bytesWritten], computedHash);

        // 核心修复 (2026-02-22)：消除异常控制流，防范畸形 Base64 引发的 DoS 攻击
        Span<byte> clientSignature = stackalloc byte[32];
        if (!Convert.TryFromBase64Chars(req.PowSignature.AsSpan(), clientSignature, out int sigBytesWritten) || sigBytesWritten != 32)
        {
            return false;
        }

        // 安全性保障：恒定时间比较，防止时序攻击
        return CryptographicOperations.FixedTimeEquals(computedHash, clientSignature);
    }

    private static bool TryFormatSignatureData(Span<byte> destination, string ip, string salt, int diff, long ts, out int bytesWritten)
    {
        int offset = 0;

        if (!TryWriteUtf8(ip, destination, ref offset) || !TryWriteByte((byte)':', destination, ref offset))
        {
            bytesWritten = 0;
            return false;
        }

        if (!TryWriteUtf8(salt, destination, ref offset) || !TryWriteByte((byte)':', destination, ref offset))
        {
            bytesWritten = 0;
            return false;
        }

        if (!Utf8Formatter.TryFormat(diff, destination[offset..], out int diffBytes))
        {
            bytesWritten = 0;
            return false;
        }
        offset += diffBytes;
        if (!TryWriteByte((byte)':', destination, ref offset))
        {
            bytesWritten = 0;
            return false;
        }

        if (!Utf8Formatter.TryFormat(ts, destination[offset..], out int tsBytes))
        {
            bytesWritten = 0;
            return false;
        }
        offset += tsBytes;

        bytesWritten = offset;
        return true;
    }

    // 核心重构：纯 C# 零分配 SHA-NI 硬件加速校验
    private static bool CheckWorkloadWithSpan(IPowRequest req)
    {
        // 分配 1024 字节防越界，完全在线程栈上执行，零 GC
        Span<byte> dataBuffer = stackalloc byte[1024];
        int offset = 0;

        if (!TryWriteUtf8(req.PowSalt, dataBuffer, ref offset)) return false;
        if (!TryWriteByte((byte)':', dataBuffer, ref offset)) return false;
        if (!TryWriteUtf8(req.PowNonce, dataBuffer, ref offset)) return false;
        if (!TryWriteByte((byte)':', dataBuffer, ref offset)) return false;
        if (!TryWriteUtf8(req.BrowserFp, dataBuffer, ref offset)) return false;

        Span<byte> hashResult = stackalloc byte[32];

        // RyuJIT 编译器会在 AMD EPYC 7K62 上将此行直接替换为 SHA 硬件加速指令
        SHA256.HashData(dataBuffer[..offset], hashResult);

        return (uint)req.Difficulty <= 256u
            && CountLeadingZeroBits(hashResult) >= req.Difficulty;
    }

    private static int CountLeadingZeroBits(ReadOnlySpan<byte> hash)
    {
        int count = 0;
        ref byte hashRef = ref MemoryMarshal.GetReference(hash);
        for (int i = 0; i < hash.Length; i++)
        {
            byte value = Unsafe.Add(ref hashRef, i);
            if (value == 0)
            {
                count += 8;
                continue;
            }

            return count + BitOperations.LeadingZeroCount((uint)value) - 24;
        }

        return count;
    }

    private static bool TryWriteUtf8(string value, Span<byte> destination, ref int offset)
    {
        if (string.IsNullOrEmpty(value)) return true;
        int byteCount = Encoding.UTF8.GetByteCount(value);
        if (byteCount > destination.Length - offset)
        {
            return false;
        }

        offset += Encoding.UTF8.GetBytes(value.AsSpan(), destination[offset..]);
        return true;
    }

    private static bool TryWriteByte(byte value, Span<byte> destination, ref int offset)
    {
        if ((uint)offset >= (uint)destination.Length)
        {
            return false;
        }

        destination[offset++] = value;
        return true;
    }

    private async Task<bool> TryConsumeProofOnceAsync(IPowRequest req, string clientIp)
    {
        string identity = BuildProofIdentity(req, NormalizeIp(clientIp));
        TimeSpan ttl = ResolveReplayTtl(req.PowTimestamp);
        bool acquired = await _cache.TryAcquireLeaseAsync(CachePolicyId.SecurityPowProof, identity, "1", ttl).ConfigureAwait(false);
        if (!acquired)
        {
            _logger.LogWarning("PoW 重放被拒绝 | Salt: {Salt}", req.PowSalt);
        }

        return acquired;
    }

    private static string BuildProofIdentity(IPowRequest req, string normalizedIp)
    {
        int capacity = GetProofIdentityCapacity(normalizedIp, req);
        byte[]? rented = null;
        Span<byte> material = capacity <= 1024
            ? stackalloc byte[capacity]
            : rented = System.Buffers.ArrayPool<byte>.Shared.Rent(capacity);

        try
        {
            if (!TryFormatProofIdentity(material, normalizedIp, req, out int bytesWritten))
            {
                return string.Empty;
            }

            Span<byte> hash = stackalloc byte[32];
            SHA256.HashData(material[..bytesWritten], hash);
            return Convert.ToHexString(hash);
        }
        finally
        {
            if (rented is not null)
            {
                System.Buffers.ArrayPool<byte>.Shared.Return(rented);
            }
        }
    }

    private static int GetProofIdentityCapacity(string normalizedIp, IPowRequest req)
    {
        const int separators = 5;
        const int maxInt64Digits = 20;
        const int maxInt32Digits = 11;
        return Encoding.UTF8.GetByteCount(normalizedIp)
            + Encoding.UTF8.GetByteCount(req.PowSalt)
            + Encoding.UTF8.GetByteCount(req.PowNonce)
            + Encoding.UTF8.GetByteCount(req.BrowserFp)
            + separators
            + maxInt64Digits
            + maxInt32Digits;
    }

    private static bool TryFormatProofIdentity(Span<byte> destination, string normalizedIp, IPowRequest req, out int bytesWritten)
    {
        int offset = 0;
        if (!TryWriteUtf8(normalizedIp, destination, ref offset) || !TryWriteUnitSeparator(destination, ref offset))
        {
            bytesWritten = 0;
            return false;
        }

        if (!TryWriteUtf8(req.PowSalt, destination, ref offset) || !TryWriteUnitSeparator(destination, ref offset))
        {
            bytesWritten = 0;
            return false;
        }

        if (!TryWriteUtf8(req.PowNonce, destination, ref offset) || !TryWriteUnitSeparator(destination, ref offset))
        {
            bytesWritten = 0;
            return false;
        }

        if (!Utf8Formatter.TryFormat(req.PowTimestamp, destination[offset..], out int timestampBytes))
        {
            bytesWritten = 0;
            return false;
        }
        offset += timestampBytes;
        if (!TryWriteUnitSeparator(destination, ref offset))
        {
            bytesWritten = 0;
            return false;
        }

        if (!Utf8Formatter.TryFormat(req.Difficulty, destination[offset..], out int difficultyBytes))
        {
            bytesWritten = 0;
            return false;
        }
        offset += difficultyBytes;
        if (!TryWriteUnitSeparator(destination, ref offset))
        {
            bytesWritten = 0;
            return false;
        }

        if (!TryWriteUtf8(req.BrowserFp, destination, ref offset))
        {
            bytesWritten = 0;
            return false;
        }

        bytesWritten = offset;
        return true;
    }

    private static bool TryWriteUnitSeparator(Span<byte> destination, ref int offset)
        => TryWriteByte(0x1F, destination, ref offset);

    private static TimeSpan ResolveReplayTtl(long timestamp)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (!IsTimestampWithinWindow(timestamp, now))
        {
            return TimeSpan.FromSeconds(1);
        }

        long elapsed = timestamp <= now ? now - timestamp : timestamp - now;
        long remainingSeconds = Math.Max(1, 300 - elapsed);
        return TimeSpan.FromSeconds(Math.Min(remainingSeconds, (long)ProofReplayTtl.TotalSeconds));
    }

    private static bool IsTimestampWithinWindow(long timestamp, long now)
        => timestamp >= now - 300 && timestamp <= now + 300;

    private static bool HasValidFieldLengths(IPowRequest req)
        => IsUtf8LengthInRange(req.PowSalt, MaxSaltUtf8Bytes)
            && IsUtf8LengthInRange(req.PowNonce, MaxNonceUtf8Bytes)
            && IsUtf8LengthInRange(req.PowSignature, MaxSignatureUtf8Bytes)
            && IsUtf8LengthInRange(req.BrowserFp, MaxBrowserFingerprintUtf8Bytes);

    private static bool IsUtf8LengthInRange(string value, int maxBytes)
        => Encoding.UTF8.GetByteCount(value) <= maxBytes;

    private static string NormalizeIp(string ip) => System.Net.IPAddress.TryParse(ip, out var parsed) ? parsed.ToString() : ip;

    private static string GenerateRandomSalt()
    {
        Span<byte> saltBytes = stackalloc byte[16];
        RandomNumberGenerator.Fill(saltBytes);
        return Convert.ToHexString(saltBytes);
    }
}
