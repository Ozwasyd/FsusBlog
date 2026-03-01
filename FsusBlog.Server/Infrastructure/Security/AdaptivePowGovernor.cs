using StackExchange.Redis;
using System.Runtime.CompilerServices;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// 全局自适应 PoW 治理器 (The Governor) - High Performance Edition
/// 修复日期: 2026-02-23 (废弃 ConcurrentDictionary 引入无锁环形缓存彻底解决 Count 性能瓶颈与缓存雪崩问题)
/// </summary>
public sealed class AdaptivePowGovernor
{
    private readonly IDatabase _redis;

    // ==========================================
    // 难度配置 (适配前端 SIMD 加速后的新基准)
    // ==========================================
    private const int BASE_DIFFICULTY = 4;        // 静默期
    private const int ELEVATED_DIFFICULTY = 5;    // 活跃期
    private const int HIGH_LOAD_DIFFICULTY = 6;   // 拥堵期
    private const int WAR_MODE_DIFFICULTY = 7;    // 激战期

    // ==========================================
    // 性能计数器 (实例级原子操作)
    // ==========================================
    private int _currentRps;
    private long _lastTick = Environment.TickCount64;

    // ==========================================
    // 极限 L1 本地缓存 (无锁 Direct Mapped Cache)
    // ==========================================
    // 容量必须是 2 的整数次幂，以便使用极速的位与(&)操作代替取模(%)运算
    private const int CACHE_SIZE = 8192;
    private const int CACHE_MASK = CACHE_SIZE - 1;
    private readonly RiskCacheEntry?[] _localRiskCache = new RiskCacheEntry?[CACHE_SIZE];
    private const int CACHE_DURATION_MS = 10000; // 本地缓存 10 秒

    // 采用引用类型包装缓存节点，确保引用的原子级更新，防止多线程结构体撕裂 (Struct Tearing)
    private sealed class RiskCacheEntry
    {
        public required string Ip { get; init; }
        public required int Score { get; init; }
        public required long ExpireAt { get; init; }
    }

    public AdaptivePowGovernor(IConnectionMultiplexer redis)
    {
        _redis = redis.GetDatabase();
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

        // 核心物理级优化：无锁环形缓存定位
        // 彻底消灭 ConcurrentDictionary 的高昂开销与并发争用
        int idx = ip.GetHashCode() & CACHE_MASK;
        var cached = Volatile.Read(ref _localRiskCache[idx]);

        int riskScore = 0;

        if (cached != null && cached.Ip == ip && now < cached.ExpireAt)
        {
            // 极速命中本地 L1 缓存
            riskScore = cached.Score;
        }
        else
        {
            // 缓存未命中或哈希冲突被覆盖，查询 Redis
            // 零分配优化：使用 string.Create 替代 $"..."
            const string KeyPrefix = "security:risk_score:";
            string redisKey = string.Create(KeyPrefix.Length + ip.Length, ip, (span, state) =>
            {
                KeyPrefix.AsSpan().CopyTo(span);
                state.AsSpan().CopyTo(span[KeyPrefix.Length..]);
            });

            var redisValue = await _redis.StringGetAsync(redisKey);

            // 底层 TryParse，直接拆箱
            if (redisValue.HasValue && redisValue.TryParse(out int val))
            {
                riskScore = val;
            }

            // 写入本地缓存 (原子级引用替换，自动淘汰旧数据，彻底免疫缓存雪崩)
            var newEntry = new RiskCacheEntry
            {
                Ip = ip,
                Score = riskScore,
                ExpireAt = now + CACHE_DURATION_MS
            };
            Volatile.Write(ref _localRiskCache[idx], newEntry);
        }

        // 动态加权：风险分每增加 10 分，难度 +1
        if (riskScore > 0)
        {
            int penalty = riskScore / 10;
            return Math.Min(globalDiff + penalty, WAR_MODE_DIFFICULTY);
        }

        return globalDiff;
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
                Interlocked.Exchange(ref _currentRps, 0);
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
        int rps = Volatile.Read(ref _currentRps);

        if (rps > 1000) return WAR_MODE_DIFFICULTY;
        if (rps > 300) return HIGH_LOAD_DIFFICULTY;
        if (rps > 100) return ELEVATED_DIFFICULTY;

        return BASE_DIFFICULTY;
    }
}