using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.AuthoringPreferences;
using FsusBlog.Shared.Contracts.AuthorTypography;

using SqlSugar;

namespace FsusBlog.Server.Services;

/// <summary>Typography domain decisions on the existing scoped service and the owner's shared CAS/journal.</summary>
public sealed partial class UserLocalePreferenceService : IAuthorTypographyPreferenceReader, IAuthorTypographyPreferenceCommand
{
    private readonly IAuthorTypographyCurrentDesignDefaultPolicy? _authorTypographyDefaultPolicy;

    // The common DI registration owner may bind the one verified policy through this constructor.
    // The existing public constructor remains readable for valid stored profiles, without a fallback default.
    internal UserLocalePreferenceService(
        ISqlSugarClient database,
        ILogger<UserLocalePreferenceService> serviceLogger,
        TimeProvider? businessClock,
        IAuthorTypographyCurrentDesignDefaultPolicy defaultPolicy)
        : this(database, serviceLogger, businessClock)
    {
        ArgumentNullException.ThrowIfNull(defaultPolicy);
        _authorTypographyDefaultPolicy = defaultPolicy;
    }

    /// <summary>Reads stored/default facts without changing the shared row or accepting a client default.</summary>
    public async Task<AuthorTypographyPreferenceReadResult> GetTypographyAsync(
        AuthorTypographyScope authenticatedScope,
        CancellationToken cancellationToken = default)
    {
        if (!AuthorTypographyContractValidator.ValidateScope(authenticatedScope))
        {
            return new(AuthorTypographyPreferenceReadOutcome.Forbidden, null);
        }
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            (long revision, AuthorTypographyProfile? profile) = await ReadAuthorTypographyStateCoreAsync(
                authenticatedScope, cancellationToken).ConfigureAwait(false);
            bool stored = AuthorTypographyContractValidator.ValidateProfile(profile);
            if (!stored)
            {
                profile = CurrentTypographyDesignDefault();
            }
            if (profile is null)
            {
                return new(AuthorTypographyPreferenceReadOutcome.CurrentDesignDefaultUnavailable, null);
            }
            var unsigned = new AuthorTypographySnapshot(authenticatedScope, revision, profile, string.Empty);
            AuthorTypographySnapshot snapshot = unsigned with
            {
                ContentDigest = AuthorTypographyContractValidator.ComputeSnapshotDigest(unsigned)
            };
            return new(stored ? AuthorTypographyPreferenceReadOutcome.Stored
                : AuthorTypographyPreferenceReadOutcome.CurrentDesignDefault, snapshot);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (UnauthorizedAccessException)
        {
            return new(AuthorTypographyPreferenceReadOutcome.Forbidden, null);
        }
        catch (Exception)
        {
            logger.LogWarning("Author typography read unavailable | reason=authority_observation_error");
            return new(AuthorTypographyPreferenceReadOutcome.Unavailable, null);
        }
    }

    /// <summary>
    /// The caller supplies a formally server-verified device scope. Digest shape is checked here;
    /// no header, account, session label or missing-device stand-in establishes device authority.
    /// </summary>
    public async Task<AuthorTypographyPreferenceWriteResult> UpdateTypographyAsync(
        AuthorTypographyScope authenticatedScope,
        string deviceScope,
        AuthorTypographyMutationRequest request,
        CancellationToken cancellationToken = default)
    {
        if (!AuthorTypographyContractValidator.ValidateScope(authenticatedScope))
        {
            return new(AuthorTypographyPreferenceWriteOutcome.Forbidden, null, null);
        }
        if (!AuthorTypographyContractValidator.ValidateMutationRequest(authenticatedScope, request)
            || !WritingAidPreferenceReceiptValidator.IsDeviceScope(deviceScope)
            || request.Command.ExpectedRevision >= WritingAidPreferenceContract.MaximumExactRevision)
        {
            return new(AuthorTypographyPreferenceWriteOutcome.InvalidRequest, null, null);
        }
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            AuthorTypographyRecordedRequest? record = await ReadAuthorTypographyRequestCoreAsync(
                authenticatedScope, request.RequestId, cancellationToken).ConfigureAwait(false);
            AuthorTypographyRequestReplayDecision replay = AuthorTypographyRequestReplayPolicy.Evaluate(
                authenticatedScope, request, record);
            AuthorTypographyPreparedMutation? mutation;
            if (replay.Status == AuthorTypographyRequestReplayStatus.Replayable)
            {
                // Re-enter the owner's commit helper so its persisted device binding is also checked.
                mutation = new(authenticatedScope, request.Command.ExpectedRevision, replay.OriginalSnapshot!.Profile);
            }
            else if (replay.Status == AuthorTypographyRequestReplayStatus.NotRecorded)
            {
                AuthorTypographyCommandDecision decision = AuthorTypographyCommandPolicy.PreparePayload(
                    authenticatedScope, request.Command,
                    request.Command.Mutation == AuthorTypographyMutation.Reset ? CurrentTypographyDesignDefault() : null);
                if (decision.Status != AuthorTypographyCommandStatus.Prepared)
                {
                    return new(decision.Status == AuthorTypographyCommandStatus.CurrentDesignDefaultUnavailable
                        ? AuthorTypographyPreferenceWriteOutcome.CurrentDesignDefaultUnavailable
                        : AuthorTypographyPreferenceWriteOutcome.InvalidRequest, null, null);
                }
                mutation = decision.PreparedMutation;
            }
            else
            {
                return new(replay.Status == AuthorTypographyRequestReplayStatus.RequestIdentityConflict
                    ? AuthorTypographyPreferenceWriteOutcome.RequestIdentityConflict
                    : AuthorTypographyPreferenceWriteOutcome.Unavailable, null, null);
            }
            // The existing helper owns the transaction, idempotency-before-CAS and cross-domain preservation.
            return await CommitAuthorTypographyCoreAsync(authenticatedScope, deviceScope, request, mutation!, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (UnauthorizedAccessException)
        {
            return new(AuthorTypographyPreferenceWriteOutcome.Forbidden, null, null);
        }
        catch (Exception)
        {
            logger.LogWarning("Author typography write unavailable | reason=authority_observation_error");
            return new(AuthorTypographyPreferenceWriteOutcome.Unavailable, null, null);
        }
    }

    private AuthorTypographyProfile? CurrentTypographyDesignDefault()
    {
        AuthorTypographyProfile? profile = _authorTypographyDefaultPolicy?.GetCurrentDesignDefault();
        return AuthorTypographyContractValidator.ValidateProfile(profile) ? profile : null;
    }
}
