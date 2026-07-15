using System.Text;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymitySetPolicyTests
{
    [Fact]
    public void MinimumSetSize_ProductionCannotBeConfiguredBelowTwenty()
    {
        AnonymitySetPolicy policy = CreatePolicy("Production", minimumSetSize: 1);

        Assert.Equal(20, policy.MinimumSetSize);
    }

    [Fact]
    public void Evaluate_CommonSetAtMinimum_IsAllowed()
    {
        AnonymitySetPolicy policy = CreatePolicy("Production", minimumSetSize: 20);

        AnonymitySetDecision decision = policy.Evaluate(
            isEligible: true,
            mayComment: true,
            rateClass: "common",
            requiresModeration: false,
            Metadata(("common", 20)));

        Assert.True(decision.Allowed);
        Assert.Equal("common", decision.EffectiveRateClass);
        Assert.Equal(20, decision.SetSize);
        Assert.Equal("allowed", decision.Status);
    }

    [Fact]
    public void Evaluate_KMinusOnePublicClass_MergesToUnknown()
    {
        AnonymitySetPolicy policy = CreatePolicy("Production", minimumSetSize: 20);

        AnonymitySetDecision decision = policy.Evaluate(
            isEligible: true,
            mayComment: true,
            rateClass: "common",
            requiresModeration: false,
            Metadata(("common", 19), ("unknown", 20)));

        Assert.False(decision.Allowed);
        Assert.Equal("unknown", decision.EffectiveRateClass);
        Assert.Equal(20, decision.SetSize);
        Assert.Equal("merge_required", decision.Status);
    }

    [Fact]
    public void Evaluate_KMinusOneWithoutMergeTarget_FailsClosed()
    {
        AnonymitySetPolicy policy = CreatePolicy("Production", minimumSetSize: 20);

        AnonymitySetDecision decision = policy.Evaluate(
            isEligible: true,
            mayComment: true,
            rateClass: "common",
            requiresModeration: false,
            Metadata(("common", 19)));

        Assert.False(decision.Allowed);
        Assert.Equal(19, decision.SetSize);
        Assert.Equal("anonymity_set_too_small", decision.Status);
    }

    private static AnonymitySetPolicy CreatePolicy(string environment, int minimumSetSize)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ASPNETCORE_ENVIRONMENT"] = environment,
                ["AnonymousIdentity:AnonymitySet:MinimumSetSize"] = minimumSetSize.ToString()
            })
            .Build();
        return new AnonymitySetPolicy(configuration);
    }

    private static ReadOnlySpan<byte> Metadata(params (string RateClass, int Size)[] sets)
    {
        string rows = string.Join(',', sets.Select(set =>
            $$"""{"is_eligible":true,"may_comment":true,"rate_class":"{{set.RateClass}}","requires_moderation":false,"size":{{set.Size}}}"""));
        return Encoding.UTF8.GetBytes($$"""{"anonymity_sets":[{{rows}}]}""");
    }
}
