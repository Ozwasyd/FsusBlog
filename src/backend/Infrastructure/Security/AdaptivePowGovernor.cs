using System.Runtime.CompilerServices;

using FsusBlog.Server.Infrastructure.Cache;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// Adjusts global PoW difficulty from recent request pressure and bounded local risk state.
/// </summary>
public sealed class AdaptivePowGovernor
{
    private readonly IUnifiedCache _cache;

    // ==========================================
    // 难度配置 (适配前端 SIMD 加速后的新基准)
    // ==========================================
    private const int BaseDifficulty = 16;       // 静默期
    private const int ElevatedDifficulty = 20;   // 活跃期
    private const int HighLoadDifficulty = 24;  // 拥堵期
    private const int WarModeDifficulty = 28;   // 激战期
    private const int RiskPenaltyBits = 4;
    private readonly int _baseDifficulty;
    private readonly int _maxDifficulty;

    // ==========================================
    // 性能计数器 (实例级原子操作)
    // ==========================================
    private int _currentRps;
    private long _lastTick = Environment.TickCount64;
    private int _rpsEwmaScaled;
    private const int EwmaScale = 1000;
    private const int EwmaAlphaNumerator = 35;
    private const int EwmaAlphaDenominator = 100;

    // The fixed set-associative cache bounds local risk-state residency.
    private const int CacheSetCount = 2048;
    private const int CacheSetMask = CacheSetCount - 1;
    private const int CacheWays = 4;
    private readonly RiskCacheEntry?[] _localRiskCache = new RiskCacheEntry?[CacheSetCount * CacheWays];
    private const int CacheDurationMs = 10000; // 本地缓存 10 秒

    // 采用引用类型包装缓存节点，确保引用的原子级更新，防止多线程结构体撕裂 (Struct Tearing)
    private sealed class RiskCacheEntry
    {
        public required string Ip
        {
            get; init;
        }
        public required uint Hash
        {
            get; init;
        }
        public required int Score
        {
            get; init;
        }
        public required long ExpireAt
        {
            get; init;
        }
    }

    /// <summary>Loads bounded PoW difficulty thresholds while retaining the shared risk cache as the scoring source.</summary>
    public AdaptivePowGovernor(IUnifiedCache cache, IConfiguration? configuration = null)
    {
        _cache = cache;
        _baseDifficulty = Math.Clamp(ReadInt(configuration, "Security:Pow:BaseDifficulty", BaseDifficulty), 1, WarModeDifficulty);
        _maxDifficulty = Math.Clamp(ReadInt(configuration, "Security:Pow:MaxDifficulty", WarModeDifficulty), _baseDifficulty, WarModeDifficulty);
    }

    /// <summary>
    /// 获取当前全局建议难度
    /// </summary>
    public int CurrentGlobalDifficulty
    {
        get
        {
            TryResetWindow();
            return CalculateGlobalDifficulty();
        }
    }

    /// <summary>
    /// 针对特定 IP 的难度裁决
    /// </summary>
    public async Task<int> GetDifficultyForIpAsync(string ip)
    {
        int globalDiff = CurrentGlobalDifficulty;
        long now = Environment.TickCount64;

        uint hash = StableIpHash(ip);
        int setStart = (int)(hash & CacheSetMask) * CacheWays;
        int replacementIndex = setStart + (int)((hash >> 16) & (CacheWays - 1));
        int riskScore = 0;

        for (int way = 0; way < CacheWays; way++)
        {
            int index = setStart + way;
            RiskCacheEntry? cached = Volatile.Read(ref _localRiskCache[index]);
            if (cached is null || now >= cached.ExpireAt)
            {
                replacementIndex = index;
                continue;
            }

            if (cached.Hash == hash && cached.Ip == ip)
            {
                riskScore = cached.Score;
                return ApplyRiskPenalty(globalDiff, riskScore);
            }
        }

        string? redisValue = await _cache.GetStringAsync(CachePolicyId.SecurityPowRisk, ip);
        if (!string.IsNullOrWhiteSpace(redisValue) && int.TryParse(redisValue, out int val))
        {
            riskScore = val;
        }

        var newEntry = new RiskCacheEntry
        {
            Ip = ip,
            Hash = hash,
            Score = riskScore,
            ExpireAt = now + CacheDurationMs
        };
        Volatile.Write(ref _localRiskCache[replacementIndex], newEntry);

        return ApplyRiskPenalty(globalDiff, riskScore);
    }

    /// <summary>
    /// 记录一次入站请求 (用于 RPS 统计)
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public void RecordInboundRequest()
    {
        TryResetWindow();
        Interlocked.Increment(ref _currentRps);
    }

    /// <summary>
    /// 尝试重置时间窗口 (原子级安全)
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private void TryResetWindow()
    {
        long now = Environment.TickCount64;
        long last = Interlocked.Read(ref _lastTick);

        if (now - last >= 1000)
        {
            if (Interlocked.CompareExchange(ref _lastTick, now, last) == last)
            {
                int observedRps = Interlocked.Exchange(ref _currentRps, 0);
                UpdateRpsEwma(observedRps);
            }
        }
    }

    /// <summary>
    /// 后台重置任务 (配合 PowLoadResetWorker)
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public void Tick()
    {
        TryResetWindow();
    }

    /// <summary>
    /// 计算全局难度 (基于 RPS 判定)
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private int CalculateGlobalDifficulty()
    {
        // 性能微调：使用 Volatile 读取确保最新值，省去不必要的 Interlocked 锁开销
        int currentRps = Volatile.Read(ref _currentRps);
        int ewmaRps = Volatile.Read(ref _rpsEwmaScaled) / EwmaScale;
        int rps = Math.Max(currentRps, ewmaRps);

        if (rps > 1000)
            return Math.Min(WarModeDifficulty, _maxDifficulty);
        if (rps > 300)
            return Math.Min(HighLoadDifficulty, _maxDifficulty);
        if (rps > 100)
            return Math.Min(ElevatedDifficulty, _maxDifficulty);

        return _baseDifficulty;
    }

    private void UpdateRpsEwma(int observedRps)
    {
        int observedScaled = Math.Max(0, observedRps) * EwmaScale;
        int previous = Volatile.Read(ref _rpsEwmaScaled);
        int next = previous == 0
            ? observedScaled
            : ((previous * (EwmaAlphaDenominator - EwmaAlphaNumerator)) + (observedScaled * EwmaAlphaNumerator)) / EwmaAlphaDenominator;
        Volatile.Write(ref _rpsEwmaScaled, next);
    }

    private int ApplyRiskPenalty(int globalDiff, int riskScore)
    {
        if (riskScore <= 0)
        {
            return globalDiff;
        }

        int penalty = (riskScore / 10) * RiskPenaltyBits;
        return Math.Min(globalDiff + penalty, _maxDifficulty);
    }

    private static int ReadInt(IConfiguration? configuration, string key, int fallback)
        => int.TryParse(configuration?[key], out int value) ? value : fallback;

    internal static uint StableIpHashForTests(string ip) => StableIpHash(ip);

    private static uint StableIpHash(string ip)
    {
        unchecked
        {
            uint hash = 2166136261u;
            foreach (char ch in ip)
            {
                hash ^= ch;
                hash *= 16777619u;
            }

            return hash;
        }
    }
}
