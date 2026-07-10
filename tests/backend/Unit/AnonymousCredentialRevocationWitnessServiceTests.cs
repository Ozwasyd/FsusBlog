using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AnonymousCredentialRevocationWitnessServiceTests(PostgresSchemaMigrationFixture fixture)
{
    private const long Epoch = 4096;
    private static readonly string IssuerPublicKeyHash = new('f', 64);
    private static readonly string RevokedHandleHash = new('a', 64);
    private static readonly string CandidateHandleHash = new('b', 64);

    [Fact]
    public async Task CreateWitnessAsync_CircuitFriendlyRoot_ReturnsVerifiableNonMembershipWitness()
    {
        string revocationRoot = CircuitFriendlyRoot(RevokedHandleHash);
        using SqlSugarClient db = await CreateDbAsync();
        CreateRevocationTable(db);
        db.Insertable(new AnonymousCredentialRevocation
        {
            Epoch = Epoch,
            RootHash = "credential-root",
            RevocationHandleHash = RevokedHandleHash,
            RevocationRootHash = revocationRoot,
            Reason = "unit",
            ActorId = "admin",
            RevokedAtUtc = DateTime.UtcNow
        }).ExecuteCommand();
            var service = new AnonymousCredentialRevocationWitnessService(
                new FixedRootService(CreateSnapshot(revocationRoot)),
                db);
            var request = new AnonymousCredentialRevocationWitnessRequestCoreModel(
                CredentialEpoch: Epoch,
                CircuitNumericId: 7,
                PublicInputLayoutVersion: 3,
                CircuitId: "fsus.anonymous.comment.v2",
                IssuerPublicKeyHash: IssuerPublicKeyHash,
                RevocationRoot: Convert.FromHexString(revocationRoot),
                RevocationHandleHash: Convert.FromHexString(CandidateHandleHash));

            Result<AnonymousCredentialRevocationWitnessResponseCoreModel> result = await service.CreateWitnessAsync(
                request,
                CancellationToken.None);

            Assert.True(result.IsSuccess, result.Error.Message);
            AnonymousCredentialRevocationWitnessResponseCoreModel response = result.Value;
            Assert.Equal(Epoch, response.CredentialEpoch);
            Assert.Equal(AnonymousCredentialRevocationAccumulator.CircuitFriendlyNonMembershipAlgorithmId, response.AlgorithmId);
            Assert.Equal(128, response.PathDepth);
            Assert.Equal(Convert.FromHexString(revocationRoot), response.RevocationRoot);
            Assert.Equal(IssuerPublicKeyHash, response.IssuerPublicKeyHash);
            Assert.Equal(Convert.FromHexString(CandidateHandleHash), response.RevocationHandleHash);
            Assert.Equal(16, response.LeafKey.Length);
            Assert.Equal(32, response.WitnessHash.Length);
            Assert.Equal(128 * 32, response.SiblingHashes.Length);
            var witness = new AnonymousCredentialNonMembershipWitness(
                Epoch,
                revocationRoot,
                IssuerPublicKeyHash,
                CandidateHandleHash,
                string.Empty,
                string.Empty,
                Convert.ToHexStringLower(response.WitnessHash),
                response.AlgorithmId,
                response.PathDepth,
                SplitSiblingHashes(response.SiblingHashes),
                Convert.ToHexStringLower(response.LeafKey));
            Assert.True(AnonymousCredentialRevocationAccumulator.VerifyCircuitFriendlyNonMembershipWitness(witness));
            Assert.True(AnonymousCredentialRevocationAccumulator.VerifyCircuitFriendlyNonMembershipWitness(
                witness,
                [RevokedHandleHash]));
    }

    private static AnonymousCredentialRootSnapshotCoreModel CreateSnapshot(string revocationRoot)
        => new(
            CredentialEpoch: Epoch,
            RootExpiresAtUnixMs: DateTimeOffset.UtcNow.AddMinutes(30).ToUnixTimeMilliseconds(),
            RootGraceExpiresAtUnixMs: DateTimeOffset.UtcNow.AddMinutes(60).ToUnixTimeMilliseconds(),
            CircuitNumericId: 7,
            PublicInputLayoutVersion: 3,
            ZkAnonymousEnabled: true,
            VerifierConfigured: true,
            CircuitId: "fsus.anonymous.comment.v2",
            VerifyingKeyHash: "vk-sha256",
            IssuerPublicKeyHash: IssuerPublicKeyHash,
            CredentialRoot: Convert.FromHexString(new string('c', 64)),
            RevocationRoot: Convert.FromHexString(revocationRoot),
            CircuitMetadata: Encoding.UTF8.GetBytes("""
                {"revocationAccumulator":{"algorithm":"circuit-friendly-non-membership.v1","productionZkReady":true}}
                """));

    private static string CircuitFriendlyRoot(params string[] revokedHandleHashes)
    {
        Result<string> root = AnonymousCredentialRevocationAccumulator.TryComputeCircuitFriendlyRoot(
            Epoch,
            IssuerPublicKeyHash,
            revokedHandleHashes);
        Assert.True(root.IsSuccess, root.Error.Message);
        return root.Value!;
    }

    private Task<SqlSugarClient> CreateDbAsync()
        => PostgresSqlSugarTestClient.CreateAsync(fixture);

    private static void CreateRevocationTable(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(db, typeof(AnonymousCredentialRevocation));

    private static string[] SplitSiblingHashes(byte[] siblingHashes)
        => Enumerable.Range(0, siblingHashes.Length / 32)
            .Select(index => Convert.ToHexStringLower(siblingHashes.AsSpan(index * 32, 32)))
            .ToArray();

    private sealed class FixedRootService(AnonymousCredentialRootSnapshotCoreModel snapshot) : IAnonymousCredentialRootService
    {
        public Task<Result<AnonymousCredentialRootSnapshotCoreModel>> GetCurrentSnapshotAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(Result<AnonymousCredentialRootSnapshotCoreModel>.Success(snapshot));

        public void Invalidate()
        {
        }
    }
}
