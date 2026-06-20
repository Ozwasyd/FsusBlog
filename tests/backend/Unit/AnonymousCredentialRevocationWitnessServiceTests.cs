using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Security;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCredentialRevocationWitnessServiceTests
{
    private const long Epoch = 4096;
    private static readonly string IssuerPublicKeyHash = new('f', 64);
    private static readonly string RevokedHandleHash = new('a', 64);
    private static readonly string CandidateHandleHash = new('b', 64);

    [Fact]
    public async Task CreateWitnessAsync_CircuitFriendlyRoot_ReturnsVerifiableNonMembershipWitness()
    {
        string dbPath = Path.Combine(Path.GetTempPath(), $"fsus-revocation-witness-{Guid.NewGuid():N}.db");
        try
        {
            string revocationRoot = CircuitFriendlyRoot(RevokedHandleHash);
            using SqlSugarClient db = CreateDb(dbPath);
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
                PublicInputLayoutVersion: 2,
                CircuitId: "fsus.anonymous.comment.v1",
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
            Assert.True(AnonymousCredentialRevocationAccumulator.VerifyCircuitFriendlyNonMembershipWitness(
                witness,
                [RevokedHandleHash]));
        }
        finally
        {
            TryDelete(dbPath);
        }
    }

    private static AnonymousCredentialRootSnapshotCoreModel CreateSnapshot(string revocationRoot)
        => new(
            CredentialEpoch: Epoch,
            RootExpiresAtUnixMs: DateTimeOffset.UtcNow.AddMinutes(30).ToUnixTimeMilliseconds(),
            RootGraceExpiresAtUnixMs: DateTimeOffset.UtcNow.AddMinutes(60).ToUnixTimeMilliseconds(),
            CircuitNumericId: 7,
            PublicInputLayoutVersion: 2,
            ZkAnonymousEnabled: true,
            VerifierConfigured: true,
            CircuitId: "fsus.anonymous.comment.v1",
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

    private static SqlSugarClient CreateDb(string dbPath)
        => new(new ConnectionConfig
        {
            DbType = DbType.Sqlite,
            ConnectionString = $"Data Source={dbPath}",
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true
        });

    private static void CreateRevocationTable(SqlSugarClient db)
        => db.Ado.ExecuteCommand("""
            CREATE TABLE IF NOT EXISTS anonymous_credential_revocation (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                epoch INTEGER NOT NULL,
                root_hash TEXT NOT NULL,
                revocation_handle_hash TEXT NOT NULL,
                revocation_root_hash TEXT NOT NULL,
                reason TEXT NULL,
                actor_id TEXT NULL,
                revoked_at_utc TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_revocation_epoch_handle
                ON anonymous_credential_revocation(epoch, revocation_handle_hash);
            """);

    private static string[] SplitSiblingHashes(byte[] siblingHashes)
        => Enumerable.Range(0, siblingHashes.Length / 32)
            .Select(index => Convert.ToHexStringLower(siblingHashes.AsSpan(index * 32, 32)))
            .ToArray();

    private static void TryDelete(string dbPath)
    {
        try
        {
            if (File.Exists(dbPath))
            {
                File.Delete(dbPath);
            }
        }
        catch (IOException)
        {
        }
    }

    private sealed class FixedRootService(AnonymousCredentialRootSnapshotCoreModel snapshot) : IAnonymousCredentialRootService
    {
        public Task<Result<AnonymousCredentialRootSnapshotCoreModel>> GetCurrentSnapshotAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(Result<AnonymousCredentialRootSnapshotCoreModel>.Success(snapshot));

        public void Invalidate()
        {
        }
    }
}
