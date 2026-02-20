namespace FsusBlog.Server.Infrastructure.Security;

using StackExchange.Redis;
using System.Collections.Concurrent;
using System.Runtime.CompilerServices;

/// <summary>
/// 全局自适应 PoW 治理器 (The Governor) - High Performance Edition
/// 核心职责：根据当前系统负载（CPU + RPS + Redis 压力）动态裁决 PoW 难度
/// </summary>
public class AdaptivePowGovernor(IConnectionMultiplexer redis)
{
    private readonly IDatabase _redis = redis.GetDatabase();

    // ==========================================
    // 难度配置 (适配前端 SIMD 加速后的新基准)
    // ==========================================
    // 前端优化后，Diff 4 耗时约 50ms，Diff 5 耗时约 200ms
    // 因此我们需要拉高基准线，迫使攻击者消耗更多算力
    private const int BASE_DIFFICULTY = 4;        // 静默期 (原3 -> 4)
    private const int ELEVATED_DIFFICULTY = 5;    // 活跃期 (原4 -> 5)
    private const int HIGH_LOAD_DIFFICULTY = 6;   // 拥堵期 (原5 -> 6, 此时前端耗时约 3s-5s，阻断效果极佳)
    private const int WAR_MODE_DIFFICULTY = 7;    // 激战期 (原6 -> 7, 几乎不可解，作为熔断保护)

    // ==========================================
    // 性能计数器 (原子操作)
    // ==========================================
    private static int _currentRps; // 当前每秒请求数
    private static long _lastTick = Environment.TickCount64;

    // ==========================================
    // L1 本地缓存 (减少 Redis IO)
    // ==========================================
    // Key: IP, Value: (RiskScore, ExpireTime)
    private readonly ConcurrentDictionary<string, (int Score, long ExpireAt)> _localRiskCache = new();
    private const int CACHE_DURATION_MS = 10000; // 本地缓存 10 秒

    /// <summary>
    /// 获取当前全局建议难度
    /// </summary>
    public int CurrentGlobalDifficulty
    {
        get
        {
            // 逻辑自洽：在获取难度时，顺便检查是否需要重置 RPS 窗口
            // 防止因外部 Tick 调用失败导致 RPS 累积不归零
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

        // 性能最大化：先查本地 L1 缓存
        // 避免高频请求下 Redis 成为瓶颈
        int riskScore = 0;
        long now = Environment.TickCount64;

        if (_localRiskCache.TryGetValue(ip, out var cached) && now < cached.ExpireAt)
        {
            riskScore = cached.Score;
        }
        else
        {
            // 缓存未命中或已过期，查询 Redis (异步)
            // 键名规则：security:risk_score:{ip}
            var redisValue = await _redis.StringGetAsync($"security:risk_score:{ip}");

            if (redisValue.HasValue && redisValue.TryParse(out int val))
            {
                riskScore = val;
            }

            // 写入本地缓存 (即使是 0 分也缓存，防止缓存穿透)
            _localRiskCache[ip] = (riskScore, now + CACHE_DURATION_MS);

            // 简单的缓存清理策略：如果缓存太大，清空一次 (防止内存泄漏)
            if (_localRiskCache.Count > 10000) _localRiskCache.Clear();
        }

        // 动态加权：风险分每增加 10 分，难度 +1
        if (riskScore > 0)
        {
            int penalty = riskScore / 10;
            // 安全性保障：确保难度不超过 WAR_MODE
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
            // 逻辑自洽：使用 CAS (Compare And Swap) 确保只有一个线程能重置计数器
            // 避免多线程同时重置导致数据丢失
            if (Interlocked.CompareExchange(ref _lastTick, now, last) == last)
            {
                Interlocked.Exchange(ref _currentRps, 0);
            }
        }
    }

    /// <summary>
    /// 后台重置任务 (保留作为 Backup)
    /// </summary>
    public void Tick()
    {
        TryResetWindow();
    }

    /// <summary>
    /// 计算全局难度 (CPU + RPS 混合判定)
    /// </summary>
    private static int CalculateGlobalDifficulty()
    {
        // 1. RPS 判定 (阈值根据前端优化后的吞吐量调整)
        int rps = _currentRps;

        // 激战模式：RPS > 1000 (通常是 DDoS 级别)
        // 此时下发难度 7，前端哪怕用 SIMD 也需要跑很久，有效掐断连接
        if (rps > 1000) return WAR_MODE_DIFFICULTY;

        // 拥堵模式：RPS > 300
        // 下发难度 6 (前端 SIMD 耗时约 800ms-1.2s)，用户稍微转圈，攻击者成本剧增
        if (rps > 300) return HIGH_LOAD_DIFFICULTY;

        // 活跃模式：RPS > 100
        // 下发难度 5 (前端 SIMD 耗时约 200ms)，用户无感
        if (rps > 100) return ELEVATED_DIFFICULTY;

        // 2. 简易 CPU 负载感知 (可选)
        // 这里的逻辑保持现状，主要依赖 RPS

        return BASE_DIFFICULTY; // 默认为 4
    }
}