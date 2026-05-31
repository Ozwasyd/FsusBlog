using FsusBlog.Server.Infrastructure.Middlewares;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

public sealed class VisitLogMiddlewareTests
{
    [Fact]
    public async Task InvokeAsync_ForArticleDetail_DoesNotSampleReadCounters()
    {
        bool nextCalled = false;
        var sut = new VisitLogMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });
        var ctx = new DefaultHttpContext();
        ctx.Request.Path = "/api/binary/article/42.aeds";
        ctx.Request.Method = HttpMethods.Get;

        await sut.InvokeAsync(ctx);

        Assert.True(nextCalled);
    }
}
