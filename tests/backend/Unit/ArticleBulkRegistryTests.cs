using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Services.Articles.Bulk;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleBulkRegistryTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(100)]
    [InlineData(10_000)]
    public void DigestMatchesCanonicalUtf8JsonForTypedValuesAndLargePlans(int itemCount)
    {
        const string Digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var payload = new
        {
            Registry = ArticleBulkOperationRegistry.Current,
            Values = new object?[]
            {
                null, true, false, long.MinValue, long.MaxValue, decimal.MinValue, decimal.MaxValue,
                0.1234567890123456789012345670m, 1.25d, "\u0000 café 中文 🌱 <>&\r\n",
                Guid.Parse("b06a22ed-143f-44cf-9702-70a6c831e1aa"),
                new DateTime(638962848000000001, DateTimeKind.Utc),
                new DateTimeOffset(2026, 10, 8, 12, 34, 56, TimeSpan.FromHours(5.5)),
                ArticleBulkExecutionStrategy.AllOrNothing,
                JsonSerializer.SerializeToElement(new { Text = "文", Number = 2.5m, Enabled = true }),
                new Dictionary<string, object?> { ["UpperKey"] = "exact", ["empty"] = null }
            },
            Items = Enumerable.Range(0, itemCount).Select(index => new ArticleBulkPlanItem(
                $"article-{index:D5}", ArticleBulkPlanItemStatus.Eligible, "eligible", $"revision-{index}",
                "draft", Digest, Digest, [Digest], Digest, Digest)).ToImmutableArray()
        };
        byte[] canonicalBytes = JsonSerializer.SerializeToUtf8Bytes(
            payload, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = false });

        Assert.Equal(
            $"sha256:{Convert.ToHexStringLower(SHA256.HashData(canonicalBytes))}",
            ArticleBulkDigest.Of(payload));
    }

    [Fact]
    public void DigestPreservesCanonicalJsonRefusalForNonFiniteNumbersAndDepthOverflow()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = false };
        foreach (double value in new[] { double.NaN, double.PositiveInfinity, double.NegativeInfinity })
        {
            Exception? before = Record.Exception(() => JsonSerializer.SerializeToUtf8Bytes(value, options));
            Exception? after = Record.Exception(() => ArticleBulkDigest.Of(value));
            Assert.NotNull(before);
            Assert.NotNull(after);
            Assert.Equal(before.GetType(), after.GetType());
        }
        using JsonDocument document = JsonDocument.Parse(
            new string('[', 65) + "0" + new string(']', 65), new JsonDocumentOptions { MaxDepth = 128 });
        Exception? legacyDepth = Record.Exception(() => JsonSerializer.SerializeToUtf8Bytes(document.RootElement, options));
        Exception? currentDepth = Record.Exception(() => ArticleBulkDigest.Of(document.RootElement));
        Assert.NotNull(legacyDepth);
        Assert.NotNull(currentDepth);
        Assert.Equal(legacyDepth.GetType(), currentDepth.GetType());
    }

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
            ArticleBulkOperationRegistry.Current with
            {
                ContentDigest = ArticleBulkDigest.Of("tampered")
            }));
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

    [Fact]
    public void CanonicalCommandOwnersAreBidirectionallyExactAndExplicitlyUnavailable()
    {
        ImmutableArray<ArticleBulkCanonicalCommandOwner> owners = ArticleBulkCanonicalCommandOwners.Current;

        ArticleBulkCanonicalCommandOwners.ValidateExact(ArticleBulkOperationRegistry.Current.Operations, owners);
        Assert.Equal(8, owners.Length);
        Assert.All(
            owners,
            static owner => Assert.Equal(
                ArticleBulkCommandAdapterAvailability.Unavailable,
                owner.AdapterAvailability));
        Assert.All(ArticleBulkOperationRegistry.Current.Operations, operation =>
            Assert.Contains(
                owners,
                owner => owner.Id == operation.CommandOwner
                    && owner.OperationIds.Contains(operation.Id, StringComparer.Ordinal)));
    }

    [Fact]
    public void CanonicalCommandOwnerCatalogRejectsMissingDuplicateAndUnregisteredOperations()
    {
        ImmutableArray<ArticleBulkCanonicalCommandOwner> owners = ArticleBulkCanonicalCommandOwners.Current;
        ArticleBulkCanonicalCommandOwner first = owners[0];

        Assert.Equal(
            "article-bulk.command-owner-mismatch",
            Assert.Throws<ArticleBulkContractException>(() => ArticleBulkCanonicalCommandOwners.ValidateExact(
                ArticleBulkOperationRegistry.Current.Operations,
                owners.RemoveAt(0))).Code);
        Assert.Equal(
            "article-bulk.command-owner-catalog-invalid",
            Assert.Throws<ArticleBulkContractException>(() => ArticleBulkCanonicalCommandOwners.ValidateExact(
                ArticleBulkOperationRegistry.Current.Operations,
                owners.Add(first))).Code);
        Assert.Equal(
            "article-bulk.command-owner-mismatch",
            Assert.Throws<ArticleBulkContractException>(() => ArticleBulkCanonicalCommandOwners.ValidateExact(
                ArticleBulkOperationRegistry.Current.Operations,
                owners.SetItem(0, first with
                {
                    OperationIds = first.OperationIds.Add("body.replace")
                }))).Code);
    }

    [Theory]
    [InlineData("category.add", "PerItemIsolated", "categoryId")]
    [InlineData("category.remove", "PerItemIsolated", "categoryId")]
    [InlineData("tag.add", "PerItemIsolated", "tagId")]
    [InlineData("tag.remove", "PerItemIsolated", "tagId")]
    [InlineData("property.set", "PerItemIsolated", "definitionId")]
    [InlineData("property.clear", "PerItemIsolated", "definitionId")]
    [InlineData("content-check.run", "PerItemIsolated", "checkIds")]
    [InlineData("relation.reindex", "PerItemIsolated", "indexAuthorityDigest")]
    [InlineData("search.reindex", "PerItemIsolated", "indexAuthorityDigest")]
    [InlineData("lifecycle.archive", "AllOrNothing", "reasonCode")]
    [InlineData("lifecycle.restore", "AllOrNothing", "reasonCode")]
    [InlineData("lifecycle.inbox-to-draft", "AllOrNothing", "reasonCode")]
    [InlineData("lifecycle.draft-to-inbox", "AllOrNothing", "reasonCode")]
    [InlineData("schedule.change", "AllOrNothing", "scheduledAtUtc")]
    public void EveryOperationBindsItsExactStrategySchemaAndOwner(
        string operationId,
        string strategy,
        string requiredField)
    {
        ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(operationId);

        Assert.Equal(strategy, operation.Strategy.ToString());
        Assert.Contains(operation.Parameters, field => field.Name == requiredField);
        Assert.Equal($"fsusblog.article-bulk.parameters.{operationId}.v1", operation.ParameterSchema);
        Assert.Contains(
            ArticleBulkCanonicalCommandOwners.Current,
            owner => owner.Id == operation.CommandOwner && owner.OperationIds.Contains(operationId));
    }

    [Theory]
    [InlineData("category.add", "categoryId", "category-1")]
    [InlineData("lifecycle.archive", "reasonCode", "reason-code")]
    [InlineData("property.set", "typedValueDigest", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("content-check.run", "checkIds", "valid-check")]
    public void CompleteCanonicalParameterValuesRemainUnchanged(
        string operationId,
        string fieldName,
        string value)
    {
        var normalized = ArticleBulkOperationRegistry.NormalizeParameters(
            operationId,
            NormalizationCaseParameters(operationId, value));

        if (fieldName == "checkIds")
        {
            Assert.Equal([value], Assert.IsAssignableFrom<IEnumerable<string>>(normalized[fieldName]));
        }
        else
        {
            Assert.Equal(value, normalized[fieldName]);
        }
    }

    [Theory]
    [InlineData("category.add", "category-1", "\n")]
    [InlineData("category.add", "category-1", "\r\n")]
    [InlineData("lifecycle.archive", "reason-code", "\n")]
    [InlineData("lifecycle.archive", "reason-code", "\r\n")]
    [InlineData("property.set", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "\n")]
    [InlineData("property.set", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "\r\n")]
    [InlineData("content-check.run", "valid-check", "\n")]
    [InlineData("content-check.run", "valid-check", "\r\n")]
    public void CompleteParameterSchemasRejectTrailingNewlines(
        string operationId,
        string validValue,
        string suffix)
    {
        Dictionary<string, JsonElement> parameters = NormalizationCaseParameters(operationId, validValue);
        ArticleBulkOperationRegistry.NormalizeParameters(operationId, parameters);

        Assert.Equal(
            "article-bulk.parameter-invalid",
            Assert.Throws<ArticleBulkContractException>(() => ArticleBulkOperationRegistry.NormalizeParameters(
                operationId,
                NormalizationCaseParameters(operationId, validValue + suffix))).Code);
    }

    [Theory]
    [InlineData(255)]
    [InlineData(256)]
    public void OpaqueIdAcceptsItsOriginalLengthBoundary(int length)
    {
        string value = new('a', length);

        var normalized = ArticleBulkOperationRegistry.NormalizeParameters(
            "category.add",
            Parameters(("categoryId", value)));

        Assert.Equal(value, normalized["categoryId"]);
    }

    [Theory]
    [InlineData(257, "")]
    [InlineData(256, "\n")]
    [InlineData(256, "\r\n")]
    public void OpaqueIdRejectsOverflowAndNewlinesAtItsOriginalBoundary(int length, string suffix)
    {
        Assert.Equal(
            "article-bulk.parameter-invalid",
            Assert.Throws<ArticleBulkContractException>(() => ArticleBulkOperationRegistry.NormalizeParameters(
                "category.add",
                Parameters(("categoryId", new string('a', length) + suffix)))).Code);
    }

    private static Dictionary<string, JsonElement> NormalizationCaseParameters(string operationId, string value) =>
        operationId switch
        {
            "category.add" => Parameters(("categoryId", value)),
            "lifecycle.archive" => Parameters(("reasonCode", value)),
            "property.set" => Parameters(("definitionId", "definition-1"), ("typedValueDigest", value)),
            "content-check.run" => new Dictionary<string, JsonElement>
            {
                ["checkIds"] = JsonSerializer.SerializeToElement(new[] { value })
            },
            _ => throw new ArgumentOutOfRangeException(nameof(operationId))
        };

    private static Dictionary<string, JsonElement> Parameters(params (string Name, string Value)[] pairs) =>
        pairs.ToDictionary(
            static pair => pair.Name,
            static pair => JsonSerializer.SerializeToElement(pair.Value),
            StringComparer.Ordinal);
}
