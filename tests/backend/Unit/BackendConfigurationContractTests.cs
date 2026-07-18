using System.Text.Json;

using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Tests;

public sealed class BackendConfigurationContractTests
{
    [Fact]
    public void ProductionRequiredSettingsExactlyMatchStartupValidatorSchema()
    {
        using JsonDocument document = JsonDocument.Parse(
            BackendTestPaths.ReadAllTextFromRoot(
                "config",
                "application",
                "backend-configuration-contract.json"));

        string[] requiredSettings = document.RootElement
            .GetProperty("applicationSettings")
            .EnumerateArray()
            .Where(static entry =>
                entry.GetProperty("requiredStatus").GetString() == "required"
                && entry.GetProperty("requiredWhen").GetString() == "Production")
            .Select(static entry => entry.GetProperty("key").GetString()!)
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(
            ProductionStartupValidator.CurrentSchema.RequiredSettings.Order(StringComparer.Ordinal),
            requiredSettings);
    }
}
