using System.Text.Json;

using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Tests.Fixtures;

namespace FsusBlog.Server.Tests.Unit;

[Collection(nameof(EnvironmentVariableCollection))]
public sealed class ResolvedTemporalRoleContextTests
{
    private const string Digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public void FromEnvironment_ConsumesExactRoleInstantsWithoutRecalculatingOffsets()
    {
        using var environment = new TemporalRoleEnvironment(Artifact(
            ("session.authenticated", "2024-02-29T23:59:59.000Z"),
            ("session.access-token-expiry", "2024-03-01T00:14:59.000Z")));

        ResolvedTemporalRoleContext context = ResolvedTemporalRoleContext.FromEnvironment();

        Assert.Equal("auth-session", context.ProducerId);
        Assert.Equal("temporal-role-test", context.SchedulerRunId);
        Assert.Equal(
            new DateTimeOffset(2024, 2, 29, 23, 59, 59, TimeSpan.Zero),
            context.RequireInstant("session.authenticated"));
        Assert.Equal(
            TimeSpan.FromMinutes(15),
            context.RequireDuration("session.authenticated", "session.access-token-expiry"));
    }

    [Fact]
    public void FromEnvironment_RejectsDigestDriftDuplicateRolesAndPrecisionLoss()
    {
        using (var environment = new TemporalRoleEnvironment(
                   Artifact(("session.authenticated", "2024-02-29T23:59:59.000Z")),
                   environmentDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))
        {
            Assert.Throws<InvalidOperationException>(ResolvedTemporalRoleContext.FromEnvironment);
        }

        using (var environment = new TemporalRoleEnvironment(Artifact(
                   ("session.authenticated", "2024-02-29T23:59:59.000Z"),
                   ("session.authenticated", "2024-02-29T23:59:59.000Z"))))
        {
            Assert.Throws<InvalidOperationException>(ResolvedTemporalRoleContext.FromEnvironment);
        }

        using (var environment = new TemporalRoleEnvironment(Artifact(
                   ("session.authenticated", "2024-02-29T23:59:59.0000001Z"))))
        {
            Assert.Throws<InvalidOperationException>(ResolvedTemporalRoleContext.FromEnvironment);
        }
    }

    private static string Artifact(params (string RoleId, string InstantUtc)[] roles)
        => JsonSerializer.Serialize(new
        {
            schema = "fsusblog.resolved-temporal-roles.v1",
            contextIdentity = new
            {
                producerId = "auth-session",
                schedulerRunId = "temporal-role-test"
            },
            roles = roles.Select(static role => new
            {
                roleId = role.RoleId,
                clockKind = "business-wall",
                semanticEffect = "included",
                precision = "millisecond",
                instantUtc = role.InstantUtc
            }),
            contentDigest = Digest
        });

    private sealed class TemporalRoleEnvironment : IDisposable
    {
        private readonly string? _previousArtifact = Environment.GetEnvironmentVariable(
            ResolvedTemporalRoleContext.ArtifactEnvironmentVariable);
        private readonly string? _previousDigest = Environment.GetEnvironmentVariable(
            ResolvedTemporalRoleContext.ArtifactDigestEnvironmentVariable);

        public TemporalRoleEnvironment(string artifact, string environmentDigest = Digest)
        {
            Environment.SetEnvironmentVariable(
                ResolvedTemporalRoleContext.ArtifactEnvironmentVariable,
                artifact);
            Environment.SetEnvironmentVariable(
                ResolvedTemporalRoleContext.ArtifactDigestEnvironmentVariable,
                environmentDigest);
        }

        public void Dispose()
        {
            Environment.SetEnvironmentVariable(
                ResolvedTemporalRoleContext.ArtifactEnvironmentVariable,
                _previousArtifact);
            Environment.SetEnvironmentVariable(
                ResolvedTemporalRoleContext.ArtifactDigestEnvironmentVariable,
                _previousDigest);
        }
    }
}
