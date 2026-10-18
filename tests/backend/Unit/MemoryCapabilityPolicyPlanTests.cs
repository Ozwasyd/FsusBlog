using FsusBlog.Server.Infrastructure.Memory.Capabilities;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MemoryCapabilityPolicyPlanTests
{
    [Fact]
    public void OmittedModesEqualExplicitAutoAndInputMutationsDoNotChangePlan()
    {
        string[] dependencies = ["host"];
        MemoryCapabilityRegistration[] registrations = [new("gpu", dependencies, "device", 1), new("host", [], null, 0)];
        var requested = new Dictionary<string, MemoryCapabilityMode>();
        var omitted = new MemoryCapabilityPolicyPlan(1, registrations, requested, 3);
        var explicitAuto = new MemoryCapabilityPolicyPlan(1, registrations,
            new Dictionary<string, MemoryCapabilityMode> { ["host"] = MemoryCapabilityMode.Auto, ["gpu"] = MemoryCapabilityMode.Auto }, 3);
        Assert.Equal(explicitAuto.DependencyOrder.Select(item => item.Id), omitted.DependencyOrder.Select(item => item.Id));
        Assert.All(omitted.DependencyOrder, item => Assert.Equal(MemoryCapabilityMode.Auto, omitted.Requested(item.Id)));
        dependencies[0] = "missing";
        requested["gpu"] = MemoryCapabilityMode.Disabled;
        Assert.Equal("host", Assert.Single(omitted.DependencyOrder[1].Dependencies));
        Assert.Equal(MemoryCapabilityMode.Auto, omitted.Requested("gpu"));
        Assert.Throws<ArgumentException>(() => omitted.Requested("typo"));
    }

    [Fact]
    public void RequiredTransitiveDisabledDependencyAndCompetingRequirementsRejectWholeRevision()
    {
        MemoryCapabilityRegistration[] registrations = [new("map", ["gpu"], null, 0), new("gpu", ["host"], "device", 0), new("host", [], null, 0)];
        var prior = new MemoryCapabilityPolicyPlan(1, registrations, new Dictionary<string, MemoryCapabilityMode>(), 3);
        Assert.Throws<ArgumentException>(() => new MemoryCapabilityPolicyPlan(2, registrations,
            new Dictionary<string, MemoryCapabilityMode> { ["map"] = MemoryCapabilityMode.Required, ["host"] = MemoryCapabilityMode.Disabled }, 3));
        Assert.Equal(1UL, prior.Revision);
        Assert.All(prior.DependencyOrder, item => Assert.Equal(MemoryCapabilityMode.Auto, prior.Requested(item.Id)));
        Assert.Throws<ArgumentException>(() => Plan(new Dictionary<string, MemoryCapabilityMode>
        {
            ["a"] = MemoryCapabilityMode.Required,
            ["b"] = MemoryCapabilityMode.Required
        }));
    }

    [Fact]
    public void MissingCyclesUnknownSettingsAndOversizedMetadataAreRejected()
    {
        Assert.Throws<ArgumentException>(() => new MemoryCapabilityPolicyPlan(1, [new("a", ["missing"], null, 0)], new Dictionary<string, MemoryCapabilityMode>(), 2));
        Assert.Throws<ArgumentException>(() => new MemoryCapabilityPolicyPlan(1,
            [new("a", ["b"], null, 0), new("b", ["a"], null, 0)], new Dictionary<string, MemoryCapabilityMode>(), 2));
        Assert.Throws<ArgumentException>(() => Plan(new Dictionary<string, MemoryCapabilityMode> { ["typo"] = MemoryCapabilityMode.Auto }));
        Assert.Throws<ArgumentOutOfRangeException>(() => Plan(new Dictionary<string, MemoryCapabilityMode> { ["a"] = (MemoryCapabilityMode)8 }));
        Assert.Throws<ArgumentException>(() => new MemoryCapabilityPolicyPlan(1,
            [new("a", [], null, 0), new("b", [], null, 0)], new Dictionary<string, MemoryCapabilityMode>(), 1));
        Assert.Throws<ArgumentOutOfRangeException>(() => new MemoryCapabilityPolicyPlan(1,
            [new("a", [], null, 0)], new Dictionary<string, MemoryCapabilityMode>(), 0));
    }

    [Fact]
    public void CandidateOrderIsDeterministicAndARequiredUnavailableBackendCannotSilentlyFallback()
    {
        MemoryCapabilityPolicyPlan automatic = Plan();
        var statuses = Statuses(automatic);
        var admissions = Admissions();
        Assert.Equal("a", automatic.SelectQualifiedBackend("device", statuses, admissions));
        Assert.Equal("a", automatic.SelectQualifiedBackend("device", statuses.Reverse().ToDictionary(item => item.Key, item => item.Value), admissions));
        MemoryCapabilityPolicyPlan required = Plan(new Dictionary<string, MemoryCapabilityMode> { ["b"] = MemoryCapabilityMode.Required });
        statuses = Statuses(required);
        Assert.Equal("b", required.SelectQualifiedBackend("device", statuses, admissions));
        statuses["b"] = statuses["b"] with
        {
            RuntimeQualification = MemoryQualification.NotVerified
        };
        Assert.Null(required.SelectQualifiedBackend("device", statuses, admissions));
    }

    [Fact]
    public void EachBackendNeedsCurrentWorkloadAdmissionWithoutChangingOnlineFacts()
    {
        MemoryCapabilityPolicyPlan plan = Plan();
        var statuses = Statuses(plan);
        var admissions = Admissions();
        admissions["a"] = admissions["a"] with
        {
            Admission = MemoryAdmission.BudgetRejected
        };
        Assert.Equal("b", plan.SelectQualifiedBackend("device", statuses, admissions));
        admissions["b"] = admissions["b"] with
        {
            PolicyRevision = 2
        };
        Assert.Null(plan.SelectQualifiedBackend("device", statuses, admissions));
        Assert.All(statuses.Values, status => Assert.Equal(MemoryOnlineState.Online, status.OnlineState));
        admissions = Admissions();
        admissions["a"] = admissions["a"] with
        {
            Qualification = MemoryQualification.NotVerified
        };
        admissions["b"] = admissions["b"] with
        {
            Admission = MemoryAdmission.Ineligible
        };
        Assert.Null(plan.SelectQualifiedBackend("device", statuses, admissions));
    }

    [Fact]
    public void UnqualifiedDependenciesStaleModesAndDrainingStatesCannotSelect()
    {
        MemoryCapabilityPolicyPlan plan = Plan();
        var statuses = Statuses(plan);
        var admissions = Admissions();
        statuses["host"] = statuses["host"] with
        {
            ReleaseQualification = MemoryQualification.NotVerified
        };
        Assert.Null(plan.SelectQualifiedBackend("device", statuses, admissions));
        statuses = Statuses(plan);
        statuses["a"] = statuses["a"] with
        {
            PolicyRevision = 2
        };
        statuses["b"] = statuses["b"] with
        {
            OnlineState = MemoryOnlineState.Draining
        };
        Assert.Null(plan.SelectQualifiedBackend("device", statuses, admissions));
        plan = Plan(new Dictionary<string, MemoryCapabilityMode> { ["a"] = MemoryCapabilityMode.Disabled });
        statuses = Statuses(plan);
        statuses["a"] = statuses["a"] with
        {
            Requested = MemoryCapabilityMode.Auto
        };
        Assert.Equal("b", plan.SelectQualifiedBackend("device", statuses, admissions));
    }

    private static MemoryCapabilityPolicyPlan Plan(IReadOnlyDictionary<string, MemoryCapabilityMode>? requested = null)
        => new(1, [new("b", ["host"], "device", 1), new("a", ["host"], "device", 1), new("host", [], null, 0)],
            requested ?? new Dictionary<string, MemoryCapabilityMode>(), 3);

    private static Dictionary<string, MemoryCapabilityStatus> Statuses(MemoryCapabilityPolicyPlan plan)
        => plan.DependencyOrder.ToDictionary(item => item.Id, item => new MemoryCapabilityStatus(item.Id, 1,
            plan.Requested(item.Id), MemoryDetection.Present, MemoryQualification.Qualified, MemoryQualification.Qualified,
            MemoryOnlineState.Online, item.Id, MemoryAdmission.NotEvaluated, "fixture-only qualified input"));

    private static Dictionary<string, MemoryCapabilityWorkloadAdmission> Admissions()
        => new(StringComparer.Ordinal)
        {
            ["a"] = new(1, MemoryQualification.Qualified, MemoryAdmission.Admitted),
            ["b"] = new(1, MemoryQualification.Qualified, MemoryAdmission.Admitted)
        };
}
