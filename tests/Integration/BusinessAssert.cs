namespace FsusBlog.V2.Integration.Tests;

internal static class BusinessAssert
{
    internal static Task Denied(Func<Task> action) => Denied(Rejection.Unauthorized, action);

    internal static async Task Denied(Rejection expected, Func<Task> action) =>
        Assert.Equal(expected, (await Assert.ThrowsAsync<BusinessException>(action)).Rejection);
}
