using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RedisOperationBudgetCatalogTests
{
    [Fact]
    public void EmbeddedContractMapsEveryOperationClassExactlyOnce()
    {
        var catalog = new RedisOperationBudgetCatalog();
        RedisOperationClass[] operationClasses = Enum.GetValues<RedisOperationClass>();

        RedisOperationBudget[] budgets = operationClasses.Select(catalog.Get).ToArray();

        Assert.Equal(7, budgets.Length);
        Assert.Equal(7, budgets.Select(static budget => budget.Id).Distinct(StringComparer.Ordinal).Count());
        Assert.All(budgets, static budget =>
        {
            Assert.True(budget.ConnectDeadline > TimeSpan.Zero);
            Assert.True(budget.CommandDeadline > TimeSpan.Zero);
            Assert.True(budget.EndToEndDeadline > TimeSpan.Zero);
            Assert.InRange(budget.MaxConcurrency, 1, 1024);
            Assert.True(budget.ConnectDeadline <= budget.EndToEndDeadline);
            Assert.True(budget.CommandDeadline <= budget.EndToEndDeadline);
            Assert.InRange(budget.RetryCount, 0, 1);
            if (budget.RetryCount > 0)
            {
                Assert.Equal("idempotent-only", budget.IdempotencyRequirement);
            }
        });
        Assert.Equal(
            budgets.Max(static budget => budget.EndToEndDeadline).TotalMilliseconds,
            catalog.TransportTimeoutMilliseconds);
        Assert.Equal(
            budgets.Max(static budget => budget.ConnectDeadline).TotalMilliseconds,
            catalog.TransportConnectTimeoutMilliseconds);
    }

    [Fact]
    public void EmbeddedContractMapsEveryDeclaredRedisPortExactlyOnce()
    {
        var catalog = new RedisOperationBudgetCatalog();
        RedisOperationPort[] declared = Enum.GetValues<RedisOperationPort>();

        RedisOperationPortDefinition[] mapped = declared.Select(catalog.Get).ToArray();

        Assert.Equal(39, declared.Length);
        Assert.Equal(declared.Length, mapped.Length);
        Assert.Equal(declared.Length, mapped.Select(static item => item.Id).Distinct(StringComparer.Ordinal).Count());
        Assert.Equal(declared.Order(), mapped.Select(static item => item.Port).Order());
        Assert.All(mapped, item => Assert.Equal(item.OperationClass, catalog.Get(item.OperationClass).OperationClass));
    }

    [Theory]
    [InlineData(RedisOperationClass.SecurityAtomic, "security-atomic", "fail-closed", true, 0)]
    [InlineData(RedisOperationClass.CoordinationLease, "coordination-lease", "deny-origin-without-lease", true, 0)]
    [InlineData(RedisOperationClass.ContentCacheRead, "content-cache-read", "bounded-origin-gate", true, 1)]
    [InlineData(RedisOperationClass.ContentCacheWrite, "content-cache-write", "return-result-degraded", true, 1)]
    [InlineData(RedisOperationClass.OptionalProjection, "optional-projection", "use-local-or-base-value", true, 0)]
    [InlineData(RedisOperationClass.DistributedDelivery, "distributed-delivery", "record-degraded-and-replay", false, 1)]
    [InlineData(RedisOperationClass.BackgroundMaintenance, "background-maintenance", "defer-maintenance", false, 1)]
    public void ContractKeepsFailureAndRetrySemanticsExplicit(
        RedisOperationClass operationClass,
        string id,
        string failAction,
        bool foreground,
        int retries)
    {
        RedisOperationBudget budget = new RedisOperationBudgetCatalog().Get(operationClass);

        Assert.Equal(id, budget.Id);
        Assert.Equal(failAction, budget.FailAction);
        Assert.Equal(foreground, budget.Foreground);
        Assert.Equal(retries, budget.RetryCount);
    }
}
