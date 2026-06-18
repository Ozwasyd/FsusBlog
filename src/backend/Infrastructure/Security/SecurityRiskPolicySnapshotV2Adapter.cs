using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Infrastructure.Security;

public static class SecurityRiskPolicySnapshotV2Adapter
{
    public const string DefaultPolicyVersion = "risk-policy-v2";
    private const string DefaultActionName = "*";

    public static SecurityRiskPolicySnapshotV2 FromLegacy(AntiCrawlerPolicySnapshot antiCrawler, PowPolicySnapshot? pow = null)
    {
        ArgumentNullException.ThrowIfNull(antiCrawler);

        AntiCrawlerPolicyOptions options = antiCrawler.Options;
        var thresholds = BuildLegacyPublicReadThresholds(options.RequireChallengeScore, options.BlockScore);
        var defaultPolicy = new SecurityRiskActionPolicy(
            DefaultActionName,
            thresholds,
            options.SecurityChallengeReference,
            1,
            null,
            AnonymousWriteAllowed: false);
        var actionOverrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.PublicRead] = defaultPolicy with
            {
                ActionName = RiskActionNames.PublicRead,
                ModeOverride = options.PublicReadChallengeEnabled ? null : SecuritySystemModes.Disabled,
                AnonymousWriteAllowed = true
            },
            [RiskActionNames.CommentCreate] = defaultPolicy with { ActionName = RiskActionNames.CommentCreate },
            [RiskActionNames.CommentReply] = defaultPolicy with { ActionName = RiskActionNames.CommentReply },
            [RiskActionNames.AuthLogin] = defaultPolicy with { ActionName = RiskActionNames.AuthLogin },
            [RiskActionNames.AuthPasskeyBegin] = defaultPolicy with { ActionName = RiskActionNames.AuthPasskeyBegin },
            [RiskActionNames.AuthPasskeyComplete] = defaultPolicy with { ActionName = RiskActionNames.AuthPasskeyComplete },
            [RiskActionNames.RecoveryKeyVerify] = defaultPolicy with { ActionName = RiskActionNames.RecoveryKeyVerify },
            [RiskActionNames.NotificationSubscribe] = defaultPolicy with { ActionName = RiskActionNames.NotificationSubscribe },
            [RiskActionNames.AdminSecurityWrite] = defaultPolicy with
            {
                ActionName = RiskActionNames.AdminSecurityWrite,
                AnonymousWriteAllowed = true
            },
            [RiskActionNames.AdminCommentBatch] = defaultPolicy with
            {
                ActionName = RiskActionNames.AdminCommentBatch,
                AnonymousWriteAllowed = true
            }
        };
        var subsystemModes = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [SecurityRiskSources.AntiCrawler] = SecuritySystemModes.Normalize(options.Mode),
            [SecurityRiskSources.Pow] = SecuritySystemModes.Normalize(pow?.Options.Mode ?? SecuritySystemModes.Enforce)
        };

        return new SecurityRiskPolicySnapshotV2(
            antiCrawler.SnapshotId,
            DefaultPolicyVersion,
            antiCrawler.UpdatedAtUtc,
            SecuritySystemModes.Normalize(options.Mode),
            options.MaxRiskScore,
            125,
            antiCrawler.SnapshotId,
            defaultPolicy,
            actionOverrides,
            subsystemModes);
    }

    public static SecurityRiskPolicySnapshot ToLegacy(SecurityRiskPolicySnapshotV2 snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);

        SecurityRiskActionPolicy publicRead = snapshot.ResolveActionPolicy(RiskActionNames.PublicRead);
        SecurityRiskActionThresholds thresholds = publicRead.Thresholds;
        string mode = SecuritySystemModes.Normalize(publicRead.ModeOverride ?? snapshot.GlobalMode);
        return new SecurityRiskPolicySnapshot(
            snapshot.SnapshotId,
            thresholds.ChallengeScore,
            thresholds.BlockScore,
            snapshot.MaxRiskScore,
            SecuritySystemModes.IsEnforcing(mode),
            mode != SecuritySystemModes.Disabled,
            mode);
    }

    private static SecurityRiskActionThresholds BuildLegacyPublicReadThresholds(int requireChallengeScore, int blockScore)
    {
        int challenge = Math.Clamp(requireChallengeScore, 1, 1000);
        int block = Math.Clamp(blockScore, challenge, 1000);
        return new SecurityRiskActionThresholds(
            Math.Max(0, challenge - 1),
            challenge,
            block,
            block,
            block);
    }
}
