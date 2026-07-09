using System.Runtime.CompilerServices;

namespace FsusBlog.Core.Common;

public readonly struct Result
{
    public bool IsSuccess { get; }
    public bool IsFailure => !IsSuccess;
    public ErrorDetail Error { get; }

    private Result(bool isSuccess, ErrorDetail error)
    {
        IsSuccess = isSuccess;
        Error = error;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result Success() => new(true, ErrorDetail.None);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result Failure(ErrorCode code, string message) => new(false, ErrorDetail.Create(code, message));

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result Failure(in ErrorDetail error) => new(false, error);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result Combine(params Result[] results) => ResultExtensions.Combine(results);
}

public readonly struct Result<T>
{
    public bool IsSuccess { get; }
    public bool IsFailure => !IsSuccess;
    public T? Value { get; }
    public ErrorDetail Error { get; }

    private Result(bool isSuccess, T? value, ErrorDetail error)
    {
        IsSuccess = isSuccess;
        Value = value;
        Error = error;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result<T> Success(T value) => new(true, value, ErrorDetail.None);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result<T> Failure(ErrorCode code, string message) => new(false, default, ErrorDetail.Create(code, message));

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result<T> Failure(in ErrorDetail error) => new(false, default, error);
}

public static class ResultExtensions
{
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result<TOut> Map<TIn, TOut>(this in Result<TIn> result, Func<TIn, TOut> map)
        => !result.IsSuccess || result.Value is null
            ? Result<TOut>.Failure(result.Error)
            : Result<TOut>.Success(map(result.Value));

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static async Task<Result<TOut>> MapAsync<TIn, TOut>(this Task<Result<TIn>> resultTask, Func<TIn, TOut> map)
        => (await resultTask.ConfigureAwait(false)).Map(map);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result<TOut> Bind<TIn, TOut>(this in Result<TIn> result, Func<TIn, Result<TOut>> bind)
        => !result.IsSuccess || result.Value is null
            ? Result<TOut>.Failure(result.Error)
            : bind(result.Value);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static async Task<Result<TOut>> BindAsync<TIn, TOut>(this Task<Result<TIn>> resultTask, Func<TIn, Task<Result<TOut>>> bind)
    {
        Result<TIn> result = await resultTask.ConfigureAwait(false);
        return !result.IsSuccess || result.Value is null
            ? Result<TOut>.Failure(result.Error)
            : await bind(result.Value).ConfigureAwait(false);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result<T> Ensure<T>(this in Result<T> result, Func<T, bool> predicate, ErrorCode code, string message)
        => !result.IsSuccess || result.Value is null
            ? result
            : predicate(result.Value)
                ? result
                : Result<T>.Failure(code, message);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result Tap(this in Result result, Action action)
    {
        if (result.IsSuccess)
        {
            action();
        }

        return result;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result<T> Tap<T>(this in Result<T> result, Action<T> action)
    {
        if (result.IsSuccess && result.Value is not null)
        {
            action(result.Value);
        }

        return result;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result MapError(this in Result result, Func<ErrorDetail, ErrorDetail> map)
        => result.IsSuccess ? result : Result.Failure(map(result.Error));

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result<T> MapError<T>(this in Result<T> result, Func<ErrorDetail, ErrorDetail> map)
        => result.IsSuccess ? result : Result<T>.Failure(map(result.Error));

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result Recover(this in Result result, Func<ErrorDetail, Result> recover)
        => result.IsSuccess ? result : recover(result.Error);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static Result<T> Recover<T>(this in Result<T> result, Func<ErrorDetail, Result<T>> recover)
        => result.IsSuccess ? result : recover(result.Error);

    public static Result Combine(params Result[] results)
        => results.FirstOrDefault(static result => result.IsFailure, Result.Success());
}
