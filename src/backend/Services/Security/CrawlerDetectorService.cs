using Microsoft.Extensions.Caching.Memory;
using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace FsusBlog.Server.Services.Security;

/// <summary>
/// 爬虫验身服务 (Singleton)
/// 修复日期: 2026-02-22 (修复 GetHostEntryAsync 重载问题及可空引用警告，确保严苛编译环境下 0 错误 0 警告)
/// 职责: 维护各大搜索引擎的 IP CIDR 白名单，并提供 rDNS 动态验证能力
/// </summary>
public class CrawlerDetectorService(ILogger<CrawlerDetectorService> logger, IMemoryCache cache)
{
    private const int MaxCidrRangesPerProvider = 8192;
    private const int MaxUserAgentLength = 512;
    private const int MaxIpStringLength = 64;
    private readonly SemaphoreSlim _dnsSemaphore = new(50);

    // 核心性能优化：使用 volatile 保证后台更新时的原子性指针切换，查询侧达到绝对的“无锁零争用”
    private volatile IpRadixTree _googleTree = new();
    private volatile IpRadixTree _bingTree = new();

    /// <summary>
    /// 更新 CIDR 列表 (由后台任务调用)
    /// </summary>
    public void UpdateCidrLists(List<string> googleRanges, List<string> bingRanges)
    {
        _googleTree = BuildTree(googleRanges, MaxCidrRangesPerProvider);
        _bingTree = BuildTree(bingRanges, MaxCidrRangesPerProvider);
        logger.LogInformation("爬虫白名单前缀树构建完毕: Google {GCount} 段, Bing {BCount} 段", googleRanges.Count, bingRanges.Count);
    }

    /// <summary>
    /// 核心方法：验证 IP 是否为合法的搜索引擎爬虫
    /// </summary>
    public async Task<bool> IsVerifiedCrawlerAsync(string ipStr, string userAgent)
    {
        if (string.IsNullOrWhiteSpace(ipStr) || string.IsNullOrWhiteSpace(userAgent))
        {
            return false;
        }

        if (ipStr.Length > MaxIpStringLength)
        {
            return false;
        }

        if (userAgent.Length > MaxUserAgentLength)
        {
            userAgent = userAgent[..MaxUserAgentLength];
        }

        if (!IPAddress.TryParse(ipStr, out var ip)) return false;

        // 统一归一化：将可能被框架映射为 IPv6 的 IPv4 地址还原，防止位运算错位
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();

        // 1. 极速 CIDR 内存前缀树匹配 (O(1) 复杂度，纳秒级无 IO)
        if (userAgent.Contains("Googlebot", StringComparison.OrdinalIgnoreCase))
        {
            return _googleTree.Contains(ip);
        }
        if (userAgent.Contains("bingbot", StringComparison.OrdinalIgnoreCase))
        {
            return _bingTree.Contains(ip);
        }

        // 2. rDNS 动态验证 (针对 Baidu/Sogou 等)
        if (userAgent.Contains("Baiduspider", StringComparison.OrdinalIgnoreCase) ||
            userAgent.Contains("Sogou", StringComparison.OrdinalIgnoreCase))
        {
            return await VerifyByReverseDnsAsync(ip, ipStr);
        }

        return false;
    }

    private static IpRadixTree BuildTree(List<string> ranges, int maxCount)
    {
        var tree = new IpRadixTree();
        for (int i = 0; i < ranges.Count && i < maxCount; i++)
        {
            var range = ranges[i].AsSpan().Trim();
            var slashIndex = range.IndexOf('/');
            if (slashIndex <= 0 || slashIndex == range.Length - 1)
            {
                continue;
            }

            var ipSpan = range[..slashIndex];
            var lenSpan = range[(slashIndex + 1)..];

            if (IPAddress.TryParse(ipSpan, out var ip) && int.TryParse(lenSpan, out var len))
            {
                tree.Add(ip, len);
            }
        }
        tree.Seal();
        return tree;
    }

