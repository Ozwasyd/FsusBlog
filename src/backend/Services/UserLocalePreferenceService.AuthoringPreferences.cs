using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.AuthoringPreferences;
using FsusBlog.Shared.Contracts.AuthorTypography;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed partial class UserLocalePreferenceService
{
    // Until an explicit expiry contract exists, keep every admitted identity and refuse overflow.
    private const int MaximumRetainedAuthoringOperations = 256;
    private static readonly JsonSerializerOptions s_authorTypographyPersistenceOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    // Domain partials share this row, revision and transaction. The helper never supplies typography defaults.
    private sealed record AuthoringPreferenceState(
        long Revision,
        WritingAidPreferenceValues WritingAids,
        string? TypographyPayload,
        string ContentDigest);

    private sealed record AuthoringPreferenceCasWrite<T>(AuthoringPreferenceState Next, string Receipt, T Result);
    private sealed record AuthoringPreferenceCasResult<T>(WritingAidPreferenceOutcome Outcome, T? Value = default);

    // Persistence-only device binding; the public typography record and its domain digest stay unchanged.
    private sealed record AuthorTypographyDeviceReceipt(
        string DeviceScope,
        AuthorTypographyRecordedRequest Record,
        string ContentDigest);

    private async Task<(long Revision, AuthorTypographyProfile? StoredProfile)> ReadAuthorTypographyStateCoreAsync(
        AuthorTypographyScope authenticatedScope,
        CancellationToken cancellationToken)
    {
        WritingAidPreferenceOwner owner = TypographyOwner(authenticatedScope)
            ?? throw new UnauthorizedAccessException("Invalid authenticated author preference scope.");
        cancellationToken.ThrowIfCancellationRequested();
        AuthoringPreferenceState state = await ReadAuthoringPreferenceStateAsync(owner, false, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("Invalid stored author preference state.");
        AuthorTypographyProfile? profile = state.TypographyPayload is null ? null
            : JsonSerializer.Deserialize<AuthorTypographyProfile>(state.TypographyPayload, s_authorTypographyPersistenceOptions)
                ?? throw new InvalidDataException("Invalid stored author typography payload.");
        return (state.Revision, profile);
    }

    private async Task<AuthorTypographyRecordedRequest?> ReadAuthorTypographyRequestCoreAsync(
        AuthorTypographyScope authenticatedScope,
        Guid requestId,
        CancellationToken cancellationToken)
    {
        WritingAidPreferenceOwner owner = TypographyOwner(authenticatedScope)
            ?? throw new UnauthorizedAccessException("Invalid authenticated author preference scope.");
        if (requestId == Guid.Empty)
        {
            throw new ArgumentException("Request identity must be nonempty.", nameof(requestId));
        }
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT device_scope, request_digest, receipt
            FROM user_authoring_preference_operation
            WHERE user_scope = @UserScope AND site_scope = @SiteScope
                AND operation_id = @OperationId AND domain = 'typography'
            LIMIT 1;
            """,
            new SugarParameter("@UserScope", owner.UserScope), new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@OperationId", requestId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        string deviceScope = reader.GetString(0);
        AuthorTypographyRecordedRequest? record = ReadTypographyDeviceReceipt(
            authenticatedScope, deviceScope, reader.GetString(2));
        if (record is null
            || record!.Request.RequestId != requestId
            || reader.GetString(1) != ComputeTypographyDeviceRequestDigest(authenticatedScope, deviceScope, record.Request))
        {
            throw new InvalidDataException("Invalid stored author typography request.");
        }
        return record;
    }

    // The domain caller must supply a server-verified device digest. No identity-derived stand-in is generated.
    private async Task<AuthorTypographyPreferenceWriteResult> CommitAuthorTypographyCoreAsync(
        AuthorTypographyScope authenticatedScope,
        string deviceScope,
        AuthorTypographyMutationRequest request,
        AuthorTypographyPreparedMutation mutation,
        CancellationToken cancellationToken)
    {
        WritingAidPreferenceOwner? owner = TypographyOwner(authenticatedScope);
        if (owner is null)
        {
            return new(AuthorTypographyPreferenceWriteOutcome.Forbidden, null, null);
        }
        if (!AuthorTypographyContractValidator.ValidateMutationRequest(authenticatedScope, request)
            || !WritingAidPreferenceReceiptValidator.IsDeviceScope(deviceScope)
            || mutation is null || mutation.Scope != authenticatedScope
            || mutation.ExpectedRevision != request.Command.ExpectedRevision
            || !AuthorTypographyContractValidator.ValidateProfile(mutation.Profile)
            || (request.Command.Mutation == AuthorTypographyMutation.SetProfile && request.Command.Profile != mutation.Profile))
        {
            return new(AuthorTypographyPreferenceWriteOutcome.InvalidRequest, null, null);
        }
        AuthoringPreferenceCasResult<AuthorTypographyRecordedRequest> result = await ExecuteAuthoringPreferenceCasAsync(
            owner, deviceScope, request.RequestId, "typography",
            ComputeTypographyDeviceRequestDigest(authenticatedScope, deviceScope, request), request.Command.ExpectedRevision,
            (current, revision) =>
            {
                AuthoringPreferenceState next = SealAuthoringPreferenceState(owner, current with
                {
                    Revision = revision,
                    TypographyPayload = JsonSerializer.Serialize(mutation.Profile, s_authorTypographyPersistenceOptions)
                });
                var unsignedSnapshot = new AuthorTypographySnapshot(authenticatedScope, revision, mutation.Profile, string.Empty);
                AuthorTypographySnapshot snapshot = unsignedSnapshot with
                {
                    ContentDigest = AuthorTypographyContractValidator.ComputeSnapshotDigest(unsignedSnapshot)
                };
                var unsignedRecord = new AuthorTypographyRecordedRequest(request, snapshot, string.Empty);
                AuthorTypographyRecordedRequest record = unsignedRecord with
                {
                    ContentDigest = AuthorTypographyContractValidator.ComputeRecordedRequestDigest(unsignedRecord, authenticatedScope)
                };
                var receipt = new AuthorTypographyDeviceReceipt(deviceScope, record,
                    ComputeTypographyDeviceReceiptDigest(deviceScope, record));
                return new AuthoringPreferenceCasWrite<AuthorTypographyRecordedRequest>(next,
                    JsonSerializer.Serialize(receipt, s_authorTypographyPersistenceOptions), record);
            },
            json =>
            {
                AuthorTypographyRecordedRequest? record = ReadTypographyDeviceReceipt(authenticatedScope, deviceScope, json);
                return AuthorTypographyRequestReplayPolicy.Evaluate(authenticatedScope, request, record).Status
                    == AuthorTypographyRequestReplayStatus.Replayable ? record : null;
            }, cancellationToken).ConfigureAwait(false);
        AuthorTypographyPreferenceWriteOutcome outcome = result.Outcome switch
        {
            WritingAidPreferenceOutcome.Success => AuthorTypographyPreferenceWriteOutcome.Committed,
            WritingAidPreferenceOutcome.Replayed => AuthorTypographyPreferenceWriteOutcome.Replayed,
            WritingAidPreferenceOutcome.RevisionConflict => AuthorTypographyPreferenceWriteOutcome.RevisionConflict,
            WritingAidPreferenceOutcome.IdempotencyConflict => AuthorTypographyPreferenceWriteOutcome.RequestIdentityConflict,
            WritingAidPreferenceOutcome.Invalid => AuthorTypographyPreferenceWriteOutcome.InvalidRequest,
            _ => AuthorTypographyPreferenceWriteOutcome.Unavailable
        };
        return new(outcome, result.Value, result.Value?.CommittedSnapshot);
    }

    private static string ComputeTypographyDeviceRequestDigest(
        AuthorTypographyScope scope,
        string deviceScope,
        AuthorTypographyMutationRequest request)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new[]
        {
            "fsusblog.author-typography-device-request.v1",
            deviceScope,
            AuthorTypographyContractValidator.ComputeRequestDigest(scope, request)
        });
        return Convert.ToHexStringLower(SHA256.HashData(bytes));
    }

    private static string ComputeTypographyDeviceReceiptDigest(
        string deviceScope,
        AuthorTypographyRecordedRequest record)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new[]
        {
            "fsusblog.author-typography-device-receipt.v1",
            deviceScope,
            record.ContentDigest
        });
        return Convert.ToHexStringLower(SHA256.HashData(bytes));
    }

    private static AuthorTypographyRecordedRequest? ReadTypographyDeviceReceipt(
        AuthorTypographyScope scope,
        string deviceScope,
        string json)
    {
        AuthorTypographyDeviceReceipt? receipt = JsonSerializer.Deserialize<AuthorTypographyDeviceReceipt>(
            json, s_authorTypographyPersistenceOptions);
        return receipt is not null
            && WritingAidPreferenceReceiptValidator.IsDeviceScope(deviceScope)
            && receipt.DeviceScope == deviceScope
            && AuthorTypographyContractValidator.ValidateRecordedRequest(receipt.Record, scope)
            && receipt.ContentDigest == ComputeTypographyDeviceReceiptDigest(deviceScope, receipt.Record)
                ? receipt.Record : null;
    }

    private static WritingAidPreferenceOwner? TypographyOwner(AuthorTypographyScope? scope)
    {
        if (scope is null)
        {
            return null;
        }
        var owner = new WritingAidPreferenceOwner("account:" + scope.AccountId.ToString(CultureInfo.InvariantCulture), scope.SiteIdentity);
        return WritingAidPreferenceValidator.IsValidOwner(owner) ? owner : null;
    }

    private async Task<AuthoringPreferenceCasResult<T>> ExecuteAuthoringPreferenceCasAsync<T>(
        WritingAidPreferenceOwner owner,
        string deviceScope,
        Guid operationId,
        string domain,
        string requestDigest,
        long expectedRevision,
        Func<AuthoringPreferenceState, long, AuthoringPreferenceCasWrite<T>?> prepare,
        Func<string, T?> validateReplay,
        CancellationToken cancellationToken)
        where T : class
    {
        if (!WritingAidPreferenceValidator.IsValidOwner(owner)
            || !WritingAidPreferenceReceiptValidator.IsDeviceScope(deviceScope)
            || operationId == Guid.Empty || domain is not ("writing-aids" or "typography")
            || requestDigest.Length != 64 || requestDigest.AsSpan().IndexOfAnyExcept("0123456789abcdef") >= 0
            || expectedRevision < 0 || expectedRevision >= WritingAidPreferenceContract.MaximumExactRevision)
        {
            return new(WritingAidPreferenceOutcome.Invalid);
        }
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            var result = new AuthoringPreferenceCasResult<T>(WritingAidPreferenceOutcome.RevisionConflict);
            var transaction = await db.Ado.UseTranAsync(async () =>
            {
                AuthoringPreferenceCasResult<T>? replay = await ReadAuthoringPreferenceOperationAsync(
                    owner, deviceScope, operationId, domain, requestDigest, validateReplay, cancellationToken).ConfigureAwait(false);
                if (replay is not null)
                {
                    result = replay;
                    return;
                }
                AuthoringPreferenceState? current = await ReadAuthoringPreferenceStateAsync(owner, true, cancellationToken).ConfigureAwait(false);
                if (current is null)
                {
                    result = new(WritingAidPreferenceOutcome.Corrupt);
                    return;
                }
                if (current.Revision != expectedRevision)
                {
                    result = await ReadAuthoringPreferenceOperationAsync(
                        owner, deviceScope, operationId, domain, requestDigest, validateReplay, cancellationToken).ConfigureAwait(false)
                        ?? new(WritingAidPreferenceOutcome.RevisionConflict);
                    return;
                }
                if (await AuthoringPreferenceJournalIsFullAsync(owner, cancellationToken).ConfigureAwait(false))
                {
                    result = new(WritingAidPreferenceOutcome.Unavailable);
                    return;
                }
                AuthoringPreferenceCasWrite<T>? write = prepare(current, checked(current.Revision + 1));
                if (write is null || write.Next.Revision != current.Revision + 1
                    || !ValidateAuthoringPreferenceState(owner, write.Next)
                    || write.Receipt.Length is < 1 or > 4096
                    || (domain == "writing-aids" && write.Next.TypographyPayload != current.TypographyPayload)
                    || (domain == "typography" && write.Next.WritingAids != current.WritingAids))
                {
                    result = new(WritingAidPreferenceOutcome.Invalid);
                    return;
                }
                SugarParameter[] parameters =
                [
                    new("@UserScope", owner.UserScope), new("@SiteScope", owner.SiteScope),
                    new("@SchemaVersion", write.Next.WritingAids.SchemaVersion),
                    new("@Focus", write.Next.WritingAids.FocusEnabled),
                    new("@Typewriter", write.Next.WritingAids.TypewriterEnabled),
                    new("@Immersive", write.Next.WritingAids.ImmersiveEnabled),
                    new("@Typography", write.Next.TypographyPayload),
                    new("@ExpectedRevision", expectedRevision), new("@Revision", write.Next.Revision),
                    new("@ContentDigest", write.Next.ContentDigest),
                    new("@UpdatedAt", _timeProvider.GetUtcNow().UtcDateTime)
                ];
                int affected = current.Revision == 0
                    ? await db.Ado.ExecuteCommandAsync(
                        """
                        INSERT INTO user_authoring_preference (
                            user_scope, site_scope, schema_version, focus_enabled, typewriter_enabled,
                            immersive_enabled, typography_payload, revision, content_digest, updated_at)
                        VALUES (@UserScope, @SiteScope, @SchemaVersion, @Focus, @Typewriter,
                            @Immersive, @Typography, @Revision, @ContentDigest, @UpdatedAt)
                        ON CONFLICT (user_scope, site_scope) DO NOTHING;
                        """, parameters).ConfigureAwait(false)
                    : await db.Ado.ExecuteCommandAsync(
                        """
                        UPDATE user_authoring_preference
                        SET schema_version = @SchemaVersion, focus_enabled = @Focus,
                            typewriter_enabled = @Typewriter, immersive_enabled = @Immersive,
                            typography_payload = @Typography, revision = @Revision,
                            content_digest = @ContentDigest, updated_at = @UpdatedAt
                        WHERE user_scope = @UserScope AND site_scope = @SiteScope AND revision = @ExpectedRevision;
                        """, parameters).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                if (affected != 1)
                {
                    result = await ReadAuthoringPreferenceOperationAsync(
                        owner, deviceScope, operationId, domain, requestDigest, validateReplay, cancellationToken).ConfigureAwait(false)
                        ?? new(WritingAidPreferenceOutcome.RevisionConflict);
                    return;
                }
                await db.Ado.ExecuteCommandAsync(
                    """
                    INSERT INTO user_authoring_preference_operation (
                        user_scope, site_scope, operation_id, device_scope, domain, request_digest, receipt, committed_at)
                    VALUES (@UserScope, @SiteScope, @OperationId, @DeviceScope, @Domain, @RequestDigest, @Receipt, @CommittedAt);
                    """,
                    new SugarParameter("@UserScope", owner.UserScope), new SugarParameter("@SiteScope", owner.SiteScope),
                    new SugarParameter("@OperationId", operationId), new SugarParameter("@DeviceScope", deviceScope),
                    new SugarParameter("@Domain", domain), new SugarParameter("@RequestDigest", requestDigest),
                    new SugarParameter("@Receipt", write.Receipt),
                    new SugarParameter("@CommittedAt", _timeProvider.GetUtcNow().UtcDateTime)).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                result = new(WritingAidPreferenceOutcome.Success, write.Result);
            }).ConfigureAwait(false);
            if (!transaction.IsSuccess)
            {
                cancellationToken.ThrowIfCancellationRequested();
                logger.LogWarning("Authoring preference transaction failed | reason=transaction_error");
                return new(WritingAidPreferenceOutcome.Unavailable);
            }
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Authoring preference unavailable | reason=persistence_error");
            return new(WritingAidPreferenceOutcome.Unavailable);
        }
    }

    private async Task<AuthoringPreferenceState?> ReadAuthoringPreferenceStateAsync(
        WritingAidPreferenceOwner owner, bool forUpdate, CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT schema_version, focus_enabled, typewriter_enabled, immersive_enabled,
                typography_payload, revision, content_digest
            FROM user_authoring_preference
            WHERE user_scope = @UserScope AND site_scope = @SiteScope
            LIMIT 1
            """ + (forUpdate ? " FOR UPDATE;" : ";"),
            new SugarParameter("@UserScope", owner.UserScope), new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return SealAuthoringPreferenceState(owner, new(0, WritingAidPreferenceContract.Defaults, null, string.Empty));
        }
        var state = new AuthoringPreferenceState(reader.GetInt64(5),
            new(reader.GetInt32(0), reader.GetBoolean(1), reader.GetBoolean(2), reader.GetBoolean(3)),
            reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetString(6));
        return state.Revision > 0 && ValidateAuthoringPreferenceState(owner, state) ? state : null;
    }

    private async Task<bool> AuthoringPreferenceJournalIsFullAsync(
        WritingAidPreferenceOwner owner,
        CancellationToken cancellationToken)
    {
        // Existing rows are locked by the common transaction before this bounded indexed scan.
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT count(*) FROM (
                SELECT 1 FROM user_authoring_preference_operation
                WHERE user_scope = @UserScope AND site_scope = @SiteScope
                LIMIT @MaximumOperations
            ) AS retained_operations;
            """,
            new SugarParameter("@UserScope", owner.UserScope), new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@MaximumOperations", MaximumRetainedAuthoringOperations)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            && reader.GetInt64(0) >= MaximumRetainedAuthoringOperations;
    }

    private async Task<AuthoringPreferenceCasResult<T>?> ReadAuthoringPreferenceOperationAsync<T>(
        WritingAidPreferenceOwner owner, string deviceScope, Guid operationId, string domain,
        string requestDigest, Func<string, T?> validateReplay, CancellationToken cancellationToken)
        where T : class
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT device_scope, domain, request_digest, receipt
            FROM user_authoring_preference_operation
            WHERE user_scope = @UserScope AND site_scope = @SiteScope AND operation_id = @OperationId
            LIMIT 1;
            """,
            new SugarParameter("@UserScope", owner.UserScope), new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@OperationId", operationId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        if (reader.GetString(0) != deviceScope || reader.GetString(1) != domain || reader.GetString(2) != requestDigest)
        {
            return new(WritingAidPreferenceOutcome.IdempotencyConflict);
        }
        T? value;
        try
        {
            value = validateReplay(reader.GetString(3));
        }
        catch (JsonException)
        {
            value = null;
        }
        return value is null ? new(WritingAidPreferenceOutcome.Corrupt) : new(WritingAidPreferenceOutcome.Replayed, value);
    }

    private static AuthoringPreferenceState SealAuthoringPreferenceState(WritingAidPreferenceOwner owner, AuthoringPreferenceState state)
    {
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartArray();
            writer.WriteStringValue("fsusblog.authoring-preference-row.v1");
            writer.WriteStringValue(owner.UserScope);
            writer.WriteStringValue(owner.SiteScope);
            writer.WriteNumberValue(state.Revision);
            writer.WriteNumberValue(state.WritingAids.SchemaVersion);
            writer.WriteBooleanValue(state.WritingAids.FocusEnabled);
            writer.WriteBooleanValue(state.WritingAids.TypewriterEnabled);
            writer.WriteBooleanValue(state.WritingAids.ImmersiveEnabled);
            writer.WriteStringValue(state.TypographyPayload);
            writer.WriteEndArray();
        }
        return state with
        {
            ContentDigest = Convert.ToHexStringLower(SHA256.HashData(output.ToArray()))
        };
    }

    private static bool ValidateAuthoringPreferenceState(WritingAidPreferenceOwner owner, AuthoringPreferenceState state)
        => state.Revision is >= 0 and <= WritingAidPreferenceContract.MaximumExactRevision
            && state.WritingAids.SchemaVersion == WritingAidPreferenceContract.SchemaVersion
            && (state.TypographyPayload is null || state.TypographyPayload.Length is > 0 and <= 2048)
            && state.ContentDigest == SealAuthoringPreferenceState(owner, state).ContentDigest;
}
