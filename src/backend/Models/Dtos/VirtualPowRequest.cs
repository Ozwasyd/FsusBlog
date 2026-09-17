using FsusBlog.Server.Interfaces;

namespace FsusBlog.Server.Models.Dtos;

/// <summary>
/// 用于从 Header 解码并适配 IPowRequest 接口的内部 DTO
/// </summary>
public sealed class VirtualPowRequest : IPowRequest
{
    public string PowSalt { get; set; } = string.Empty;

    public string PowNonce { get; set; } = string.Empty;

    public int Difficulty
    {
        get; set;
    }

    public string BrowserFp { get; set; } = string.Empty;

    public long PowTimestamp
    {
        get; set;
    }

    public string PowSignature { get; set; } = string.Empty;
}
