using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.AuthoringPreferences;

namespace FsusBlog.Server.Services;

/// <summary>Domain validation and projection on the sole account preference service and common CAS.</summary>
public sealed partial class UserLocalePreferenceService : IWritingAidPreferenceReader, IWritingAidPreferenceCommand, IWritingAidPreferenceInitializationCommand
{
    private static readonly JsonSerializerOptions s_writingAidJournalOptions = new()
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public async Task<WritingAidPreferenceResult> GetWritingAidPreferenceAsync(
        WritingAidPreferenceOwner owner,
        CancellationToken cancellationToken = default)
    {
        if (!WritingAidPreferenceValidator.IsValidOwner(owner))
        {
            return new(WritingAidPreferenceOutcome.Invalid);
        }
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            AuthoringPreferenceState? state = await ReadAuthoringPreferenceStateAsync(owner, false, cancellationToken).ConfigureAwait(false);
            return state is null ? new(WritingAidPreferenceOutcome.Corrupt)
                : new(WritingAidPreferenceOutcome.Success, WritingAidSnapshot(owner, state));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Writing aid preference unavailable | reason=persistence_error");
            return new(WritingAidPreferenceOutcome.Unavailable);
        }
    }

    public Task<WritingAidPreferenceResult> InitializeWritingAidPreferenceAsync(
        WritingAidPreferenceOwner owner,
        string deviceScope,
        Guid operationId,
        CancellationToken cancellationToken = default)
        => CommitWritingAidPreferenceCoreAsync(owner, deviceScope,
            new(0, operationId, WritingAidPreferenceContract.Defaults), "initialize", cancellationToken);

    public Task<WritingAidPreferenceResult> UpdateWritingAidPreferenceAsync(
        WritingAidPreferenceOwner owner,
        string deviceScope,
        WritingAidPreferenceUpdate update,
        CancellationToken cancellationToken = default)
        => CommitWritingAidPreferenceCoreAsync(owner, deviceScope, update, "update", cancellationToken);

    private async Task<WritingAidPreferenceResult> CommitWritingAidPreferenceCoreAsync(
        WritingAidPreferenceOwner owner,
        string deviceScope,
        WritingAidPreferenceUpdate update,
        string action,
        CancellationToken cancellationToken)
    {
        if (!WritingAidPreferenceValidator.IsValidOwner(owner)
            || !WritingAidPreferenceReceiptValidator.IsDeviceScope(deviceScope)
            || WritingAidPreferenceValidator.ValidateUpdate(update) != WritingAidPreferenceValidation.Valid)
        {
            return new(WritingAidPreferenceOutcome.Invalid);
        }
        AuthoringPreferenceCasResult<WritingAidPreferenceReceipt> result = await ExecuteAuthoringPreferenceCasAsync(
            owner, deviceScope, update.OperationId, "writing-aids", WritingAidRequestDigest(owner, deviceScope, update, action),
            update.ExpectedRevision,
            (current, revision) =>
            {
                AuthoringPreferenceState next = SealAuthoringPreferenceState(owner,
                    current with
                    {
                        Revision = revision,
                        WritingAids = update.Values
                    });
                var unsignedReceipt = new WritingAidPreferenceReceipt(update.OperationId, deviceScope,
                    WritingAidSnapshot(owner, current), WritingAidSnapshot(owner, next), action, "committed", string.Empty);
                WritingAidPreferenceReceipt receipt = unsignedReceipt with
                {
                    ContentDigest = WritingAidPreferenceReceiptValidator.ComputeDigest(unsignedReceipt)
                };
                return new AuthoringPreferenceCasWrite<WritingAidPreferenceReceipt>(next,
                    JsonSerializer.Serialize(receipt, s_writingAidJournalOptions), receipt);
            },
            json =>
            {
                WritingAidPreferenceReceipt? receipt = JsonSerializer.Deserialize<WritingAidPreferenceReceipt>(json, s_writingAidJournalOptions);
                return WritingAidPreferenceReceiptValidator.Validate(receipt, owner)
                    && receipt!.OperationId == update.OperationId && receipt.DeviceScope == deviceScope
                    && receipt.Action == action && receipt.Previous.Revision == update.ExpectedRevision
                    && receipt.Committed.Values == update.Values ? receipt : null;
            }, cancellationToken).ConfigureAwait(false);
        return new(result.Outcome, result.Value?.Committed, result.Value);
    }

    private static WritingAidPreferenceSnapshot WritingAidSnapshot(WritingAidPreferenceOwner owner, AuthoringPreferenceState state)
        => new(owner, state.Revision, state.WritingAids,
            WritingAidPreferenceValidator.ComputeDigest(owner, state.Revision, state.WritingAids));

    private static string WritingAidRequestDigest(WritingAidPreferenceOwner owner, string deviceScope, WritingAidPreferenceUpdate update, string action)
    {
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartArray();
            writer.WriteStringValue(action == "initialize" ? "fsusblog.writing-aid-initialize.v1" : "fsusblog.writing-aid-update.v1");
            writer.WriteStringValue(deviceScope);
            writer.WriteStringValue(update.OperationId);
            writer.WriteStringValue(WritingAidPreferenceValidator.ComputeDigest(owner, update.ExpectedRevision, update.Values));
            writer.WriteEndArray();
        }
        return Convert.ToHexStringLower(SHA256.HashData(output.ToArray()));
    }
}
