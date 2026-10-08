using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DataScaleBatchCheckpointTests
{
    private static readonly byte[] s_key = SHA256.HashData("task-only-journal-key"u8);

    [Theory]
    [InlineData("run")]
    [InlineData("runtime")]
    [InlineData("source")]
    [InlineData("namespace")]
    [InlineData("provider")]
    [InlineData("database")]
    [InlineData("plan")]
    [InlineData("graph")]
    [InlineData("native")]
    [InlineData("physical")]
    [InlineData("keys")]
    [InlineData("reference")]
    public void Checkpoint_RejectsEveryChangedCurrentBinding(string field)
    {
        DataScaleBatchCheckpointIdentity identity = Identity();
        DataScaleBatchCheckpoint checkpoint = DataScaleBatchCheckpoint.Seal(identity, DataScaleBatchCheckpointStage.Committed, s_key);
        DataScaleBatchCheckpointIdentity changed = field switch
        {
            "run" => identity with { RunId = "another-run" },
            "runtime" => identity with { RuntimeIdentity = "another-runtime" },
            "source" => identity with { SourceCommit = new string('b', 40) },
            "namespace" => identity with { Namespace = "another-namespace" },
            "provider" => identity with { Provider = "MySql" },
            "database" => identity with { DatabaseIdentity = Digest('b') },
            "plan" => identity with { PlanDigest = Digest('b') },
            "graph" => identity with { GraphDigest = Digest('b') },
            "native" => identity with { NativeBindingsDigest = Digest('b') },
            "physical" => identity with { PhysicalDigest = Digest('b') },
            "keys" => identity with { KeyRosterDigest = Digest('b') },
            _ => identity with { FactoryBatchReference = "another-batch" }
        };
        Assert.Throws<InvalidOperationException>(() => checkpoint.Validate(changed, s_key, DataScaleBatchCheckpointStage.Committed));
    }

    [Fact]
    public void Checkpoint_RejectsStageEscalationAndWrongTaskKey()
    {
        DataScaleBatchCheckpointIdentity identity = Identity();
        DataScaleBatchCheckpoint prepared = DataScaleBatchCheckpoint.Seal(identity, DataScaleBatchCheckpointStage.Prepared, s_key);
        Assert.Throws<InvalidOperationException>(() => prepared.Validate(identity, s_key, DataScaleBatchCheckpointStage.Committed));
        DataScaleBatchCheckpoint relabelled = prepared with
        {
            Stage = DataScaleBatchCheckpointStage.Committed
        };
        Assert.Throws<InvalidOperationException>(() => relabelled.Validate(identity, s_key, DataScaleBatchCheckpointStage.Committed));
        Assert.Throws<InvalidOperationException>(() => prepared.Validate(identity, RandomNumberGenerator.GetBytes(32), DataScaleBatchCheckpointStage.Prepared));
    }

    [Fact]
    public async Task ExactAddressJournal_RepeatsWithoutOverwriteAndRejectsByteTamper()
    {
        string root = Path.Combine(Path.GetTempPath(), "data-scale-journal-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new DataScaleBatchCheckpointStore(root);
            DataScaleBatchCheckpointIdentity identity = Identity();
            DataScaleBatchCheckpoint checkpoint = DataScaleBatchCheckpoint.Seal(identity, DataScaleBatchCheckpointStage.Committed, s_key);
            await store.PersistAsync(checkpoint, CancellationToken.None);
            await store.PersistAsync(checkpoint, CancellationToken.None);
            Assert.Single(Directory.GetFiles(root));
            Assert.Equal(checkpoint, await store.ReadAsync(checkpoint.Signature, identity, s_key, CancellationToken.None));
            string file = Directory.GetFiles(root).Single();
            await File.WriteAllBytesAsync(file, JsonSerializer.SerializeToUtf8Bytes(checkpoint with
            {
                Stage = DataScaleBatchCheckpointStage.Cleaned
            }));
            await Assert.ThrowsAsync<InvalidOperationException>(() => store.ReadAsync(checkpoint.Signature, identity, s_key, CancellationToken.None));
            await Assert.ThrowsAsync<InvalidOperationException>(() => store.PersistAsync(checkpoint, CancellationToken.None));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    internal static DataScaleBatchCheckpointIdentity Identity()
        => new("run", "runtime", new string('a', 40), "namespace", "Sqlite", Digest('d'), Digest('1'),
            "exact-batch-ref", Digest('2'), Digest('3'), Digest('4'), Digest('5'));

    private static string Digest(char value) => "sha256:" + new string(value, 64);
}
