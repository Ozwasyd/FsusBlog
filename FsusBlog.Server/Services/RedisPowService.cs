using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using StackExchange.Redis;
using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Services;
/// <summary>
/// 基于 Redis 的工作量证明 (PoW) 校验服务 
/// </summary>
public class RedisPowService : IPowService
{
    private readonly IDatabase _redis;
    private readonly byte[] _cachedPowKey; // HMAC Key (Pre-computed)
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

    /// <summary>
    /// 通用校验逻辑
    /// </summary>
    public async Task<bool> VerifyAsync(IPowRequest req, string clientIp)
    {
        // 1. 基础签名校验 (CPU 密集型，极快)
        // 验证 Salt, Difficulty, Timestamp 是否被篡改
        if (!BasicValidate(req, clientIp))
        {
            _logger.LogWarning("PoW 签名非法 | IP: {IP}", clientIp);
            return false;
        }

        // 2. 算力验算 (CPU 密集型)
        // 拼接格式：Salt:Nonce:BrowserFp
        // 性能优化：避免大字符串分配，使用 ArrayPool 或 stackalloc (视长度而定)
        // BrowserFp 可能较长 (32-64 chars)，Salt (32 chars)，Nonce (10-20 chars)
        // 总长度约 100-150 chars，stackalloc char[256] 是安全的
        if (!CheckWorkloadWithSpan(req))
        {
            _logger.LogWarning("PoW 算力不足 | Nonce: {Nonce}, Diff: {Diff}", req.PowNonce, req.Difficulty);
            return false;
        }

        // 3. 防重放校验 (IO 密集型)
        // 只有通过了 CPU 校验的请求才有资格访问 Redis
        // Key 格式: pow:nonce:{Salt}:{Nonce}
        string nonceKey = $"pow:nonce:{req.PowSalt}:{req.PowNonce}";

        bool isFirstUse = await _redis.StringSetAsync(
            nonceKey, "1",
            expiry: TimeSpan.FromMinutes(5), // 必须 > Timestamp 有效期
            when: When.NotExists
        );

        if (!isFirstUse)
        {
            _logger.LogWarning("检测到 Nonce 重放攻击 | Nonce: {Nonce}", req.PowNonce);
            return false;
        }

        return true;
    }

    /// <summary>
    /// 生成挑战 (异步)
    /// </summary>
    public async Task<PowChallenge> GenerateChallengeAsync(string clientIp)
    {
        string normalizedIp = NormalizeIp(clientIp);

        // 生成随机盐 (16 bytes -> 32 hex chars)
        string salt = GenerateRandomSalt();
        long timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        // 获取动态难度
        int difficulty = await _governor.GetDifficultyForIpAsync(normalizedIp);

        // 计算签名 (Zero-Allocation 模式)
        // 签名内容：IP:Salt:Difficulty:Timestamp
        // 预估最大长度: 45(IPv6) + 32(Salt) + 2(Diff) + 10(Time) + 3(Separators) ≈ 92 chars
        Span<byte> buffer = stackalloc byte[128];

        // 格式化字符串到 Buffer
        if (!TryFormatSignatureData(buffer, normalizedIp, salt, difficulty, timestamp, out int bytesWritten))
        {
            // Fallback: 缓冲区不足时 (极罕见)
            return await GenerateChallengeFallbackAsync(normalizedIp, salt, difficulty, timestamp);
        }

        // 计算 HMAC
        Span<byte> hashResult = stackalloc byte[32];
        HMACSHA256.HashData(_cachedPowKey, buffer[..bytesWritten], hashResult);

        string signature = Convert.ToBase64String(hashResult);
        return new PowChallenge(salt, difficulty, timestamp, signature);
    }

    // ==========================================
    // 内部核心逻辑 (Private Core)
    // ==========================================

