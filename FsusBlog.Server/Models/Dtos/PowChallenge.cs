namespace FsusBlog.Server.Models.Dtos;

/// <summary>
/// 发送给前端的 PoW 挑战包
/// 修复日期: 2026-02-23 (重构为 readonly record struct 实现栈分配，在极高频的挑战下发场景中实现零 GC 压力)
/// </summary>
public readonly record struct PowChallenge(
    string Salt,        // 随机盐值
    int Difficulty,     // 难度等级
    long Timestamp,     // 时间戳 (防止重放)
    string Signature    // HMAC 签名，防止前端篡改上述字段
);