namespace FsusBlog.Core.Common;

public readonly record struct ErrorDetail(ErrorCode Code, string Message)
{
    public static readonly ErrorDetail None = new(ErrorCode.None, string.Empty);
}
