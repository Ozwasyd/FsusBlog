using System.Security.Claims;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Modules.Endpoints;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests;

public sealed class AuditProjectionBehaviorTests
{
    [Fact]
    public void AuditRecord_SecurityCriticalAndHighValueEventsRequireDurableWrite()
    {
        DateTime occurredAt = new(2026, 7, 11, 10, 0, 0, DateTimeKind.Utc);
        var ordinary = new AuditRecord(AuditSourceCatalog.Request, AuditTypeCatalog.Business, occurredAt, "ordinary", null);
        var security = ordinary with { Type = AuditTypeCatalog.Security };
        var critical = ordinary with { Severity = AuditSeverityCatalog.Critical };
        var highValue = ordinary with { IsHighValue = true };

        Assert.False(ordinary.RequiresDurableWrite);
        Assert.True(security.RequiresDurableWrite);
        Assert.True(critical.RequiresDurableWrite);
        Assert.True(highValue.RequiresDurableWrite);
    }

    [Fact]
    public void AuditLog_KeepsStructuredIdentityTargetAndTamperEvidenceFields()
    {
        AuditLog row = CreateSensitiveAuditLog();
        row.RecordHash = "record-hash";
        row.RecordMac = "record-mac";
        row.ChainId = "20260711";
        row.PrevHash = "previous-hash";

        Assert.Equal("auth.test", row.Action);
        Assert.Equal("7", row.ActorId);
        Assert.Equal("session", row.TargetType);
        Assert.Equal("success", row.Outcome);
        Assert.Equal("info", row.Severity);
        Assert.Equal("record-hash", row.RecordHash);
        Assert.Equal("record-mac", row.RecordMac);
        Assert.Equal("20260711", row.ChainId);
        Assert.Equal("previous-hash", row.PrevHash);
    }

    [Fact]
    public void ToItemResponse_RedactedModeDoesNotDiscloseSensitiveHashes()
    {
        AuditLog row = CreateSensitiveAuditLog();

        var item = AuditQueryService.ToItemResponse(row, AuditDisclosureMode.PiiRedacted);

        Assert.Equal("pii-redacted", item.PiiMode);
        Assert.Equal("pii-redacted", item.IpHash);
        Assert.Equal("pii-redacted", item.UserAgentHash);
        Assert.Equal("pii-redacted", item.SessionIdHash);
        Assert.Equal("pii-redacted", item.DeviceFingerprintHash);
    }

    [Fact]
    public void ToItemResponse_InvestigationModeDisclosesSensitiveHashes()
    {
        AuditLog row = CreateSensitiveAuditLog();

        var item = AuditQueryService.ToItemResponse(row, AuditDisclosureMode.Investigation);

        Assert.Equal("investigation", item.PiiMode);
        Assert.Equal(row.IpHash, item.IpHash);
        Assert.Equal(row.UserAgentHash, item.UserAgentHash);
        Assert.Equal(row.SessionIdHash, item.SessionIdHash);
        Assert.Equal(row.DeviceFingerprintHash, item.DeviceFingerprintHash);
    }

    [Fact]
    public void ResolveAuditDisclosureMode_OrdinaryAdminRequestFallsBackToRedacted()
    {
        var context = CreateAdminContext(AdminPermissions.AuditRead);

        AuditDisclosureMode mode = AuthoringEndpoints.ResolveAuditDisclosureMode(context, "investigation");

        Assert.Equal(AuditDisclosureMode.PiiRedacted, mode);
    }

    [Fact]
    public void ResolveAuditDisclosureMode_InvestigationPermissionRevealsSensitiveHashes()
    {
        var context = CreateAdminContext(AdminPermissions.AuditRead, AdminPermissions.AuditInvestigate);

        AuditDisclosureMode mode = AuthoringEndpoints.ResolveAuditDisclosureMode(context, "investigation");

        Assert.Equal(AuditDisclosureMode.Investigation, mode);
    }

    [Fact]
    public void AuditCursor_RoundTripsTimestampAndStableTieBreakerId()
    {
        AuditLog row = CreateSensitiveAuditLog();
        row.Id = 900719925474099;
        row.OccurredAtUtc = new DateTime(2026, 7, 11, 10, 9, 8, 765, DateTimeKind.Utc);

        string cursorText = AuditQueryService.EncodeAuditCursor(row);
        bool decoded = AuditQueryService.TryDecodeAuditCursor(cursorText, out AuditQueryService.AuditLogCursor cursor);

        Assert.True(decoded);
        Assert.Equal(row.OccurredAtUtc, cursor.OccurredAtUtc);
        Assert.Equal(row.Id, cursor.Id);
        Assert.False(AuditQueryService.TryDecodeAuditCursor("not-a-cursor", out _));
    }

    private static AuditLog CreateSensitiveAuditLog()
        => new()
        {
            Id = 42,
            Source = AuditSourceCatalog.Auth,
            Type = AuditTypeCatalog.Security,
            Action = "auth.test",
            Outcome = AuditOutcomeCatalog.Success,
            Severity = AuditSeverityCatalog.Info,
            ActorType = AuditActorTypeCatalog.Admin,
            ActorId = "7",
            TargetType = "session",
            TargetId = "42",
            EventInfo = "unit audit",
            OccurredAtUtc = new DateTime(2026, 7, 11, 10, 0, 0, DateTimeKind.Utc),
            IpHash = "ip-hash-full",
            UserAgentHash = "ua-hash-full",
            SessionIdHash = "session-hash-full",
            DeviceFingerprintHash = "device-hash-full"
        };

    private static DefaultHttpContext CreateAdminContext(params string[] permissions)
    {
        var claims = new List<Claim>
        {
            new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new("admin_id", "7")
        };
        claims.AddRange(permissions.Select(static permission => new Claim(AdminPermissions.PermissionClaimType, permission)));

        var context = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(claims, "unit"))
        };
        return context;
    }
}
