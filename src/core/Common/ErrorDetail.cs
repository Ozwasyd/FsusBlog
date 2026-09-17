namespace FsusBlog.Core.Common;

public readonly record struct ErrorDetail(
    ErrorCode Code,
    string Message,
    ErrorCategory Category = ErrorCategory.None,
    string? Details = null,
    string? TraceId = null)
{
    public static readonly ErrorDetail None = new(ErrorCode.None, string.Empty);

    public static ErrorDetail Create(ErrorCode code, string message, string? details = null, string? traceId = null)
        => new(code, message, GetCategory(code), details, traceId);

    public static ErrorCategory GetCategory(ErrorCode code)
        => code switch
        {
            ErrorCode.Validation => ErrorCategory.Validation,
            ErrorCode.NotFound => ErrorCategory.NotFound,
            ErrorCode.Conflict => ErrorCategory.Conflict,
            ErrorCode.Unauthorized => ErrorCategory.Unauthorized,
            ErrorCode.Forbidden => ErrorCategory.Forbidden,
            ErrorCode.InfraFailure => ErrorCategory.InternalUnexpected,
            _ => ErrorCategory.InternalUnexpected
        };

    public ErrorDetail WithTraceId(string? traceId)
        => string.IsNullOrWhiteSpace(traceId) || !string.IsNullOrWhiteSpace(TraceId)
            ? this
            : this with
            {
                TraceId = traceId
            };

    public ErrorDetail Normalize()
        => this with
        {
            Category = Category == ErrorCategory.None ? GetCategory(Code) : Category
        };
}
