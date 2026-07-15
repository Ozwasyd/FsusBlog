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
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-07-16T08:00:00Z");
    private static readonly string IssuerPublicKeyHash = new('f', 64);
    private static readonly string[] Handles = [new('1', 64), new('2', 64)];

    [Fact]
    public async Task GetAsync_PublishesCommonImmutableFullAndDeltaWithoutCredentialInput()
    {
        string rootHash = CircuitFriendlyRoot(Handles);
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AnonymousCredentialRoot), typeof(AnonymousCredentialRevocation));
        db.Deleteable<AnonymousCredentialRevocation>().Where(item => item.Epoch == Epoch).ExecuteCommand();
        db.Deleteable<AnonymousCredentialRoot>().Where(item => item.Epoch == Epoch).ExecuteCommand();
        db.Insertable(CreateRoot(rootHash)).ExecuteCommand();
        foreach (string handle in Handles)
        {
            db.Insertable(new AnonymousCredentialRevocation
            {
                Epoch = Epoch,
                RootHash = new string('c', 64),
                RevocationHandleHash = handle,
                RevocationRootHash = rootHash,
                Reason = "unit",
                ActorId = "admin",
                RevokedAtUtc = Now.UtcDateTime
            }).ExecuteCommand();
        }

        var service = new AnonymousCredentialRevocationArtifactService(db, new FixedTimeProvider(Now));
        Result<AnonymousCredentialRevocationArtifactCoreModel> full = await service.GetAsync(
            Epoch, Handles.Length, rootHash, AnonymousCredentialRevocationArtifactKinds.Full, 0);
        Result<AnonymousCredentialRevocationArtifactCoreModel> delta = await service.GetAsync(
            Epoch, Handles.Length, rootHash, AnonymousCredentialRevocationArtifactKinds.Delta, 1);

        Assert.True(full.IsSuccess, full.Error.Message);
        Assert.True(delta.IsSuccess, delta.Error.Message);
        Assert.Equal(Handles.Length * 32, full.Value.EntryHashes.Length);
        Assert.Equal(32, delta.Value.EntryHashes.Length);
        Assert.Equal(32, full.Value.ContentHash.Length);
        Assert.Equal(32, full.Value.Signature.Length);
        Assert.NotEqual(full.Value.ContentHash, delta.Value.ContentHash);
        Assert.Equal(rootHash, Convert.ToHexStringLower(full.Value.RevocationRoot));
        byte[] encoded = PodBinaryCodec.EncodeAnonymousCredentialRevocationArtifact(full.Value);
        Assert.True(PodBinaryCodec.TryDecodeAnonymousCredentialRevocationArtifact(encoded, out var decoded));
        Assert.Equal(full.Value, decoded);
    }

    private static AnonymousCredentialRoot CreateRoot(string revocationRoot) => new()
    {
        Epoch = Epoch,
        RootHash = new string('c', 64),
        RevocationRootHash = revocationRoot,
        CircuitId = "fsus.anonymous.comment.v3",
        CircuitNumericId = 7,
        VerifyingKeyHash = new string('d', 64),
        IssuerPublicKeyHash = IssuerPublicKeyHash,
        PublicInputLayoutVersion = 4,
        CircuitMetadata = "{\"revocationAccumulator\":{\"algorithm\":\"circuit-friendly-non-membership.v1\",\"productionZkReady\":true}}",
        RootAttestation = new string('e', 64),
        RootAttestationKeyId = "unit",
        CreatedAtUtc = Now.UtcDateTime,
        ActivatedAtUtc = Now.UtcDateTime,
        ExpiresAtUtc = Now.AddMinutes(30).UtcDateTime,
        GraceExpiresAtUtc = Now.AddMinutes(60).UtcDateTime,
        UpdatedAtUtc = Now.UtcDateTime,
        Status = AnonymousCredentialRootStatuses.Active
    };

    private static string CircuitFriendlyRoot(params string[] handles)
    {
        Result<string> result = AnonymousCredentialRevocationAccumulator.TryComputeCircuitFriendlyRoot(
            Epoch, IssuerPublicKeyHash, handles);
        Assert.True(result.IsSuccess, result.Error.Message);
        return result.Value!;
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
