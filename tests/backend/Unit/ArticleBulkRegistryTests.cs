using System.Text.Json;

using FsusBlog.Server.Services.Articles.Bulk;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleBulkRegistryTests
{
    [Fact]
    public void Registry_IsClosedVersionedAndStrategyExact()
    {
        ArticleBulkRegistrySnapshot registry = ArticleBulkOperationRegistry.Current;

        ArticleBulkOperationRegistry.Validate(registry);
        Assert.Null(registry.DefaultStrategy);
        Assert.Equal(14, registry.Operations.Length);
        Assert.Equal(
            ["category.add", "category.remove", "content-check.run", "property.clear", "property.set",
                "relation.reindex", "search.reindex", "tag.add", "tag.remove"],
            registry.Operations
                .Where(static operation => operation.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated)
                .Select(static operation => operation.Id)
                .Order(StringComparer.Ordinal));
        Assert.Equal(
            ["lifecycle.archive", "lifecycle.draft-to-inbox", "lifecycle.inbox-to-draft",
                "lifecycle.restore", "schedule.change"],
            registry.Operations
                .Where(static operation => operation.Strategy == ArticleBulkExecutionStrategy.AllOrNothing)
                .Select(static operation => operation.Id)
                .Order(StringComparer.Ordinal));
        Assert.All(
            registry.Operations.Where(static operation => operation.Id is "content-check.run"
                or "relation.reindex" or "search.reindex"),
            static operation => Assert.False(operation.MutatesBusinessState));
        Assert.All(registry.Operations, static operation =>
        {
            Assert.Equal(1, operation.Version);
            Assert.Equal(10_000, operation.MaximumBatchSize);
            Assert.NotEmpty(operation.CommandOwner);
            Assert.NotEmpty(operation.PermissionPolicy);
            Assert.NotEmpty(operation.SideEffectOwners);
            Assert.NotEmpty(operation.Parameters);
            Assert.False(string.IsNullOrWhiteSpace(operation.ParameterSchema));
        });
    }

    [Fact]
    public void Registry_RejectsForbiddenOperationsTamperAndMalformedParameters()
    {
        Assert.Throws<ArticleBulkContractException>(() => ArticleBulkOperationRegistry.Get("body.replace"));
        Assert.Throws<ArticleBulkContractException>(() => ArticleBulkOperationRegistry.Get("sql.execute"));
        Assert.Throws<ArticleBulkContractException>(() => ArticleBulkOperationRegistry.Get("ai.rewrite"));
        Assert.Throws<ArticleBulkContractException>(() => ArticleBulkOperationRegistry.Validate(
            ArticleBulkOperationRegistry.Current with { ContentDigest = ArticleBulkDigest.Of("tampered") }));
        Assert.Throws<ArticleBulkContractException>(() => ArticleBulkOperationRegistry.NormalizeParameters(
            "category.add",
            Parameters(("categoryId", "category-1"), ("hidden", "value"))));
        Assert.Throws<ArticleBulkContractException>(() => ArticleBulkOperationRegistry.NormalizeParameters(
            "content-check.run",
            new Dictionary<string, JsonElement>
            {
                ["checkIds"] = JsonSerializer.SerializeToElement(Enumerable.Repeat("duplicate", 2))
            }));

        var normalized = ArticleBulkOperationRegistry.NormalizeParameters(
            "content-check.run",
            new Dictionary<string, JsonElement>
            {
                ["checkIds"] = JsonSerializer.SerializeToElement(new[] { "z-check", "a-check" })
            });
        Assert.Equal(["a-check", "z-check"], Assert.IsAssignableFrom<IEnumerable<string>>(normalized["checkIds"]));

        var schedule = ArticleBulkOperationRegistry.NormalizeParameters(
            "schedule.change",
            Parameters(("scheduledAtUtc", "2026-09-04T12:00:00.1234567Z")));
        Assert.Equal("2026-09-04T12:00:00.1234567Z", schedule["scheduledAtUtc"]);
    }

    private static Dictionary<string, JsonElement> Parameters(params (string Name, string Value)[] pairs) =>
        pairs.ToDictionary(
            static pair => pair.Name,
            static pair => JsonSerializer.SerializeToElement(pair.Value),
            StringComparer.Ordinal);
}
