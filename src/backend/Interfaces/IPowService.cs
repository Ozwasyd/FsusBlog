using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public interface IPowService
{
    /// <summary>
    /// 生成一个新的挑战
    /// </summary>
    /// <param name="clientIp">用于指纹签名的客户端IP</param>
    Task<PowChallenge> GenerateChallengeAsync(string clientIp, string? bindingContext = null);

    /// <summary>
    /// 验证前端提交的 PoW 结果
    /// </summary>
    Task<bool> VerifyAsync(IPowRequest req, string clientIp, string? bindingContext = null);
}
