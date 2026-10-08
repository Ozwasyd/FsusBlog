using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

internal enum DataScaleBatchCheckpointStage
{
    Prepared,
    CommitPending,
    Committed,
    RolledBack,
    Cleaned
}

internal sealed record DataScaleBatchCheckpointIdentity(
    string RunId,
    string RuntimeIdentity,
    string SourceCommit,
    string Namespace,
    string Provider,
    string DatabaseIdentity,
    string PlanDigest,
    string FactoryBatchReference,
    string GraphDigest,
    string NativeBindingsDigest,
    string PhysicalDigest,
    string KeyRosterDigest);

// A task-owned authentication key protects the journal; this is not a product seed receipt.
internal sealed record DataScaleBatchCheckpoint(
    string Schema,
    DataScaleBatchCheckpointIdentity Identity,
    DataScaleBatchCheckpointStage Stage,
    string Signature)
{
    internal const string CurrentSchema = "fsusblog.data-scale-physical-checkpoint.v1";

    internal static DataScaleBatchCheckpoint Seal(DataScaleBatchCheckpointIdentity identity,
        DataScaleBatchCheckpointStage stage, ReadOnlySpan<byte> taskKey)
    {
        ValidateKey(taskKey);
        if (!Enum.IsDefined(stage))
        {
            throw new InvalidOperationException("checkpoint_stage_invalid");
        }
        return new(CurrentSchema, identity, stage,
            Convert.ToHexString(HMACSHA256.HashData(taskKey, Payload(identity, stage))).ToLowerInvariant());
    }

    internal void Validate(DataScaleBatchCheckpointIdentity current, ReadOnlySpan<byte> taskKey,
        params DataScaleBatchCheckpointStage[] allowedStages)
    {
        ValidateKey(taskKey);
        if (Schema != CurrentSchema || Identity != current || !Enum.IsDefined(Stage)
            || !allowedStages.Contains(Stage) || Signature.Length != 64
            || Signature.AsSpan().ContainsAnyExcept("0123456789abcdef"))
        {
            throw new InvalidOperationException("checkpoint_current_binding_or_stage_mismatch");
        }
        if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(Signature),
            HMACSHA256.HashData(taskKey, Payload(Identity, Stage))))
        {
            throw new InvalidOperationException("checkpoint_authentication_failed");
        }
    }

    private static byte[] Payload(DataScaleBatchCheckpointIdentity identity, DataScaleBatchCheckpointStage stage)
        => JsonSerializer.SerializeToUtf8Bytes(new
        {
            Schema = CurrentSchema,
            Identity = identity,
            Stage = stage
        });

    private static void ValidateKey(ReadOnlySpan<byte> key)
    {
        if (key.Length is < 32 or > 4096)
        {
            throw new InvalidOperationException("checkpoint_task_key_invalid");
        }
    }
}
