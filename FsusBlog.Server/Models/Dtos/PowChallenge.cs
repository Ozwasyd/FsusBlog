namespace FsusBlog.Server.Models.Dtos;

// 发送给前端的挑战包
public record PowChallenge(
    string Salt,        // 随机盐值
    int Difficulty,     // 难度等级 (3-5)
    long Timestamp,     // 时间戳 (防止重放)
    string Signature    // HMAC 签名，防止前端篡改上述字段
);