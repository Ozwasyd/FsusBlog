using FsusBlog.Server.Infrastructure.Cache;
using System.Runtime.CompilerServices;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// 全局自适应 PoW 治理器 (The Governor) - High Performance Edition
/// 修复日期: 2026-02-23 (废弃 ConcurrentDictionary 引入无锁环形缓存彻底解决 Count 性能瓶颈与缓存雪崩问题)
/// </summary>
public sealed class AdaptivePowGovernor
{
    private readonly IUnifiedCache _cache;

    // ==========================================
    // 难度配置 (适配前端 SIMD 加速后的新基准)
    // ==========================================
    private const int BASE_DIFFICULTY = 16;       // 静默期
    private const int ELEVATED_DIFFICULTY = 20;   // 活跃期
    private const int HIGH_LOAD_DIFFICULTY = 24;  // 拥堵期
    private const int WAR_MODE_DIFFICULTY = 28;   // 激战期
    private const int RISK_PENALTY_BITS = 4;

    // ==========================================
    // 性能计数器 (实例级原子操作)
    // ==========================================
    private int _currentRps;
    private long _lastTick = Environment.TickCount64;
    private int _rpsEwmaScaled;
    private const int EWMA_SCALE = 1000;
    private const int EWMA_ALPHA_NUMERATOR = 35;
    private const int EWMA_ALPHA_DENOMINATOR = 100;

    // ==========================================
    // 极限 L1 本地缓存 (无锁 Set-Associative Cache)
    // ==========================================
    private const int CACHE_SET_COUNT = 2048;
    private const int CACHE_SET_MASK = CACHE_SET_COUNT - 1;
    private const int CACHE_WAYS = 4;
    private readonly RiskCacheEntry?[] _localRiskCache = new RiskCacheEntry?[CACHE_SET_COUNT * CACHE_WAYS];
    private const int CACHE_DURATION_MS = 10000; // 本地缓存 10 秒

    // 采用引用类型包装缓存节点，确保引用的原子级更新，防止多线程结构体撕裂 (Struct Tearing)
    private sealed class RiskCacheEntry
    {
        public required string Ip { get; init; }
        public required uint Hash { get; init; }
        public required int Score { get; init; }
        public required long ExpireAt { get; init; }
    }

    public AdaptivePowGovernor(IUnifiedCache cache)
    {
        _cache = cache;
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
        int setStart = (int)(hash & CACHE_SET_MASK) * CACHE_WAYS;
        int replacementIndex = setStart + (int)((hash >> 16) & (CACHE_WAYS - 1));
        int riskScore = 0;

        for (int way = 0; way < CACHE_WAYS; way++)
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
            ExpireAt = now + CACHE_DURATION_MS
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
        int ewmaRps = Volatile.Read(ref _rpsEwmaScaled) / EWMA_SCALE;
        int rps = Math.Max(currentRps, ewmaRps);

        if (rps > 1000) return WAR_MODE_DIFFICULTY;
        if (rps > 300) return HIGH_LOAD_DIFFICULTY;
        if (rps > 100) return ELEVATED_DIFFICULTY;

        return BASE_DIFFICULTY;
    }

    private void UpdateRpsEwma(int observedRps)
    {
        int observedScaled = Math.Max(0, observedRps) * EWMA_SCALE;
        int previous = Volatile.Read(ref _rpsEwmaScaled);
        int next = previous == 0
            ? observedScaled
            : ((previous * (EWMA_ALPHA_DENOMINATOR - EWMA_ALPHA_NUMERATOR)) + (observedScaled * EWMA_ALPHA_NUMERATOR)) / EWMA_ALPHA_DENOMINATOR;
        Volatile.Write(ref _rpsEwmaScaled, next);
    }

    private static int ApplyRiskPenalty(int globalDiff, int riskScore)
    {
        if (riskScore <= 0)
        {
            return globalDiff;
        }

        int penalty = (riskScore / 10) * RISK_PENALTY_BITS;
        return Math.Min(globalDiff + penalty, WAR_MODE_DIFFICULTY);
    }

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