    private async Task<bool> VerifyByReverseDnsAsync(IPAddress ip, string ipStr)
    {
        string cacheKey = $"crawler:verified:{ipStr}";

        // A. 查缓存 (极速返回)
        if (cache.TryGetValue(cacheKey, out bool isVerified))
        {
            return isVerified;
        }

        return await VerifyByReverseDnsAsync(ip, ipStr, TimeSpan.FromMilliseconds(200));
    }

    internal async Task<bool> VerifyByReverseDnsAsync(IPAddress ip, string ipStr, TimeSpan timeout)
    {
        string cacheKey = $"crawler:verified:{ipStr}";
        using var cts = new CancellationTokenSource(timeout);
        bool acquired = false;
        bool result = false;

        try
        {
            await _dnsSemaphore.WaitAsync(cts.Token);
            acquired = true;

            // 1. PTR 查询: IP -> 域名 (挂载 CancellationToken 防底层阻塞)
            // 逻辑自洽修复：使用现成的 ipStr (string)，完美契合支持 CancellationToken 的 API 重载
            var hostEntry = await Dns.GetHostEntryAsync(ipStr, cts.Token);
            string hostName = hostEntry.HostName;

            // 2. 域名后缀校验 (核心防伪，精确匹配后缀防止 fakebaidu.com)
            bool isValidDomain = hostName.EndsWith(".baidu.com", StringComparison.OrdinalIgnoreCase) ||
                                 hostName.EndsWith(".baidu.jp", StringComparison.OrdinalIgnoreCase) ||
                                 hostName.EndsWith(".sogou.com", StringComparison.OrdinalIgnoreCase);

            if (isValidDomain)
            {
                // 3. A 记录回查: 域名 -> IP (防黑客伪造 PTR 记录)
                var forwardEntry = await Dns.GetHostEntryAsync(hostName, cts.Token);
                if (forwardEntry.AddressList.Any(x => x.Equals(ip)))
                {
                    result = true;
                }
            }
        }
        catch (OperationCanceledException)
        {
            logger.LogWarning("rDNS 验证遭遇 200ms 超时熔断: {IP}", ipStr);
            result = false;
        }
        catch
        {
            // SocketException 或解析失败均视为伪造
            result = false;
        }
        finally
        {
            if (acquired)
            {
                _dnsSemaphore.Release();
            }
        }

        // C. 写入缓存 (真爬虫存 24h，假爬虫存 1h 防止频繁重试攻击消耗内存与 CPU)
        var options = new MemoryCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = result ? TimeSpan.FromHours(24) : TimeSpan.FromHours(1)
        };
        cache.Set(cacheKey, result, options);

        return result;
    }
}

#region 极速 IP 前缀区间表
public class IpRadixTree
{
    private readonly List<Ipv4Interval> _v4Intervals = [];
    private readonly List<Ipv6Interval> _v6Intervals = [];
    private bool _sealed;

    public void Add(IPAddress ip, int prefixLength)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();

        if (ip.AddressFamily == AddressFamily.InterNetwork)
        {
            if ((uint)prefixLength > 32u)
            {
                return;
            }

            uint value = BinaryPrimitives.ReadUInt32BigEndian(ip.GetAddressBytes());
            uint mask = prefixLength == 0 ? 0u : uint.MaxValue << (32 - prefixLength);
            uint start = value & mask;
            uint end = start | ~mask;
            _v4Intervals.Add(new Ipv4Interval(start, end));
            _sealed = false;
            return;
        }

