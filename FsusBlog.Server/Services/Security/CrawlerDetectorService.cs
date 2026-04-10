using Microsoft.Extensions.Caching.Memory;
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

        // 核心修复：声明 200ms 硬性超时 Token，不仅管控信号量，更掐断底层 DNS IO 请求
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));

        // B. 缓存未命中，发起真实 DNS 查询 (带并发熔断保护)
        if (!await _dnsSemaphore.WaitAsync(TimeSpan.FromMilliseconds(200), cts.Token))
        {
            logger.LogWarning("DNS 验证触发并发防线，降级拦截 IP: {IP}", ipStr);
            return false;
        }

        bool result = false;
        try
        {
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
            _dnsSemaphore.Release();
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

#region 极速 IP 前缀树 (Radix Tree)
public class IpRadixTree
{
    private readonly IpTrieNode _v4Root = new();
    private readonly IpTrieNode _v6Root = new();

    public void Add(IPAddress ip, int prefixLength)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();

        var root = ip.AddressFamily == AddressFamily.InterNetwork ? _v4Root : _v6Root;
        byte[] bytes = ip.GetAddressBytes();
        IpTrieNode current = root;

        for (int i = 0; i < prefixLength; i++)
        {
            int byteIndex = i / 8;
            int bitIndex = 7 - (i % 8);
            bool bit = ((bytes[byteIndex] >> bitIndex) & 1) == 1;

            if (bit)
            {
                current.One ??= new IpTrieNode();
                current = current.One;
            }
            else
            {
                current.Zero ??= new IpTrieNode();
                current = current.Zero;
            }
        }
        current.IsMatch = true;
    }

    public bool Contains(IPAddress ip)
    {
        var root = ip.AddressFamily == AddressFamily.InterNetwork ? _v4Root : _v6Root;
        byte[] bytes = ip.GetAddressBytes();

        // 此处的 current 初始值为 root，不可能为 null
        IpTrieNode current = root;

        for (int i = 0; i < bytes.Length * 8; i++)
        {
            if (current.IsMatch) return true; // 命中被包裹的父网段

            int byteIndex = i / 8;
            int bitIndex = 7 - (i % 8);
            bool bit = ((bytes[byteIndex] >> bitIndex) & 1) == 1;

            // 安全性保障：使用可空引用类型过渡，消除编译警告，逻辑自洽
            IpTrieNode? nextNode = bit ? current.One : current.Zero;

            if (nextNode == null) return false;

            // 确认 nextNode 不为 null 后再赋给 current
            current = nextNode;
        }
        return current.IsMatch;
    }
}

public class IpTrieNode
{
    public IpTrieNode? Zero { get; set; }
    public IpTrieNode? One { get; set; }
    public bool IsMatch { get; set; }
}
#endregion
