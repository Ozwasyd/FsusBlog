using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Server.Services.Security;

public interface IPerceptionCharacterV3AuditSink
{
    ValueTask WriteAsync(string operation, string challengeId, string action, string outcome, string internalReason, CancellationToken cancellationToken);
}
public sealed class PerceptionCharacterV3AuditSink(ILogger<PerceptionCharacterV3AuditSink> logger) : IPerceptionCharacterV3AuditSink
{
    public ValueTask WriteAsync(string operation, string challengeId, string action, string outcome, string internalReason, CancellationToken cancellationToken)
    {
        logger.LogInformation("PerceptionCharacterV3 audit operation={Operation} challenge={ChallengeId} action={Action} outcome={Outcome} reason={Reason}", operation, challengeId, action, outcome, internalReason);
        return ValueTask.CompletedTask;
    }
}

public sealed class PerceptionCharacterV3Provider(
    IPerceptionCharacterV3KeyRing keys,
    IPerceptionCharacterV3Renderer renderer,
    IPerceptionCharacterV3StateStore stateStore,
    IPerceptionCharacterV3ResourceGate resourceGate,
    IPerceptionCharacterV3DeviceAuthority deviceAuthority,
    IPerceptionCharacterV3NonceSource nonceSource,
    IPerceptionCharacterV3AuditSink audit,
    TimeProvider timeProvider,
    PerceptionCharacterV3ProviderOptions? providerOptions = null) : ISecurityChallengeProvider
{
    private static readonly TimeSpan s_lifetime = TimeSpan.FromMinutes(2);
    private readonly TimeSpan _renderTimeout = providerOptions?.RenderTimeout ?? TimeSpan.FromSeconds(2);
    public string Kind => PerceptionCharacterV3Contracts.WireName;

    public async Task<SecurityChallengeProviderIssueResult> IssueAsync(SecurityChallengeProviderIssueRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        string envelopeId = request.EnvelopeId;
        if (string.IsNullOrWhiteSpace(envelopeId))
        {
            await audit.WriteAsync("issue", string.Empty, request.Action, "unavailable", "envelope_id_missing", cancellationToken);
            return SecurityChallengeProviderIssueResult.Failed("unavailable");
        }
        PerceptionCharacterV3DeviceAuthorityResult device = await deviceAuthority.ResolveAsync(request.Context, request.ClientIpHash, cancellationToken);
        if (!device.Succeeded)
        {
            await audit.WriteAsync("issue", string.Empty, request.Action, device.Reason.EndsWith("unavailable", StringComparison.Ordinal) ? "unavailable" : "rejected", device.Reason, cancellationToken);
            return SecurityChallengeProviderIssueResult.Failed(device.Reason.EndsWith("unavailable", StringComparison.Ordinal) ? "unavailable" : "rejected");
        }
        string trustedDeviceMaterial = device.Binding;
        string activeIdentity = ActiveIdentity(request.SubjectHash, trustedDeviceMaterial, request.ClientIpHash, request.Action, request.RouteKey);
        if (!resourceGate.TryAcquireIssue(request.ClientIpHash, trustedDeviceMaterial, request.SubjectHash, request.Action, activeIdentity, timeProvider.GetUtcNow().ToUnixTimeMilliseconds(), out string limit))
        {
            await audit.WriteAsync("issue", string.Empty, request.Action, "unavailable", "rate_limit_" + limit, cancellationToken);
            return SecurityChallengeProviderIssueResult.Failed("unavailable");
        }
        if (!keys.TryGetAnswerKey(keys.CurrentAnswerVersion, out byte[] answerKey) || !keys.TryGetTokenKey(keys.CurrentTokenVersion, out byte[] tokenKey))
        {
            await audit.WriteAsync("issue", string.Empty, request.Action, "unavailable", "key_ring_unavailable", cancellationToken);
            return SecurityChallengeProviderIssueResult.Failed("unavailable");
        }
        string deviceBinding = PerceptionCharacterV3Crypto.DeriveDeviceBinding(answerKey, trustedDeviceMaterial);
        string replacedChallengeId = request.Context.Request.Headers["X-Fsus-Replaces-Challenge"].ToString().Trim();
        if (replacedChallengeId.Length > 0)
        {
            PerceptionCharacterV3StateRecord? replaced;
            try
            {
                replaced = await stateStore.ReadAsync(replacedChallengeId, cancellationToken);
            }
            catch (PerceptionCharacterV3StoreUnavailableException)
            {
                await audit.WriteAsync("issue", replacedChallengeId, request.Action, "unavailable", "replacement_state_unavailable", CancellationToken.None);
                return SecurityChallengeProviderIssueResult.Failed("unavailable");
            }
            string requested = ResolveRepresentation(request.Context) == PerceptionCharacterV3Representation.Audio ? "audio" : "visual";
            string replacedEnvelopeId = request.Context.Request.Headers["X-Fsus-Replaces-Envelope"].ToString().Trim();
            string replacedStateToken = request.Context.Request.Headers["X-Fsus-Replaces-State-Token"].ToString().Trim();
            if (replaced is null || replaced.EnvelopeId == envelopeId || replaced.Representation == requested || replacedStateToken.Length == 0)
            {
                await audit.WriteAsync("issue", replacedChallengeId, request.Action, "rejected", "replacement_fields_invalid", cancellationToken);
                return SecurityChallengeProviderIssueResult.Failed("rejected");
            }
            string replacementTokenHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.ASCII.GetBytes(replacedStateToken)));
            PerceptionCharacterV3StateRecord replacementAuthority = replaced with
            {
                EnvelopeId = replacedEnvelopeId,
                Action = request.Action,
                RouteKey = request.RouteKey,
                SubjectHash = request.SubjectHash,
                DeviceBindingHash = deviceBinding,
                ClientIpBindingHash = request.ClientIpHash,
                TokenHash = replacementTokenHash
            };
            PerceptionCharacterV3Transition revoked;
            try
            {
                revoked = await stateStore.RevokeAsync(replacementAuthority, timeProvider.GetUtcNow().ToUnixTimeMilliseconds(), cancellationToken);
            }
            catch (PerceptionCharacterV3StoreUnavailableException)
            {
                await audit.WriteAsync("issue", replacedChallengeId, request.Action, "unavailable", "replacement_revoke_store_failure", CancellationToken.None);
                return SecurityChallengeProviderIssueResult.Failed("unavailable");
            }
            if (revoked.Kind != PerceptionCharacterV3TransitionKind.ReissueRequired || revoked.InternalReason != "revoked_now")
            {
                string publicReason = revoked.Kind == PerceptionCharacterV3TransitionKind.Unavailable ? "unavailable" : "rejected";
                string internalReason = revoked.Kind == PerceptionCharacterV3TransitionKind.Unavailable
                    ? "replacement_revoke_store_failure"
                    : revoked.InternalReason;
                await audit.WriteAsync("issue", replacedChallengeId, request.Action, publicReason, internalReason, cancellationToken);
                return SecurityChallengeProviderIssueResult.Failed(publicReason);
            }
        }
        PerceptionCharacterV3Representation representation = ResolveRepresentation(request.Context);
        await using IAsyncDisposable? lease = await resourceGate.EnterRenderAsync(cancellationToken);
        if (lease is null)
        {
            await audit.WriteAsync("issue", string.Empty, request.Action, "unavailable", "render_queue_saturated", cancellationToken);
            return SecurityChallengeProviderIssueResult.Failed("unavailable");
        }
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        string answer = PerceptionCharacterV3Crypto.SampleAnswer();
        byte[] seed = RandomNumberGenerator.GetBytes(32);
        byte[] media;
        using var renderDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        renderDeadline.CancelAfter(_renderTimeout);
        try
        {
            media = representation == PerceptionCharacterV3Representation.Visual ? renderer.RenderVisual(answer, seed, renderDeadline.Token) : renderer.RenderAudio(answer, seed, renderDeadline.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            await audit.WriteAsync("issue", challengeId, request.Action, "unavailable", "render_timeout", CancellationToken.None);
            return SecurityChallengeProviderIssueResult.Failed("unavailable");
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception) { await audit.WriteAsync("issue", challengeId, request.Action, "unavailable", "render_failed", cancellationToken); return SecurityChallengeProviderIssueResult.Failed("unavailable"); }
        finally { CryptographicOperations.ZeroMemory(seed); }
        string mediaHash = Convert.ToHexStringLower(SHA256.HashData(media));
        DateTimeOffset issuedAt = timeProvider.GetUtcNow(), expiresAt = issuedAt + s_lifetime;
        var context = new PerceptionCharacterV3BindingContext(challengeId, envelopeId, request.Action, request.RouteKey, request.SubjectHash, deviceBinding, request.ClientIpHash, request.PolicyVersion, mediaHash, issuedAt.ToUnixTimeMilliseconds(), expiresAt.ToUnixTimeMilliseconds(), keys.CurrentTokenVersion);
        byte[] answerTag = PerceptionCharacterV3Crypto.ComputeAnswerTag(answerKey, context, answer);
        var state = new PerceptionCharacterV3State(answerTag, mediaHash, challengeId, envelopeId, request.Action, request.RouteKey, request.SubjectHash, deviceBinding, request.ClientIpHash, request.PolicyVersion, 2,
            representation == PerceptionCharacterV3Representation.Visual ? "visual" : "audio", context.IssuedAtUnixMs, context.ExpiresAtUnixMs, keys.CurrentTokenVersion, keys.CurrentAnswerVersion);
        string token;
        try
        {
            token = PerceptionCharacterV3Crypto.SealState(tokenKey, context, state, nonceSource);
        }
        finally { CryptographicOperations.ZeroMemory(answerTag); }
        string tokenHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.ASCII.GetBytes(token)));
        var record = new PerceptionCharacterV3StateRecord(challengeId, envelopeId, request.Action, request.RouteKey, request.SubjectHash, deviceBinding, request.ClientIpHash, request.PolicyVersion, mediaHash, state.Representation, context.IssuedAtUnixMs, context.ExpiresAtUnixMs, keys.CurrentTokenVersion, keys.CurrentAnswerVersion, tokenHash);
        if (!await stateStore.CreateAsync(record, cancellationToken))
        {
            await audit.WriteAsync("issue", challengeId, request.Action, "unavailable", "redis_create_failed", cancellationToken);
            return SecurityChallengeProviderIssueResult.Failed("unavailable");
        }
        var assignment = new SecurityChallengeAssignment(challengeId, request.Traceparent, request.TenantId, SecurityChallengeKind.PerceptionCharacterV3, request.EscalationLevel, request.Action, request.RouteKey, request.SubjectHash, request.ClientIpHash, request.DeviceFpHash, context.IssuedAtUnixMs, context.ExpiresAtUnixMs);
        var payload = new PerceptionCharacterV3IssuePayload(PerceptionCharacterV3Contracts.Algorithm, challengeId, envelopeId, representation,
            representation == PerceptionCharacterV3Representation.Visual ? "application/x-fsus-gray8" : "audio/wav", media,
            representation == PerceptionCharacterV3Representation.Visual ? (ushort)512 : (ushort)0, representation == PerceptionCharacterV3Representation.Visual ? (ushort)192 : (ushort)0,
            representation == PerceptionCharacterV3Representation.Visual ? (ushort)320 : (ushort)0, representation == PerceptionCharacterV3Representation.Visual ? (ushort)120 : (ushort)0,
            2, request.PolicyVersion, context.IssuedAtUnixMs, context.ExpiresAtUnixMs, token);
        if (!PerceptionCharacterV3Contracts.ValidateIssue(payload).IsValid)
        {
            await audit.WriteAsync("issue", challengeId, request.Action, "unavailable", "payload_contract_invalid", cancellationToken);
            return SecurityChallengeProviderIssueResult.Failed("unavailable");
        }
        await audit.WriteAsync("issue", challengeId, request.Action, "issued", "ok", cancellationToken);
        FsusObservability.RecordSecurityChallengeIssued(Kind, request.Action, request.PolicyVersion);
        return SecurityChallengeProviderIssueResult.Success(assignment) with
        {
            PerceptionCharacterV3 = payload
        };
    }

    public async Task<SecurityChallengeProviderVerifyResult> VerifyAsync(SecurityChallengeProviderVerifyRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        PerceptionCharacterV3VerifyPayload? payload = request.PerceptionCharacterV3;
        if (!PerceptionCharacterV3Contracts.ValidateVerify(payload).IsValid || payload!.ChallengeId != request.ChallengeId || payload.EnvelopeId != request.EnvelopeId)
            return await Failed(request, "rejected", "typed_payload_invalid", cancellationToken);
        PerceptionCharacterV3StateRecord? record;
        try
        {
            record = await stateStore.ReadAsync(request.ChallengeId, cancellationToken);
        }
        catch (PerceptionCharacterV3StoreUnavailableException) { return await Failed(request, "unavailable", "redis_read_failed", cancellationToken); }
        if (record is null)
            return await Failed(request, "rejected", "state_missing", cancellationToken);
        if (!keys.TryGetTokenKey(record.TokenKeyVersion, out byte[] tokenKey) || !keys.TryGetAnswerKey(record.AnswerKeyVersion, out byte[] answerKey))
            return await Failed(request, "rejected", "key_version_unknown", cancellationToken);
        PerceptionCharacterV3DeviceAuthorityResult device = await deviceAuthority.ResolveAsync(request.Context, request.ClientIpHash, cancellationToken);
        if (!device.Succeeded)
            return await Failed(request, device.Reason.EndsWith("unavailable", StringComparison.Ordinal) ? "unavailable" : "rejected", device.Reason, cancellationToken);
        string deviceBinding = PerceptionCharacterV3Crypto.DeriveDeviceBinding(answerKey, device.Binding);
        string tokenHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.ASCII.GetBytes(payload.StateToken)));
        var expected = record with
        {
            EnvelopeId = request.EnvelopeId,
            Action = request.Action,
            RouteKey = request.RouteKey,
            SubjectHash = request.SubjectHash,
            DeviceBindingHash = deviceBinding,
            ClientIpBindingHash = request.ClientIpHash,
            Representation = payload.Representation == PerceptionCharacterV3Representation.Visual ? "visual" : "audio",
            TokenHash = tokenHash
        };
        var context = new PerceptionCharacterV3BindingContext(record.ChallengeId, record.EnvelopeId, record.Action, record.RouteKey, record.SubjectHash, record.DeviceBindingHash, record.ClientIpBindingHash, record.PolicyVersion, record.MediaHash, record.IssuedAtUnixMs, record.ExpiresAtUnixMs, record.TokenKeyVersion);
        if (!PerceptionCharacterV3Crypto.TryOpenState(tokenKey, payload.StateToken, context, out PerceptionCharacterV3State? state) || state is null || !StateMatchesRecord(state, record))
            return await Failed(request, "rejected", "token_open_failed", cancellationToken);
        string? normalized = PerceptionCharacterV3Crypto.NormalizeAnswer(payload.Answer);
        byte[] candidate = normalized is null ? new byte[32] : PerceptionCharacterV3Crypto.ComputeAnswerTag(answerKey, context, normalized);
        bool correct = PerceptionCharacterV3Crypto.FixedTimeTagEquals(state.AnswerTag, candidate) && normalized is not null;
        CryptographicOperations.ZeroMemory(candidate);
        CryptographicOperations.ZeroMemory(state.AnswerTag);
        PerceptionCharacterV3Transition transition = await stateStore.VerifyAsync(expected, correct, timeProvider.GetUtcNow().ToUnixTimeMilliseconds(), cancellationToken);
        string publicReason = transition.Kind switch
        {
            PerceptionCharacterV3TransitionKind.Success => "ok",
            PerceptionCharacterV3TransitionKind.Retryable => "retryable",
            PerceptionCharacterV3TransitionKind.ReissueRequired => "reissueRequired",
            PerceptionCharacterV3TransitionKind.Unavailable => "unavailable",
            _ => "rejected"
        };
        await audit.WriteAsync("verify", request.ChallengeId, request.Action, publicReason, transition.InternalReason, cancellationToken);
        if (transition.Kind == PerceptionCharacterV3TransitionKind.Success)
        {
            FsusObservability.RecordSecurityChallengeVerified(Kind, request.Action, record.PolicyVersion);
            return SecurityChallengeProviderVerifyResult.Success(DateTimeOffset.FromUnixTimeMilliseconds(record.ExpiresAtUnixMs));
        }
        FsusObservability.RecordSecurityChallengeFailed(Kind, request.Action, transition.InternalReason, record.PolicyVersion);
        return SecurityChallengeProviderVerifyResult.Failed(publicReason);
    }

    private async Task<SecurityChallengeProviderVerifyResult> Failed(SecurityChallengeProviderVerifyRequest request, string publicReason, string internalReason, CancellationToken ct)
    {
        await audit.WriteAsync("verify", request.ChallengeId, request.Action, publicReason, internalReason, ct);
        return SecurityChallengeProviderVerifyResult.Failed(publicReason);
    }
    private static string ActiveIdentity(string subjectHash, string trustedDeviceMaterial, string clientIpHash, string action, string routeKey)
        => subjectHash + ":" + trustedDeviceMaterial + ":" + clientIpHash + ":" + action + ":" + routeKey;
    private static PerceptionCharacterV3Representation ResolveRepresentation(HttpContext context) => string.Equals(context.Request.Headers["X-Fsus-Challenge-Representation"].ToString(), "audio", StringComparison.Ordinal) ? PerceptionCharacterV3Representation.Audio : PerceptionCharacterV3Representation.Visual;
    private static bool StateMatchesRecord(PerceptionCharacterV3State state, PerceptionCharacterV3StateRecord record)
        => state.AttemptBudget == 2 && state.MediaHash == record.MediaHash && state.ChallengeId == record.ChallengeId && state.EnvelopeId == record.EnvelopeId
            && state.Action == record.Action && state.RouteKey == record.RouteKey && state.SubjectHash == record.SubjectHash && state.DeviceBindingHash == record.DeviceBindingHash
            && state.ClientIpBindingHash == record.ClientIpBindingHash && state.PolicyVersion == record.PolicyVersion && state.Representation == record.Representation
            && state.IssuedAtUnixMs == record.IssuedAtUnixMs && state.ExpiresAtUnixMs == record.ExpiresAtUnixMs && state.TokenKeyVersion == record.TokenKeyVersion
            && state.AnswerKeyVersion == record.AnswerKeyVersion;
}

public sealed record PerceptionCharacterV3ProviderOptions(TimeSpan RenderTimeout);