        if (ip.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if ((uint)prefixLength > 128u)
            {
                return;
            }

            UInt128 value = ReadUInt128BigEndian(ip.GetAddressBytes());
            UInt128 mask = prefixLength == 0 ? UInt128.Zero : UInt128.MaxValue << (128 - prefixLength);
            UInt128 start = value & mask;
            UInt128 end = start | ~mask;
            _v6Intervals.Add(new Ipv6Interval(start, end));
            _sealed = false;
        }
    }

    public bool Contains(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        EnsureSealed();
        if (ip.AddressFamily == AddressFamily.InterNetwork)
        {
            uint value = BinaryPrimitives.ReadUInt32BigEndian(ip.GetAddressBytes());
            return Contains(_v4Intervals, value);
        }

        if (ip.AddressFamily == AddressFamily.InterNetworkV6)
        {
            UInt128 value = ReadUInt128BigEndian(ip.GetAddressBytes());
            return Contains(_v6Intervals, value);
        }

        return false;
    }

    internal void Seal()
    {
        if (_sealed)
        {
            return;
        }

        _v4Intervals.Sort(static (left, right) =>
        {
            int start = left.Start.CompareTo(right.Start);
            return start != 0 ? start : left.End.CompareTo(right.End);
        });
        _v6Intervals.Sort(static (left, right) =>
        {
            int start = left.Start.CompareTo(right.Start);
            return start != 0 ? start : left.End.CompareTo(right.End);
        });
        Merge(_v4Intervals);
        Merge(_v6Intervals);
        _sealed = true;
    }

    private void EnsureSealed()
    {
        if (!_sealed)
        {
            Seal();
        }
    }

    private static bool Contains(List<Ipv4Interval> intervals, uint value)
    {
        int index = FindLastStartLessThanOrEqual(intervals, value);
        return index >= 0 && intervals[index].End >= value;
    }

    private static bool Contains(List<Ipv6Interval> intervals, UInt128 value)
    {
        int index = FindLastStartLessThanOrEqual(intervals, value);
        return index >= 0 && intervals[index].End >= value;
    }

    private static int FindLastStartLessThanOrEqual(List<Ipv4Interval> intervals, uint value)
    {
        int low = 0;
        int high = intervals.Count - 1;
        int result = -1;
        while (low <= high)
        {
            int mid = low + ((high - low) >> 1);
            if (intervals[mid].Start <= value)
            {
                result = mid;
                low = mid + 1;
            }
            else
            {
                high = mid - 1;
            }
        }

        return result;
    }

    private static int FindLastStartLessThanOrEqual(List<Ipv6Interval> intervals, UInt128 value)
    {
        int low = 0;
        int high = intervals.Count - 1;
        int result = -1;
        while (low <= high)
        {
            int mid = low + ((high - low) >> 1);
            if (intervals[mid].Start <= value)
            {
                result = mid;
                low = mid + 1;
            }
            else
            {
                high = mid - 1;
            }
        }

        return result;
    }

    private static void Merge(List<Ipv4Interval> intervals)
    {
        if (intervals.Count <= 1)
        {
            return;
        }

        int write = 0;
        for (int read = 1; read < intervals.Count; read++)
        {
            Ipv4Interval current = intervals[write];
            Ipv4Interval next = intervals[read];
            bool overlapsOrTouches = current.End == uint.MaxValue || next.Start <= current.End + 1u;
            if (overlapsOrTouches)
            {
                intervals[write] = current with { End = Math.Max(current.End, next.End) };
                continue;
            }

            intervals[++write] = next;
        }

        intervals.RemoveRange(write + 1, intervals.Count - write - 1);
    }

    private static void Merge(List<Ipv6Interval> intervals)
    {
        if (intervals.Count <= 1)
        {
            return;
        }

        int write = 0;
        for (int read = 1; read < intervals.Count; read++)
        {
            Ipv6Interval current = intervals[write];
            Ipv6Interval next = intervals[read];
            bool overlapsOrTouches = current.End == UInt128.MaxValue || next.Start <= current.End + (UInt128)1u;
            if (overlapsOrTouches)
            {
                intervals[write] = current with { End = current.End >= next.End ? current.End : next.End };
                continue;
            }

            intervals[++write] = next;
        }

        intervals.RemoveRange(write + 1, intervals.Count - write - 1);
    }

    private static UInt128 ReadUInt128BigEndian(byte[] bytes)
    {
        ulong high = BinaryPrimitives.ReadUInt64BigEndian(bytes.AsSpan(0, 8));
        ulong low = BinaryPrimitives.ReadUInt64BigEndian(bytes.AsSpan(8, 8));
        return ((UInt128)high << 64) | low;
    }

    private readonly record struct Ipv4Interval(uint Start, uint End);
    private readonly record struct Ipv6Interval(UInt128 Start, UInt128 End);
}
#endregion
