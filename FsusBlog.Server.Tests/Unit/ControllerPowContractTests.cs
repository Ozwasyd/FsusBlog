using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Modules.Controllers;
using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ControllerPowContractTests
{
    [Theory]
    [InlineData(typeof(CategoryController), "Create")]
    [InlineData(typeof(CategoryController), "Update")]
    [InlineData(typeof(CategoryController), "Delete")]
    [InlineData(typeof(TagController), "Create")]
    [InlineData(typeof(TagController), "Update")]
    [InlineData(typeof(TagController), "Delete")]
    public void CategoryAndTagWriteActions_RequirePowFilter(Type controllerType, string actionName)
    {
        var method = controllerType.GetMethod(actionName);
        Assert.NotNull(method);
        Assert.NotNull(method!.GetCustomAttributes(typeof(RequiresPowAttribute), inherit: true).SingleOrDefault());
    }
}
