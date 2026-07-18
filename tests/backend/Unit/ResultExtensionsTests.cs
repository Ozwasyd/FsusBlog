using FsusBlog.Core.Common;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Unit tests for Result, Result&lt;T&gt;, and ResultExtensions — the functional railway-oriented pipeline.
/// All pure value types, zero external dependencies.
/// </summary>
public sealed class ResultExtensionsTests
{
    // ─── Result basics ─────────────────────────────────────────────────────

    [Fact]
    public void Result_Success_IsSuccess()
    {
        var r = Result.Success();
        Assert.True(r.IsSuccess);
        Assert.False(r.IsFailure);
    }

    [Fact]
    public void Result_Failure_IsFailure()
    {
        var r = Result.Failure(ErrorCode.Validation, "bad");
        Assert.False(r.IsSuccess);
        Assert.True(r.IsFailure);
        Assert.Equal(ErrorCode.Validation, r.Error.Code);
        Assert.Equal("bad", r.Error.Message);
    }

    // ─── Result<T> basics ──────────────────────────────────────────────────

    [Fact]
    public void ResultT_Success_CarriesValue()
    {
        var r = Result<int>.Success(42);
        Assert.True(r.IsSuccess);
        Assert.Equal(42, r.Value);
    }

    [Fact]
    public void ResultT_Failure_HasNoValue()
    {
        var r = Result<int>.Failure(ErrorCode.NotFound, "missing");
        Assert.False(r.IsSuccess);
        Assert.Equal(ErrorCode.NotFound, r.Error.Code);
    }

    // ─── Map ───────────────────────────────────────────────────────────────

    [Fact]
    public void Map_SuccessResult_TransformsValue()
    {
        var r = Result<int>.Success(10).Map(x => x * 2);
        Assert.True(r.IsSuccess);
        Assert.Equal(20, r.Value);
    }

    [Fact]
    public void Map_FailureResult_PropagatesError()
    {
        var r = Result<int>.Failure(ErrorCode.Validation, "err").Map(x => x.ToString());
        Assert.False(r.IsSuccess);
        Assert.Equal(ErrorCode.Validation, r.Error.Code);
    }

    // ─── MapAsync ──────────────────────────────────────────────────────────

    [Fact]
    public async Task MapAsync_SuccessTask_TransformsValue()
    {
        var task = Task.FromResult(Result<int>.Success(5));
        var r = await task.MapAsync(x => x + 1);
        Assert.True(r.IsSuccess);
        Assert.Equal(6, r.Value);
    }

    [Fact]
    public async Task MapAsync_FailureTask_PropagatesError()
    {
        var task = Task.FromResult(Result<int>.Failure(ErrorCode.Forbidden, "denied"));
        var r = await task.MapAsync(x => x + 1);
        Assert.False(r.IsSuccess);
        Assert.Equal(ErrorCode.Forbidden, r.Error.Code);
    }

    // ─── Bind ──────────────────────────────────────────────────────────────

    [Fact]
    public void Bind_SuccessToSuccess_ChainsResult()
    {
        var r = Result<int>.Success(10).Bind(x => Result<string>.Success(x.ToString()));
        Assert.True(r.IsSuccess);
        Assert.Equal("10", r.Value);
    }

    [Fact]
    public void Bind_SuccessToFailure_PropagatesInnerError()
    {
        var r = Result<int>.Success(10).Bind(x => Result<string>.Failure(ErrorCode.Validation, "inner"));
        Assert.False(r.IsSuccess);
        Assert.Equal("inner", r.Error.Message);
    }

    [Fact]
    public void Bind_FailureInput_DoesNotInvokeBindFunc()
    {
        bool called = false;
        var r = Result<int>.Failure(ErrorCode.Forbidden, "outer")
            .Bind(x =>
            {
                called = true;
                return Result<string>.Success(x.ToString());
            });
        Assert.False(r.IsSuccess);
        Assert.False(called);
    }

    // ─── BindAsync ─────────────────────────────────────────────────────────

    [Fact]
    public async Task BindAsync_SuccessToSuccess_ChainsResult()
    {
        var task = Task.FromResult(Result<int>.Success(7));
        var r = await task.BindAsync(x => Task.FromResult(Result<string>.Success($"v{x}")));
        Assert.True(r.IsSuccess);
        Assert.Equal("v7", r.Value);
    }

    [Fact]
    public async Task BindAsync_FailureInput_PropagatesError()
    {
        var task = Task.FromResult(Result<int>.Failure(ErrorCode.Validation, "fail"));
        var r = await task.BindAsync(x => Task.FromResult(Result<string>.Success(x.ToString())));
        Assert.False(r.IsSuccess);
        Assert.Equal(ErrorCode.Validation, r.Error.Code);
    }

    // ─── Ensure ────────────────────────────────────────────────────────────

    [Fact]
    public void Ensure_PredicatePasses_ReturnsOriginalResult()
    {
        var r = Result<int>.Success(10).Ensure(x => x > 0, ErrorCode.Validation, "must be positive");
        Assert.True(r.IsSuccess);
        Assert.Equal(10, r.Value);
    }

