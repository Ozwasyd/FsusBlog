namespace FsusBlog.Core.Common;

public readonly struct Result
{
    public bool IsSuccess { get; }
    public ErrorDetail Error { get; }

    private Result(bool isSuccess, ErrorDetail error)
    {
        IsSuccess = isSuccess;
        Error = error;
    }

    public static Result Success() => new(true, ErrorDetail.None);

    public static Result Failure(ErrorCode code, string message) => new(false, new ErrorDetail(code, message));
}

public readonly struct Result<T>
{
    public bool IsSuccess { get; }
    public T? Value { get; }
    public ErrorDetail Error { get; }

    private Result(bool isSuccess, T? value, ErrorDetail error)
    {
        IsSuccess = isSuccess;
        Value = value;
        Error = error;
    }

    public static Result<T> Success(T value) => new(true, value, ErrorDetail.None);

    public static Result<T> Failure(ErrorCode code, string message) => new(false, default, new ErrorDetail(code, message));
}
