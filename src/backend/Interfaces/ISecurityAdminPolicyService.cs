using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Interfaces;

public interface IAntiCrawlerPolicyProvider
{
    AntiCrawlerPolicySnapshot Current { get; }
}

public interface IPowPolicyProvider
{
    PowPolicySnapshot CurrentPow { get; }
}

public interface ICrawlerRangeSyncService
{
    CrawlerRangesAdminStatus GetStatus();

    Task<CrawlerRangeSyncResponse> SynchronizeOnceAsync(CancellationToken cancellationToken = default);
}

public interface ISecurityAdminPolicyService :
    IAntiCrawlerPolicyProvider,
    IPowPolicyProvider,
    ISecurityRiskPolicyProvider
{
    SecurityOverviewResponse BuildSecurityOverview(CrawlerRangeStatus ranges, CrawlerRangesAdminStatus syncStatus);

    AntiCrawlerOverviewResponse BuildAntiCrawlerOverview(CrawlerRangeStatus ranges, CrawlerRangesAdminStatus syncStatus);

    PowOverviewResponse BuildPowOverview();

    AntiCrawlerPolicySnapshot UpdateAntiCrawlerOptions(AntiCrawlerOptionsUpdateRequest request, string changedBy);

    AntiCrawlerPolicySnapshot RollbackAntiCrawlerOptions(string changedBy);

    PowPolicySnapshot UpdatePowOptions(PowOptionsUpdateRequest request, string changedBy);

    PowPolicySnapshot RollbackPowOptions(string changedBy);

    void RecordRiskEvent(AntiCrawlerRiskEventResponse riskEvent);

    void UpsertRiskSnapshot(SecurityRiskSnapshotResponse snapshot);

    IReadOnlyList<AntiCrawlerRiskEventResponse> ListRiskEvents(string? source = null, string? reason = null, int limit = 100);

    IReadOnlyList<SecurityRiskSnapshotResponse> ListRiskSnapshots(int limit = 100);

    IReadOnlyList<AntiCrawlerRuleResponse> ListRules();

    AntiCrawlerRuleResponse AddRule(AntiCrawlerRuleRequest request, string changedBy);

    AntiCrawlerRuleResponse? UpdateRule(string id, AntiCrawlerRuleRequest request, string changedBy);

    bool DeleteRule(string id);

    IReadOnlyList<AntiCrawlerListEntryResponse> ListEntries(string listType);

    AntiCrawlerListEntryResponse AddEntry(string listType, AntiCrawlerListEntryRequest request, string changedBy);

    bool DeleteEntry(string listType, string id);

    AntiCrawlerSimulationResult Simulate(AntiCrawlerSimulationRequest request);
}
