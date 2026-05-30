namespace FsusBlog.Core.Common;

public enum ErrorCategory : byte
{
    None = 0,
    Validation = 1,
    Unauthorized = 2,
    Forbidden = 3,
    NotFound = 4,
    Conflict = 5,
    Cancelled = 6,
    SerializationFailure = 7,
    DatabaseFailure = 8,
    FileIoFailure = 9,
    CacheFailure = 10,
    SearchFailure = 11,
    ExternalDependencyFailure = 12,
    InternalUnexpected = 13
}
