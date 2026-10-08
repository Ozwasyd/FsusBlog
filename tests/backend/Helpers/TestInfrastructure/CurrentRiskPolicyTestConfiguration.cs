using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static class CurrentRiskPolicyTestConfiguration
{
    public static IConfiguration WithCurrentRiskPolicy(IConfiguration configuration)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Security:RiskControl:GlobalMode"] = SecuritySystemModes.Enforce,
                ["Security:RiskControl:MaxRiskScore"] = "200"
            })
            .AddConfiguration(configuration)
            .Build();
}