    [Fact]
    public void Ensure_PredicateFails_ReturnsFailure()
    {
        var r = Result<int>.Success(-1).Ensure(x => x > 0, ErrorCode.Validation, "must be positive");
        Assert.False(r.IsSuccess);
        Assert.Equal(ErrorCode.Validation, r.Error.Code);
    }

    [Fact]
    public void Ensure_FailureInput_IsPassedThrough()
    {
        var r = Result<int>.Failure(ErrorCode.NotFound, "gone")
            .Ensure(x => x > 0, ErrorCode.Validation, "positive");
        Assert.False(r.IsSuccess);
        Assert.Equal(ErrorCode.NotFound, r.Error.Code);
    }

    // ─── Tap ───────────────────────────────────────────────────────────────

    [Fact]
    public void TapResult_SuccessCallsAction()
    {
        bool called = false;
        var r = Result.Success().Tap(() => called = true);
        Assert.True(r.IsSuccess);
        Assert.True(called);
    }

    [Fact]
    public void TapResult_FailureDoesNotCallAction()
    {
        bool called = false;
        var r = Result.Failure(ErrorCode.Validation, "err").Tap(() => called = true);
        Assert.False(r.IsSuccess);
        Assert.False(called);
    }

    [Fact]
    public void TapResultT_SuccessCallsActionWithValue()
    {
        int seen = -1;
        var r = Result<int>.Success(99).Tap(v => seen = v);
        Assert.True(r.IsSuccess);
        Assert.Equal(99, seen);
    }

    [Fact]
    public void TapResultT_FailureDoesNotCallAction()
    {
        bool called = false;
        var r = Result<int>.Failure(ErrorCode.Forbidden, "x").Tap(v => called = true);
        Assert.False(r.IsSuccess);
        Assert.False(called);
    }

    // ─── MapError ──────────────────────────────────────────────────────────

    [Fact]
    public void MapError_FailureTransformsError()
    {
        var r = Result.Failure(ErrorCode.Validation, "original")
            .MapError(e => ErrorDetail.Create(ErrorCode.Unknown, "remapped"));
        Assert.False(r.IsSuccess);
        Assert.Equal(ErrorCode.Unknown, r.Error.Code);
        Assert.Equal("remapped", r.Error.Message);
    }

    [Fact]
    public void MapError_SuccessIsNotTransformed()
    {
        var r = Result.Success()
            .MapError(e => ErrorDetail.Create(ErrorCode.Unknown, "should not appear"));
        Assert.True(r.IsSuccess);
    }

    [Fact]
    public void MapErrorT_FailureTransformsError()
    {
        var r = Result<int>.Failure(ErrorCode.NotFound, "gone")
            .MapError(e => ErrorDetail.Create(ErrorCode.Validation, "rebadge"));
        Assert.False(r.IsSuccess);
        Assert.Equal(ErrorCode.Validation, r.Error.Code);
    }

    // ─── Recover ───────────────────────────────────────────────────────────

    [Fact]
    public void Recover_SuccessIsNotAffected()
    {
        var r = Result.Success().Recover(_ => Result.Failure(ErrorCode.Unknown, "should not apply"));
        Assert.True(r.IsSuccess);
    }

    [Fact]
    public void Recover_FailureWithSuccessfulRecovery_ReturnsSuccess()
    {
        var r = Result.Failure(ErrorCode.NotFound, "missing")
            .Recover(_ => Result.Success());
        Assert.True(r.IsSuccess);
    }

    [Fact]
    public void Recover_FailureWithFailingRecovery_ReturnsNewFailure()
    {
        var r = Result.Failure(ErrorCode.NotFound, "first")
            .Recover(_ => Result.Failure(ErrorCode.Unknown, "second"));
        Assert.False(r.IsSuccess);
        Assert.Equal(ErrorCode.Unknown, r.Error.Code);
    }

    [Fact]
    public void RecoverT_SuccessIsNotAffected()
    {
        var r = Result<int>.Success(1)
            .Recover(_ => Result<int>.Failure(ErrorCode.Unknown, "x"));
        Assert.True(r.IsSuccess);
        Assert.Equal(1, r.Value);
    }

    [Fact]
    public void RecoverT_FailureWithSuccessfulRecovery_ReturnsRecoveredValue()
    {
        var r = Result<int>.Failure(ErrorCode.NotFound, "gone")
            .Recover(_ => Result<int>.Success(0));
        Assert.True(r.IsSuccess);
        Assert.Equal(0, r.Value);
    }

    // ─── Combine ───────────────────────────────────────────────────────────

    [Fact]
    public void Combine_AllSuccess_ReturnsSuccess()
    {
        var r = Result.Combine(Result.Success(), Result.Success(), Result.Success());
        Assert.True(r.IsSuccess);
    }

    [Fact]
    public void Combine_FirstFailure_ReturnsFailure()
    {
        var fail = Result.Failure(ErrorCode.Validation, "first-fail");
        var r = Result.Combine(Result.Success(), fail, Result.Success());
        Assert.False(r.IsSuccess);
        Assert.Equal("first-fail", r.Error.Message);
    }

    [Fact]
    public void Combine_EmptyArray_ReturnsSuccess()
    {
        var r = Result.Combine();
        Assert.True(r.IsSuccess);
    }
}
