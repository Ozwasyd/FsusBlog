using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.SignalR;

namespace FsusBlog.Server.Infrastructure.SignalR;

/// <summary>
/// SignalR 连接卫士
/// 强制要求：握手时必须携带有效的 PoW Nonce (游客) 或 JWT (用户)
/// </summary>
public class SignalRPoWFilter(IServiceProvider serviceProvider) : IHubFilter
{
    // 方法调用拦截 (保持透传，性能损耗最小化)
    public async ValueTask<object?> InvokeMethodAsync(HubInvocationContext invocationContext, Func<HubInvocationContext, ValueTask<object?>> next)
    {
        return await next(invocationContext);
    }

    // 拦截连接建立 (核心防御逻辑)
    public async Task OnConnectedAsync(HubLifetimeContext context, Func<HubLifetimeContext, Task> next)
    {
        var http = context.Context.GetHttpContext();
        if (http == null) return;

        // 1. 已登录用户直接放行 (JWT 校验由框架层完成)
        if (context.Context.User?.Identity?.IsAuthenticated == true)
        {
            await next(context);
            return;
        }

        // 2. 游客身份：必须进行 PoW 校验
        var query = http.Request.Query;

        // 性能优化：使用 TryGetValue 避免 KeyNotFound 异常，同时减少字符串分配
        // 必须字段
        string nonce = query["nonce"].ToString();
        string salt = query["salt"].ToString();
        string fp = query["fp"].ToString();
        string signature = query["signature"].ToString();

        // 3. 安全性保障：参数完整性检查
        // 缺少任何一个参数都视为非法请求，无需进入昂贵的 Service 校验
        if (string.IsNullOrEmpty(nonce) ||
            string.IsNullOrEmpty(salt) ||
            string.IsNullOrEmpty(fp) ||
            string.IsNullOrEmpty(signature))
        {
            throw new HubException("Access Denied: PoW credentials missing.");
        }

        // 4. 解析数值参数
        // 逻辑自洽：不要设置默认值 (如 : 3)，必须透传前端原始值。
        // 如果前端传的值与签名不一致，Service 层的签名校验自然会失败。
        int.TryParse(query["difficulty"], out int diff);
        long.TryParse(query["timestamp"], out long ts);

        // 5. 调用校验服务
        // 使用 Scope 确保 IPowService (如依赖了 Scoped 的 DbContext) 能正确释放
        using var scope = serviceProvider.CreateScope();
        var powService = scope.ServiceProvider.GetRequiredService<IPowService>();

        // 获取真实 IP (处理代理头)
        string clientIp = http.GetClientIp();

        // 构造虚拟请求对象
        // 核心修正：必须传入真实的 Signature，否则 RedisPowService.BasicValidate 会失败
        var isValid = await powService.VerifyAsync(new VirtualPowRequest
        {
            PowNonce = nonce,
            PowSalt = salt,
            BrowserFp = fp,
            PowSignature = signature, // 关键：透传签名
            Difficulty = diff,        // 关键：透传难度 (由签名锁定)
            PowTimestamp = ts         // 关键：透传时间戳 (由签名锁定)
        }, clientIp);

        if (!isValid)
        {
            // 验证失败，断开连接
            throw new HubException("Access Denied: Invalid PoW or Signature.");
        }

        // 6. 校验通过，放行连接
        await next(context);
    }
    // 内部类用于适配接口 (DTO)
    private class VirtualPowRequest : IPowRequest
    {
        public string PowSalt { get; set; } = "";
        public string PowNonce { get; set; } = "";
        public int Difficulty { get; set; }
        public string BrowserFp { get; set; } = "";
        public long PowTimestamp { get; set; }

        // 逻辑自洽：此前被略过的 Signature 必须恢复
        // 因为 RedisPowService 需要用它来验证 Salt 和 Difficulty 是否被篡改
        public string PowSignature { get; set; } = "";
    }
}