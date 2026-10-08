using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AnonymousCredentialRevocationArtifactServiceTests(PostgresSchemaMigrationFixture fixture)
{
    private const long Epoch = 4096;
    private static readonly DateTimeOffset s_now = DateTimeOffset.Parse("2026-07-16T08:00:00Z");
    private static readonly string s_issuerPublicKeyHash = new('f', 64);
    private static readonly string[] s_handles = [new('1', 64), new('2', 64)];

    [Fact]
    public void WithDistributionMetadata_IssuesCoordinatesWithoutUrlEscape()
    {
        using System.Text.Json.JsonDocument document = System.Text.Json.JsonDocument.Parse(
            AnonymousCredentialRevocationArtifactService.WithDistributionMetadata("{}", Epoch, 2, new string('a', 64)));
        System.Text.Json.JsonElement distribution = document.RootElement.GetProperty("revocationDistribution");
        System.Text.Json.JsonElement snapshot = distribution.GetProperty("snapshot");
        System.Text.Json.JsonElement delta = distribution.GetProperty("delta");
        Assert.Equal("snapshot", snapshot.GetProperty("kind").GetString());
        Assert.Equal(Epoch, snapshot.GetProperty("epoch").GetInt64());
        Assert.Equal(2, snapshot.GetProperty("version").GetInt64());
        Assert.Equal(new string('a', 64), snapshot.GetProperty("revocationRoot").GetString());
        Assert.Equal("delta", delta.GetProperty("kind").GetString());
        Assert.Equal(1, delta.GetProperty("baseVersion").GetInt64());
        Assert.False(distribution.TryGetProperty("snapshotPath", out _));
        Assert.False(distribution.TryGetProperty("deltaPath", out _));
        Assert.DoesNotContain("/api/", document.RootElement.GetRawText());
    }

    [Fact]
    public async Task GetAsync_PublishesCommonImmutableFullAndDeltaWithoutCredentialInput()
    {
        string rootHash = CircuitFriendlyRoot(s_handles);
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AnonymousCredentialRoot), typeof(AnonymousCredentialRevocation));
        db.Deleteable<AnonymousCredentialRevocation>().Where(item => item.Epoch == Epoch).ExecuteCommand();
        db.Deleteable<AnonymousCredentialRoot>().Where(item => item.Epoch == Epoch).ExecuteCommand();
        db.Insertable(CreateRoot(rootHash)).ExecuteCommand();
        foreach (string handle in s_handles)
        {
            db.Insertable(new AnonymousCredentialRevocation
            {
                Epoch = Epoch,
                RootHash = new string('c', 64),
                RevocationHandleHash = handle,
                RevocationRootHash = rootHash,
                Reason = "unit",
                ActorId = "admin",
                RevokedAtUtc = s_now.UtcDateTime
            }).ExecuteCommand();
        }

        var service = new AnonymousCredentialRevocationArtifactService(db, new FixedTimeProvider(s_now));
        Result<AnonymousCredentialRevocationArtifactCoreModel> full = await service.GetAsync(
            Epoch, s_handles.Length, rootHash, AnonymousCredentialRevocationArtifactKinds.Full, 0);
        Result<AnonymousCredentialRevocationArtifactCoreModel> delta = await service.GetAsync(
            Epoch, s_handles.Length, rootHash, AnonymousCredentialRevocationArtifactKinds.Delta, 1);

        Assert.True(full.IsSuccess, full.Error.Message);
        Assert.True(delta.IsSuccess, delta.Error.Message);
        Assert.Equal(s_handles.Length * 32, full.Value.EntryHashes.Length);
        Assert.Equal(32, delta.Value.EntryHashes.Length);
        Assert.Equal(32, full.Value.ContentHash.Length);
        Assert.Equal(32, full.Value.Signature.Length);
        Assert.False(full.Value.ContentHash.AsSpan().SequenceEqual(delta.Value.ContentHash));
        Assert.Equal(rootHash, Convert.ToHexStringLower(full.Value.RevocationRoot));
        byte[] encoded = PodBinaryCodec.EncodeAnonymousCredentialRevocationArtifact(full.Value);
        Assert.True(PodBinaryCodec.TryDecodeAnonymousCredentialRevocationArtifact(encoded, out var decoded));
        Assert.Equal(full.Value.CredentialEpoch, decoded.CredentialEpoch);
        Assert.Equal(full.Value.Version, decoded.Version);
        Assert.Equal(full.Value.BaseVersion, decoded.BaseVersion);
        Assert.Equal(full.Value.ExpiresAtUnixMs, decoded.ExpiresAtUnixMs);
        Assert.Equal(full.Value.Kind, decoded.Kind);
        Assert.Equal(full.Value.PathDepth, decoded.PathDepth);
        Assert.Equal(full.Value.AlgorithmId, decoded.AlgorithmId);
        Assert.Equal(full.Value.IssuerPublicKeyHash, decoded.IssuerPublicKeyHash);
        Assert.True(full.Value.RevocationRoot.AsSpan().SequenceEqual(decoded.RevocationRoot));
        Assert.True(full.Value.ContentHash.AsSpan().SequenceEqual(decoded.ContentHash));
        Assert.True(full.Value.Signature.AsSpan().SequenceEqual(decoded.Signature));
        Assert.True(full.Value.EntryHashes.AsSpan().SequenceEqual(decoded.EntryHashes));
    }

    private static AnonymousCredentialRoot CreateRoot(string revocationRoot) => new()
    {
        Epoch = Epoch,
        RootHash = new string('c', 64),
        RevocationRootHash = revocationRoot,
        CircuitId = "fsus.anonymous.comment.v5",
        CircuitNumericId = 7,
        VerifyingKeyHash = new string('d', 64),
        IssuerPublicKeyHash = s_issuerPublicKeyHash,
        PublicInputLayoutVersion = 6,
        CircuitMetadata = "{\"revocationAccumulator\":{\"algorithm\":\"circuit-friendly-non-membership.v1\",\"productionZkReady\":true}}",
        RootAttestation = new string('e', 64),
        RootAttestationKeyId = "unit",
        CreatedAtUtc = s_now.UtcDateTime,
        ActivatedAtUtc = s_now.UtcDateTime,
        ExpiresAtUtc = s_now.AddMinutes(30).UtcDateTime,
        GraceExpiresAtUtc = s_now.AddMinutes(60).UtcDateTime,
        UpdatedAtUtc = s_now.UtcDateTime,
        Status = AnonymousCredentialRootStatuses.Active
    };

    private static string CircuitFriendlyRoot(params string[] handles)
    {
        Result<string> result = AnonymousCredentialRevocationAccumulator.TryComputeCircuitFriendlyRoot(
            Epoch, s_issuerPublicKeyHash, handles);
        Assert.True(result.IsSuccess, result.Error.Message);
        return result.Value!;
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
