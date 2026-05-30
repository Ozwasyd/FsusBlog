namespace FsusBlog.Core.Common;

public enum ErrorCode : byte
{
    None = 0,
    Validation = 1,
    NotFound = 2,
    Conflict = 3,
    Unauthorized = 4,
    Forbidden = 5,
    InfraFailure = 6,
    Unknown = 7
}