    /// <summary>
    /// 验算哈希前导零 (使用 Span 优化)
    /// </summary>
    private static bool CheckWorkloadWithSpan(IPowRequest req)
    {
        // 预估长度: Salt(32) + 1 + Nonce(20) + 1 + Fp(64) ≈ 118
        Span<byte> dataBuffer = stackalloc byte[256];
        int offset = 0;

        // 手动拼接 UTF8 Bytes: $"{req.PowSalt}:{req.PowNonce}:{req.BrowserFp}"
        // 1. Salt
        if (!TryWriteUtf8(req.PowSalt, dataBuffer, ref offset)) return false;
        dataBuffer[offset++] = (byte)':';

        // 2. Nonce
        if (!TryWriteUtf8(req.PowNonce, dataBuffer, ref offset)) return false;
        dataBuffer[offset++] = (byte)':';

        // 3. BrowserFp
        if (!TryWriteUtf8(req.BrowserFp, dataBuffer, ref offset)) return false;

        // 计算 SHA256
        Span<byte> hashBytes = stackalloc byte[32];
        SHA256.HashData(dataBuffer[..offset], hashBytes);

        // 检查难度 (Nibble Check)
        // Difficulty = N，代表前 N 个 Hex 字符为 '0'
        int fullBytesZero = req.Difficulty / 2;
        bool halfByteZero = (req.Difficulty % 2) != 0;

        // 1. 检查完整字节
        for (int i = 0; i < fullBytesZero; i++)
        {
            if (hashBytes[i] != 0) return false;
        }

        // 2. 检查半字节 (高4位)
        if (halfByteZero)
        {
            // 安全检查：防止数组越界 (虽然 Difficulty 通常 < 64)
            if (fullBytesZero >= 32) return false;
            if ((hashBytes[fullBytesZero] & 0xF0) != 0) return false;
        }

        return true;
    }

    /// <summary>
    /// 基础合法性检查 (无状态)
    /// </summary>
    private bool BasicValidate(IPowRequest req, string ip)
    {
        // 1. 时间戳检查 (5分钟窗口)
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (Math.Abs(now - req.PowTimestamp) > 300) return false;

        string normalizedIp = NormalizeIp(ip);

        // 2. 重建签名原串 (Zero-Allocation)
        Span<byte> buffer = stackalloc byte[128];
        if (!TryFormatSignatureData(buffer, normalizedIp, req.PowSalt, req.Difficulty, req.PowTimestamp, out int bytesWritten))
        {
            return false;
        }

        // 3. 计算 HMAC
        Span<byte> computedHash = stackalloc byte[32];
        HMACSHA256.HashData(_cachedPowKey, buffer[..bytesWritten], computedHash);

        // 4. 对比签名
        try
        {
            // 客户端传来的 Base64 签名解码
            byte[] clientSignature = Convert.FromBase64String(req.PowSignature);
            return CryptographicOperations.FixedTimeEquals(computedHash, clientSignature);
        }
        catch
        {
            return false;
        }
    }

    // ==========================================
    // 辅助方法 (Helpers)
    // ==========================================

    private static bool TryFormatSignatureData(Span<byte> destination, string ip, string salt, int diff, long ts, out int bytesWritten)
    {
        // 格式: IP:Salt:Difficulty:Timestamp
        int offset = 0;
        bytesWritten = 0;

        if (!TryWriteUtf8(ip, destination, ref offset)) return false;
        destination[offset++] = (byte)':';

        if (!TryWriteUtf8(salt, destination, ref offset)) return false;
        destination[offset++] = (byte)':';

        if (!Utf8Formatter.TryFormat(diff, destination[offset..], out int diffBytes)) return false;
        offset += diffBytes;
        destination[offset++] = (byte)':';

        if (!Utf8Formatter.TryFormat(ts, destination[offset..], out int tsBytes)) return false;
        offset += tsBytes;

        bytesWritten = offset;
        return true;
    }

    private static bool TryWriteUtf8(string value, Span<byte> destination, ref int offset)
    {
        if (value == null) return true; // Treat null as empty
        int written = Encoding.UTF8.GetBytes(value, destination[offset..]);
        offset += written;
        return true;
    }

    private static string NormalizeIp(string ip)
    {
        return System.Net.IPAddress.TryParse(ip, out var parsed) ? parsed.ToString() : ip;
    }

    private static string GenerateRandomSalt()
    {
        Span<byte> saltBytes = stackalloc byte[16];
        RandomNumberGenerator.Fill(saltBytes);
        return Convert.ToHexString(saltBytes);
    }

    // 用于极罕见缓冲区溢出情况的备用处理逻辑
    private async Task<PowChallenge> GenerateChallengeFallbackAsync(string ip, string salt, int diff, long ts)
    {
        byte[] data = Encoding.UTF8.GetBytes($"{ip}:{salt}:{diff}:{ts}");
        byte[] hash = HMACSHA256.HashData(_cachedPowKey, data);
        return new PowChallenge(salt, diff, ts, Convert.ToBase64String(hash));
    }
}