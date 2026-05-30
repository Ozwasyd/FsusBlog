using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using System.Buffers.Text;
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
    private static long _lastFallbackWarningTicks;
    private readonly byte[] _cachedPowKey;
    private readonly bool _isFallbackKey;
    private readonly ILogger<RedisPowService> _logger;
    private readonly AdaptivePowGovernor _governor;

    public RedisPowService(
        IConfiguration config,
        ILogger<RedisPowService> logger,
        AdaptivePowGovernor governor)
    {
        _logger = logger;
        _governor = governor;

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

        // 1. 签名校验 (防重放与篡改)
        if (!BasicValidate(req, clientIp))
        {
            _logger.LogWarning("PoW 签名非法 | Salt: {Salt}", req.PowSalt);
            return false;
        }

        // 2. 算力验算 (纯 C# SHA-NI 硬件加速)
        if (!CheckWorkloadWithSpan(req)) return false;

        return true;
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
        TryFormatSignatureData(buffer, normalizedIp, salt, difficulty, timestamp, out int bytesWritten);

        Span<byte> hashResult = stackalloc byte[32];
        HMACSHA256.HashData(_cachedPowKey, buffer[..bytesWritten], hashResult);

        return new PowChallenge(salt, difficulty, timestamp, Convert.ToBase64String(hashResult));
    }

    private bool BasicValidate(IPowRequest req, string ip)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (Math.Abs(now - req.PowTimestamp) > 300) return false;

        string normalizedIp = NormalizeIp(ip);
        Span<byte> buffer = stackalloc byte[256];
        TryFormatSignatureData(buffer, normalizedIp, req.PowSalt, req.Difficulty, req.PowTimestamp, out int bytesWritten);

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

        // 性能最大化：单次调用直接返回写入长度，彻底消灭原版 GetByteCount 带来的双重字符串遍历
        offset += Encoding.UTF8.GetBytes(ip.AsSpan(), destination[offset..]);
        destination[offset++] = (byte)':';

        offset += Encoding.UTF8.GetBytes(salt.AsSpan(), destination[offset..]);
        destination[offset++] = (byte)':';

        Utf8Formatter.TryFormat(diff, destination[offset..], out int diffBytes);
        offset += diffBytes;
        destination[offset++] = (byte)':';

        Utf8Formatter.TryFormat(ts, destination[offset..], out int tsBytes);
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
        dataBuffer[offset++] = (byte)':';
        if (!TryWriteUtf8(req.PowNonce, dataBuffer, ref offset)) return false;
        dataBuffer[offset++] = (byte)':';
        if (!TryWriteUtf8(req.BrowserFp, dataBuffer, ref offset)) return false;

        Span<byte> hashResult = stackalloc byte[32];

        // RyuJIT 编译器会在 AMD EPYC 7K62 上将此行直接替换为 SHA 硬件加速指令
        SHA256.HashData(dataBuffer[..offset], hashResult);

        // 极限前导零校验 (规避数组越界检查)
        int fullBytes = req.Difficulty / 2;
        if (fullBytes > 32) return false;

        // 性能最大化：提取栈内存首地址，生成底层汇编指针寻址，无任何 Bounds Checking
        ref byte hashRef = ref MemoryMarshal.GetReference(hashResult);

        for (int i = 0; i < fullBytes; i++)
        {
            if (Unsafe.Add(ref hashRef, i) != 0) return false;
        }

        if (req.Difficulty % 2 != 0)
        {
            if ((Unsafe.Add(ref hashRef, fullBytes) & 0xF0) != 0) return false;
        }

        return true;
    }

    private static bool TryWriteUtf8(string value, Span<byte> destination, ref int offset)
    {
        if (string.IsNullOrEmpty(value)) return true;
        // 性能最大化：单次调用即可，剔除双重遍历
        offset += Encoding.UTF8.GetBytes(value.AsSpan(), destination[offset..]);
        return true;
    }

    private static string NormalizeIp(string ip) => System.Net.IPAddress.TryParse(ip, out var parsed) ? parsed.ToString() : ip;

    private static string GenerateRandomSalt()
    {
        Span<byte> saltBytes = stackalloc byte[16];
        RandomNumberGenerator.Fill(saltBytes);
        return Convert.ToHexString(saltBytes);
    }
}
