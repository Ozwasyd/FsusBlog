using FsusBlog.Server.Interfaces;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Models.Dtos;

/// <summary>
/// 用于从 Header 解码并适配 IPowRequest 接口的内部 DTO
/// </summary>
public sealed class VirtualPowRequest : IPowRequest
{
    [JsonPropertyName("powSalt")]
    public string PowSalt { get; set; } = string.Empty;

    [JsonPropertyName("powNonce")]
    public string PowNonce { get; set; } = string.Empty;

    [JsonPropertyName("difficulty")]
    public int Difficulty { get; set; }

    [JsonPropertyName("browserFp")]
    public string BrowserFp { get; set; } = string.Empty;

    [JsonPropertyName("powTimestamp")]
    public long PowTimestamp { get; set; }

    [JsonPropertyName("powSignature")]
    public string PowSignature { get; set; } = string.Empty;
}

/// <summary>
/// [修复 2026-02-24] P1 修复：为 PoW DTO 提供 JsonSerializer 源生成器上下文
/// 逻辑自洽：在编译时生成序列化代码，物理消除运行时的反射开销
/// </summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(VirtualPowRequest))]
public partial class PowJsonContext : JsonSerializerContext
{
}