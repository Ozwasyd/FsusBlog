using FsusBlog.Server.Infrastructure.Operations;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests;

public sealed class BackendConfigurationContractTests
{
    [Fact]
    public void ProductionRequiredSettingsExactlyMatchStartupValidatorSchema()
    {
        IConfiguration configuration = new ConfigurationBuilder().Build();
        ProductionStartupValidationReport report = ProductionStartupValidator.CreateValidationReport(
            configuration,
            enforceProductionRules: true);

        string[] requiredSettings = ProductionStartupValidator.CurrentSchema.RequiredSettings
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] reportedSettings = report.Requirements
            .Select(static requirement => requirement.Key)
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.NotEmpty(requiredSettings);
        Assert.Equal(ProductionStartupValidator.CurrentSchema.Version, report.SchemaVersion);
        Assert.True(report.EnforceProductionRules);
        Assert.Equal(requiredSettings, reportedSettings);
        Assert.All(report.Requirements, static requirement => Assert.False(requirement.IsPresent));
        Assert.All(
            requiredSettings,
            setting => Assert.Contains($"{setting} is required.", report.Errors, StringComparer.Ordinal));
    }
}
