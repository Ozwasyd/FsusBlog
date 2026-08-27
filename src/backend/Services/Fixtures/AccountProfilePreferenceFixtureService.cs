// fixture-catalog: producer account-profile-preferences
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.Localization;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services.Fixtures;

internal static class AccountProfilePreferenceFixtureCapabilities
{
    public const string ProfileEmpty = "profile.public-handle.empty";
    public const string ProfileSet = "profile.public-handle.set";
    public const string ProfileConflict = "profile.public-handle.conflict";
    public const string LocaleAuto = "preferences.locale.auto";
    public const string LocaleFixedDefault = "preferences.locale.fixed.zh-cn";
    public const string LocaleFixedNonDefault = "preferences.locale.fixed.non-default";
    public const string LocaleDeviceExplicit = "preferences.locale.device-explicit";
    public const string LocaleAccountDeviceConflict = "preferences.locale.account-device-conflict";
    public const string LocaleRevisionConflict = "preferences.locale.revision-conflict";
    public const string LocaleTwoDeviceSync = "preferences.locale.two-device-sync";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal)
    {
        LocaleAccountDeviceConflict,
        LocaleAuto,
        LocaleDeviceExplicit,
        LocaleFixedDefault,
        LocaleFixedNonDefault,
        LocaleRevisionConflict,
        LocaleTwoDeviceSync,
        ProfileConflict,
        ProfileEmpty,
        ProfileSet
    };

    public static readonly IReadOnlyDictionary<string, string> Postconditions =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [LocaleAccountDeviceConflict] = "preference-locale-account-device-conflict",
            [LocaleAuto] = "preference-locale-auto",
            [LocaleDeviceExplicit] = "preference-locale-device-explicit",
            [LocaleFixedDefault] = "preference-locale-fixed-default",
            [LocaleFixedNonDefault] = "preference-locale-fixed-non-default",
            [LocaleRevisionConflict] = "preference-locale-revision-conflict",
            [LocaleTwoDeviceSync] = "preference-locale-two-device-sync",
            [ProfileConflict] = "profile-public-handle-conflict",
            [ProfileEmpty] = "profile-public-handle-empty",
            [ProfileSet] = "profile-public-handle-set"
        };
}

internal sealed record AccountFixtureIdentityReference(
    string SemanticRole,
    int UserId,
    string IdentityDigest,
    string SessionDigest,
    string Namespace,
    string RunId,
    string Owner,
    IReadOnlyList<string>? DeviceRoles = null);

internal sealed record AccountProfilePreferenceFixtureRequest(
    IReadOnlyList<string> Capabilities,
    string Namespace,
    string RunId,
    string Owner,
    IReadOnlyList<AccountFixtureIdentityReference> IdentityReferences,
    JsonElement? TemporalContext = null,
    JsonElement? ResolvedTemporalRoles = null);

internal sealed record AccountFixtureEntityIdentity(
    string Kind,
    string Id,
    string? Handle,
    string CapabilityHint);

internal sealed record AccountFixtureObservedEntity(
    string Kind,
    string Id,
    bool Owned,
    string CapabilityHint,
    string PostconditionId,
    IReadOnlyDictionary<string, object?> Fields);

internal sealed record AccountFixtureDatabaseObservation(
    string Namespace,
    string SchemaIdentity,
    IReadOnlyList<AccountFixtureObservedEntity> Entities);

internal sealed record AccountFixtureCacheEntry(
    string Domain,
    string Identity,
    bool MatchesDatabase,
    long Revision);

internal sealed record AccountFixtureCacheObservation(
    string Namespace,
    IReadOnlyList<AccountFixtureCacheEntry> Entries);

internal sealed record AccountFixtureObservations(
    string Source,
    AccountFixtureDatabaseObservation Database,
    AccountFixtureCacheObservation Cache);

internal sealed record AccountLocaleDeviceProjection(
    string CapabilityId,
    string UserRef,
    string DeviceRole,
    string AccountMode,
    string? AccountLocale,
    string? IncomingDeviceLocale,
    string? ExplicitCookieLocale,
    string AcceptLanguage,
    string ResolvedLocale,
    string ResolutionSource,
    long Revision,
    string CatalogDigest);

internal sealed record AccountFixtureCleanupState(
    string SemanticRole,
    int UserId,
    string IdentityDigest,
    string SecurityStateDigest,
    bool ProfileChanged,
    string? PreviousPublicHandle,
    bool PreferenceChanged,
    UserLocalePreferenceDto PreviousPreference,
    bool PreviousPreferenceExisted,
    UserLocalePreferenceDto? CommittedPreference);

internal sealed record AccountProfilePreferenceFixtureResult(
    string Strategy,
    string ProducerId,
    string Namespace,
    string RunId,
    string Owner,
    string LocaleCatalogDigest,
    IReadOnlyList<string> ProvidedCapabilities,
    IReadOnlyList<AccountFixtureEntityIdentity> EntityIdentities,
    AccountFixtureObservations Observations,
    IReadOnlyList<AccountLocaleDeviceProjection> DeviceProjections,
    IReadOnlyList<AccountFixtureCleanupState> CleanupState,
    object? TemporalObservation,
    string ContentDigest);

internal sealed record AccountProfilePreferenceFixtureVerification(
    bool Ok,
    string ContentDigest,
    IReadOnlyList<string> VerifiedCapabilities,
    string? Failure = null);

internal interface IAccountProfilePreferenceFixtureService
{
    Task<AccountProfilePreferenceFixtureResult> PrepareAsync(
        AccountProfilePreferenceFixtureRequest request,
        CancellationToken cancellationToken = default);

    Task<AccountProfilePreferenceFixtureVerification> VerifyAsync(
        AccountProfilePreferenceFixtureResult result,
        CancellationToken cancellationToken = default);

    Task CleanupAsync(
        AccountProfilePreferenceFixtureResult result,
        CancellationToken cancellationToken = default);
}

internal interface IAccountPreferenceFixtureCommand
{
    Task<UserLocalePreferenceUpdateResult> UpdateAtAsync(
        int accountId,
        UserLocalePreferenceUpdateDto request,
        DateTimeOffset updatedAt,
        CancellationToken cancellationToken = default);

    Task<bool> CompensateAsync(
        int accountId,
        UserLocalePreferenceDto committedPreference,
        UserLocalePreferenceDto previousPreference,
        bool previousPreferenceExisted,
        CancellationToken cancellationToken = default);
}

internal sealed class AccountPreferenceFixtureCommand(
    UserLocalePreferenceService preferences) : IAccountPreferenceFixtureCommand
{
    public Task<UserLocalePreferenceUpdateResult> UpdateAtAsync(
        int accountId,
        UserLocalePreferenceUpdateDto request,
        DateTimeOffset updatedAt,
        CancellationToken cancellationToken = default)
        => preferences.UpdateAtAsync(accountId, request, updatedAt, cancellationToken);

    public Task<bool> CompensateAsync(
        int accountId,
        UserLocalePreferenceDto committedPreference,
        UserLocalePreferenceDto previousPreference,
        bool previousPreferenceExisted,
        CancellationToken cancellationToken = default)
        => preferences.CompensateAsync(
            accountId,
            committedPreference,
            previousPreference,
            previousPreferenceExisted,
            cancellationToken);
}

/// <summary>
/// Test-only account profile/preference composition root (#1717, #2168, #2169).
/// It consumes verified auth references and delegates every write to production
/// command ports. Browser state is an output projection and never an authority.
/// </summary>
internal sealed class AccountProfilePreferenceFixtureService(
    IUserProfileCommandService profileCommands,
    IUserAccountReader accountReader,
    IAccountPreferenceFixtureCommand preferenceCommands,
    IUserLocalePreferenceReader preferenceReader,
    ILocaleResolver localeResolver,
    IAccountProfilePreferenceFixtureStateReader stateReader)
    : IAccountProfilePreferenceFixtureService
{
    private const string Strategy = "transaction-fixture";
    private const string ProducerId = "account-profile-preferences";

    public async Task<AccountProfilePreferenceFixtureResult> PrepareAsync(
        AccountProfilePreferenceFixtureRequest request,
        CancellationToken cancellationToken = default)
    {
        RequestContext context = ValidateRequest(request);
        var entities = new List<AccountFixtureObservedEntity>();
        var identities = new List<AccountFixtureEntityIdentity>();
        var projections = new List<AccountLocaleDeviceProjection>();
        var cleanup = new Dictionary<string, AccountFixtureCleanupState>(StringComparer.Ordinal);

        if (context.Capabilities.Contains(AccountProfilePreferenceFixtureCapabilities.ProfileEmpty))
        {
            AccountFixtureIdentityReference identity = context.RequireIdentity("profile-empty");
            await EnsureProfileAsync(identity, null, cleanup, cancellationToken).ConfigureAwait(false);
            await ObserveProfileAsync(
                identity,
                AccountProfilePreferenceFixtureCapabilities.ProfileEmpty,
                "profile-public-handle-empty",
                null,
                context.ProfileUpdatedInstant,
                entities,
                identities,
                cancellationToken).ConfigureAwait(false);
        }

        if (context.Capabilities.Contains(AccountProfilePreferenceFixtureCapabilities.ProfileSet))
        {
            AccountFixtureIdentityReference identity = context.RequireIdentity("profile-set");
            string handle = DeriveHandle(request, identity.SemanticRole);
            await EnsureProfileAsync(identity, handle, cleanup, cancellationToken).ConfigureAwait(false);
            await ObserveProfileAsync(
                identity,
                AccountProfilePreferenceFixtureCapabilities.ProfileSet,
                "profile-public-handle-set",
                handle,
                context.ProfileUpdatedInstant,
                entities,
                identities,
                cancellationToken).ConfigureAwait(false);
        }

        if (context.Capabilities.Contains(AccountProfilePreferenceFixtureCapabilities.ProfileConflict))
        {
            AccountFixtureIdentityReference owner = context.RequireIdentity("profile-conflict-owner");
            AccountFixtureIdentityReference challenger = context.RequireIdentity("profile-conflict-challenger");
            if (owner.UserId == challenger.UserId)
            {
                throw new InvalidOperationException("profile conflict requires two independent identity references");
            }

            string handle = DeriveHandle(request, "profile-conflict");
            await EnsureProfileAsync(owner, handle, cleanup, cancellationToken).ConfigureAwait(false);
            AccountProfilePreferenceObservedState challengerBefore = await stateReader
                .ReadAsync(challenger.UserId, cancellationToken)
                .ConfigureAwait(false);
            (bool success, _) = await profileCommands
                .UpdatePublicHandleAsync(challenger.UserId, handle, cancellationToken)
                .ConfigureAwait(false);
            AccountProfilePreferenceObservedState challengerAfter = await stateReader
                .ReadAsync(challenger.UserId, cancellationToken)
                .ConfigureAwait(false);
            int ownerCount = await stateReader
                .CountHandleOwnersAsync(handle, cancellationToken)
                .ConfigureAwait(false);
            if (success
                || ownerCount != 1
                || challengerAfter.PublicHandle != challengerBefore.PublicHandle
                || challengerAfter.SecurityStateDigest != challengerBefore.SecurityStateDigest)
            {
                throw new InvalidOperationException("profile public handle conflict did not fail closed");
            }

            await ObserveProfileAsync(
                owner,
                AccountProfilePreferenceFixtureCapabilities.ProfileConflict,
                "profile-public-handle-conflict",
                handle,
                context.ProfileUpdatedInstant,
                entities,
                identities,
                cancellationToken,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["conflictErrorCode"] = "conflict",
                    ["challengerUserRef"] = UserRef(challenger.UserId),
                    ["challengerPreserved"] = true
                }).ConfigureAwait(false);
        }

        LocaleDescriptor defaultLocale = LocaleCatalog.Default;
        LocaleDescriptor nonDefaultLocale = LocaleCatalog.Enabled
            .First(locale => !string.Equals(locale.Code, defaultLocale.Code, StringComparison.Ordinal));
        LocaleDescriptor secondNonDefaultLocale = LocaleCatalog.Enabled
            .First(locale => !string.Equals(locale.Code, defaultLocale.Code, StringComparison.Ordinal)
                && !string.Equals(locale.Code, nonDefaultLocale.Code, StringComparison.Ordinal));

        await PreparePreferenceCapabilityAsync(
            context,
            request,
            AccountProfilePreferenceFixtureCapabilities.LocaleAuto,
            "preference-auto",
            "preference-locale-auto",
            LocalePreferenceModes.Auto,
            null,
            null,
            defaultLocale.Code,
            cleanup,
            entities,
            identities,
            projections,
            cancellationToken).ConfigureAwait(false);
        await PreparePreferenceCapabilityAsync(
            context,
            request,
            AccountProfilePreferenceFixtureCapabilities.LocaleFixedDefault,
            "preference-fixed-default",
            "preference-locale-fixed-default",
            LocalePreferenceModes.Fixed,
            defaultLocale,
            defaultLocale,
            nonDefaultLocale.Code,
            cleanup,
            entities,
            identities,
            projections,
            cancellationToken).ConfigureAwait(false);
        await PreparePreferenceCapabilityAsync(
            context,
            request,
            AccountProfilePreferenceFixtureCapabilities.LocaleFixedNonDefault,
            "preference-fixed-non-default",
            "preference-locale-fixed-non-default",
            LocalePreferenceModes.Fixed,
            nonDefaultLocale,
            nonDefaultLocale,
            defaultLocale.Code,
            cleanup,
            entities,
            identities,
            projections,
            cancellationToken).ConfigureAwait(false);
        await PreparePreferenceCapabilityAsync(
            context,
            request,
            AccountProfilePreferenceFixtureCapabilities.LocaleDeviceExplicit,
            "preference-device-explicit",
            "preference-locale-device-explicit",
            LocalePreferenceModes.Auto,
            null,
            nonDefaultLocale,
            defaultLocale.Code,
            cleanup,
            entities,
            identities,
            projections,
            cancellationToken).ConfigureAwait(false);
        await PreparePreferenceCapabilityAsync(
            context,
            request,
            AccountProfilePreferenceFixtureCapabilities.LocaleAccountDeviceConflict,
            "preference-account-device-conflict",
            "preference-locale-account-device-conflict",
            LocalePreferenceModes.Fixed,
            nonDefaultLocale,
            secondNonDefaultLocale,
            defaultLocale.Code,
            cleanup,
            entities,
            identities,
            projections,
            cancellationToken).ConfigureAwait(false);
        await PreparePreferenceCapabilityAsync(
            context,
            request,
            AccountProfilePreferenceFixtureCapabilities.LocaleTwoDeviceSync,
            "preference-two-device",
            "preference-locale-two-device-sync",
            LocalePreferenceModes.Fixed,
            nonDefaultLocale,
            nonDefaultLocale,
            defaultLocale.Code,
            cleanup,
            entities,
            identities,
            projections,
            cancellationToken,
            requireTwoDevices: true).ConfigureAwait(false);

        if (context.Capabilities.Contains(AccountProfilePreferenceFixtureCapabilities.LocaleRevisionConflict))
        {
            AccountFixtureIdentityReference identity = context.RequireIdentity("preference-revision-conflict");
            PreferenceMutation mutation = await EnsurePreferenceAsync(
                identity,
                LocalePreferenceModes.Fixed,
                secondNonDefaultLocale.Code,
                context.PreferenceRevisionInstant,
                cleanup,
                cancellationToken).ConfigureAwait(false);
            UserLocalePreferenceDto current = await preferenceReader
                .GetAsync(identity.UserId, cancellationToken)
                .ConfigureAwait(false);
            if (current.Revision <= 0)
            {
                throw new InvalidOperationException("revision conflict requires a committed preference revision");
            }

            UserLocalePreferenceUpdateResult stale = await preferenceCommands.UpdateAtAsync(
                identity.UserId,
                new UserLocalePreferenceUpdateDto(
                    LocalePreferenceModes.Fixed,
                    nonDefaultLocale.Code,
                    current.Revision - 1),
                context.PreferenceConflictInstant,
                cancellationToken).ConfigureAwait(false);
            UserLocalePreferenceDto preserved = await preferenceReader
                .GetAsync(identity.UserId, cancellationToken)
                .ConfigureAwait(false);
            if (stale.Outcome != UserLocalePreferenceUpdateOutcome.RevisionConflict
                || !SamePreference(current, preserved))
            {
                throw new InvalidOperationException("stale locale preference update did not preserve the newer value");
            }

            await ObservePreferenceAsync(
                identity,
                AccountProfilePreferenceFixtureCapabilities.LocaleRevisionConflict,
                "preference-locale-revision-conflict",
                mutation.StateBefore.SecurityStateDigest,
                null,
                defaultLocale.Code,
                context.PreferenceRevisionInstant,
                "preference.conflict",
                context.PreferenceConflictInstant,
                entities,
                identities,
                projections,
                cancellationToken,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["conflictErrorCode"] = "locale_preference_revision_conflict",
                    ["staleRevision"] = current.Revision - 1,
                    ["newerValuePreserved"] = true
                }).ConfigureAwait(false);
        }

        if (entities.Count == 0)
        {
            throw new InvalidOperationException("account profile/preference producer requires at least one capability");
        }

        var observations = new AccountFixtureObservations(
            "production-command-and-independent-readers",
            new AccountFixtureDatabaseObservation(request.Namespace, "public", entities),
            new AccountFixtureCacheObservation(
                request.Namespace,
                entities.Select(entity => new AccountFixtureCacheEntry(
                    entity.Kind == "profile" ? "redis.cache.private.account-snapshot" : "application.preference-reader",
                    entity.Id,
                    Convert.ToBoolean(entity.Fields["readerMatchesDatabase"], CultureInfo.InvariantCulture),
                    Convert.ToInt64(entity.Fields["revision"], CultureInfo.InvariantCulture)))
                    .ToArray()));
        string digest = ComputeResultDigest(
            request.Namespace,
            request.RunId,
            request.Owner,
            context.Capabilities,
            identities,
            observations,
            projections,
            cleanup.Values.OrderBy(item => item.SemanticRole, StringComparer.Ordinal).ToArray());
        return new AccountProfilePreferenceFixtureResult(
            Strategy,
            ProducerId,
            request.Namespace,
            request.RunId,
            request.Owner,
            LocaleCatalog.Digest,
            context.Capabilities,
            identities,
            observations,
            projections,
            cleanup.Values.OrderBy(item => item.SemanticRole, StringComparer.Ordinal).ToArray(),
            null,
            digest);
    }

    public async Task<AccountProfilePreferenceFixtureVerification> VerifyAsync(
        AccountProfilePreferenceFixtureResult result,
        CancellationToken cancellationToken = default)
    {
        try
        {
            if (result.Strategy != Strategy
                || result.ProducerId != ProducerId
                || result.LocaleCatalogDigest != LocaleCatalog.Digest
                || result.ContentDigest != ComputeResultDigest(
                    result.Namespace,
                    result.RunId,
                    result.Owner,
                    result.ProvidedCapabilities,
                    result.EntityIdentities,
                    result.Observations,
                    result.DeviceProjections,
                    result.CleanupState)
                || result.ProvidedCapabilities.Any(capability =>
                    !AccountProfilePreferenceFixtureCapabilities.All.Contains(capability)))
            {
                throw new InvalidOperationException("fixture result identity or catalog binding is invalid");
            }
            ValidateResultBindings(result);

            foreach (AccountFixtureObservedEntity entity in result.Observations.Database.Entities)
            {
                int userId = ParseUserRef(entity.Id);
                AccountProfilePreferenceObservedState database = await stateReader
                    .ReadAsync(userId, cancellationToken)
                    .ConfigureAwait(false);
                if (!database.Exists)
                {
                    throw new InvalidOperationException($"fixture user {entity.Id} no longer exists");
                }

                if (entity.Kind == "profile")
                {
                    UserAccountSnapshot? reader = await accountReader.GetAccountByIdAsync(userId).ConfigureAwait(false);
                    string? expected = ReadNullableString(entity.Fields, "publicHandle");
                    if (!reader.HasValue
                        || reader.Value.PublicHandle != database.PublicHandle
                        || database.PublicHandle != expected)
                    {
                        throw new InvalidOperationException($"profile projection drifted for {entity.Id}");
                    }
                    if (expected is not null
                        && await stateReader.CountHandleOwnersAsync(expected, cancellationToken).ConfigureAwait(false) != 1)
                    {
                        throw new InvalidOperationException($"profile handle uniqueness drifted for {entity.Id}");
                    }
                }
                else if (entity.Kind == "preference")
                {
                    UserLocalePreferenceDto reader = await preferenceReader
                        .GetAsync(userId, cancellationToken)
                        .ConfigureAwait(false);
                    if (!SamePreference(database.Preference, reader)
                        || reader.Mode != ReadNullableString(entity.Fields, "localeMode")
                        || reader.FixedLocale != ReadNullableString(entity.Fields, "fixedLocale")
                        || reader.Revision != ReadInt64(entity.Fields, "revision"))
                    {
                        throw new InvalidOperationException($"preference projection drifted for {entity.Id}");
                    }
                }
            }

            return new AccountProfilePreferenceFixtureVerification(
                true,
                result.ContentDigest,
                result.ProvidedCapabilities);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            return new AccountProfilePreferenceFixtureVerification(
                false,
                result.ContentDigest,
                [],
                exception.Message);
        }
    }

    public async Task CleanupAsync(
        AccountProfilePreferenceFixtureResult result,
        CancellationToken cancellationToken = default)
    {
        AccountProfilePreferenceFixtureVerification verification = await VerifyAsync(
            result,
            cancellationToken).ConfigureAwait(false);
        if (!verification.Ok)
        {
            throw new InvalidOperationException(
                $"cleanup requires an exact verified fixture result: {verification.Failure}");
        }

        foreach (AccountFixtureCleanupState state in result.CleanupState.Reverse())
        {
            AccountProfilePreferenceObservedState current = await stateReader
                .ReadAsync(state.UserId, cancellationToken)
                .ConfigureAwait(false);
            if (current.SecurityStateDigest != state.SecurityStateDigest)
            {
                throw new InvalidOperationException("cleanup refused after auth/session/security state drift");
            }

            if (state.PreferenceChanged && state.CommittedPreference.HasValue)
            {
                bool compensated = await preferenceCommands.CompensateAsync(
                    state.UserId,
                    state.CommittedPreference.Value,
                    state.PreviousPreference,
                    state.PreviousPreferenceExisted,
                    cancellationToken).ConfigureAwait(false);
                if (!compensated)
                {
                    throw new InvalidOperationException("preference cleanup compensation failed closed");
                }
            }

            if (state.ProfileChanged)
            {
                (bool success, _) = await profileCommands.UpdatePublicHandleAsync(
                    state.UserId,
                    state.PreviousPublicHandle,
                    cancellationToken).ConfigureAwait(false);
                if (!success)
                {
                    throw new InvalidOperationException("profile cleanup compensation failed closed");
                }
            }
        }
    }

    private async Task PreparePreferenceCapabilityAsync(
        RequestContext context,
        AccountProfilePreferenceFixtureRequest request,
        string capability,
        string semanticRole,
        string postcondition,
        string mode,
        LocaleDescriptor? accountLocale,
        LocaleDescriptor? explicitCookieLocale,
        string acceptLanguage,
        IDictionary<string, AccountFixtureCleanupState> cleanup,
        ICollection<AccountFixtureObservedEntity> entities,
        ICollection<AccountFixtureEntityIdentity> identities,
        ICollection<AccountLocaleDeviceProjection> projections,
        CancellationToken cancellationToken,
        bool requireTwoDevices = false)
    {
        if (!context.Capabilities.Contains(capability))
        {
            return;
        }

        AccountFixtureIdentityReference identity = context.RequireIdentity(semanticRole);
        if (requireTwoDevices && (identity.DeviceRoles?.Distinct(StringComparer.Ordinal).Count() ?? 0) != 2)
        {
            throw new InvalidOperationException("two-device locale capability requires exactly two device semantic roles");
        }

        PreferenceMutation mutation = await EnsurePreferenceAsync(
            identity,
            mode,
            accountLocale?.Code,
            context.PreferenceRevisionInstant,
            cleanup,
            cancellationToken).ConfigureAwait(false);
        bool twoDeviceSync = capability == AccountProfilePreferenceFixtureCapabilities.LocaleTwoDeviceSync;
        await ObservePreferenceAsync(
            identity,
            capability,
            postcondition,
            mutation.StateBefore.SecurityStateDigest,
            explicitCookieLocale,
            acceptLanguage,
            context.PreferenceRevisionInstant,
            twoDeviceSync ? "preference.device-sync" : "preference.revision",
            twoDeviceSync ? context.PreferenceDeviceSyncInstant : context.PreferenceRevisionInstant,
            entities,
            identities,
            projections,
            cancellationToken).ConfigureAwait(false);
    }

    private async Task EnsureProfileAsync(
        AccountFixtureIdentityReference identity,
        string? publicHandle,
        IDictionary<string, AccountFixtureCleanupState> cleanup,
        CancellationToken cancellationToken)
    {
        AccountProfilePreferenceObservedState before = await stateReader
            .ReadAsync(identity.UserId, cancellationToken)
            .ConfigureAwait(false);
        RequireExistingIdentity(before, identity);
        if (before.PublicHandle == publicHandle)
        {
            cleanup.TryAdd(identity.SemanticRole, CleanupState(identity, before));
            return;
        }

        (bool success, _) = await profileCommands
            .UpdatePublicHandleAsync(identity.UserId, publicHandle, cancellationToken)
            .ConfigureAwait(false);
        if (!success)
        {
            throw new InvalidOperationException($"profile command rejected owned role {identity.SemanticRole}");
        }

        cleanup[identity.SemanticRole] = CleanupState(identity, before) with
        {
            ProfileChanged = true
        };
    }

    private async Task<PreferenceMutation> EnsurePreferenceAsync(
        AccountFixtureIdentityReference identity,
        string mode,
        string? fixedLocale,
        DateTimeOffset updatedAt,
        IDictionary<string, AccountFixtureCleanupState> cleanup,
        CancellationToken cancellationToken)
    {
        AccountProfilePreferenceObservedState before = await stateReader
            .ReadAsync(identity.UserId, cancellationToken)
            .ConfigureAwait(false);
        RequireExistingIdentity(before, identity);
        if (before.PreferenceExists
            && before.Preference.Mode == mode
            && before.Preference.FixedLocale == fixedLocale)
        {
            cleanup.TryAdd(identity.SemanticRole, CleanupState(identity, before));
            return new PreferenceMutation(before, before.Preference);
        }

        UserLocalePreferenceUpdateResult update = await preferenceCommands.UpdateAtAsync(
            identity.UserId,
            new UserLocalePreferenceUpdateDto(mode, fixedLocale, before.Preference.Revision),
            updatedAt,
            cancellationToken).ConfigureAwait(false);
        if (!update.Success || !update.Preference.HasValue)
        {
            throw new InvalidOperationException(
                $"preference command rejected owned role {identity.SemanticRole}: {update.Outcome}");
        }

        cleanup[identity.SemanticRole] = CleanupState(identity, before) with
        {
            PreferenceChanged = true,
            CommittedPreference = update.Preference
        };
        return new PreferenceMutation(before, update.Preference.Value);
    }

    private async Task ObserveProfileAsync(
        AccountFixtureIdentityReference identity,
        string capability,
        string postcondition,
        string? expectedHandle,
        DateTimeOffset profileUpdatedInstant,
        ICollection<AccountFixtureObservedEntity> entities,
        ICollection<AccountFixtureEntityIdentity> identities,
        CancellationToken cancellationToken,
        IDictionary<string, object?>? extraFields = null)
    {
        AccountProfilePreferenceObservedState database = await stateReader
            .ReadAsync(identity.UserId, cancellationToken)
            .ConfigureAwait(false);
        UserAccountSnapshot? reader = await accountReader.GetAccountByIdAsync(identity.UserId).ConfigureAwait(false);
        int ownerCount = expectedHandle is null
            ? 0
            : await stateReader.CountHandleOwnersAsync(expectedHandle, cancellationToken).ConfigureAwait(false);
        if (!reader.HasValue
            || database.PublicHandle != expectedHandle
            || reader.Value.PublicHandle != expectedHandle
            || expectedHandle is not null && ownerCount != 1)
        {
            throw new InvalidOperationException($"profile postcondition failed for {identity.SemanticRole}");
        }

        var fields = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["publicHandle"] = expectedHandle,
            ["revision"] = database.ProfileRevision,
            ["readerMatchesDatabase"] = true,
            ["uniqueOwnerCount"] = ownerCount,
            ["identityDigest"] = identity.IdentityDigest,
            ["sessionDigest"] = identity.SessionDigest,
            ["securityStateDigest"] = database.SecurityStateDigest,
            ["securityStateUnchanged"] = true,
            ["preferenceMutation"] = false,
            ["scenarioRoleId"] = "profile.updated",
            ["scenarioInstantUtc"] = profileUpdatedInstant.ToString(
                "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                CultureInfo.InvariantCulture)
        };
        foreach ((string key, object? value) in extraFields ?? new Dictionary<string, object?>())
        {
            fields[key] = value;
        }
        entities.Add(new AccountFixtureObservedEntity(
            "profile",
            UserRef(identity.UserId),
            true,
            capability,
            postcondition,
            fields));
        identities.Add(new AccountFixtureEntityIdentity(
            "profile",
            UserRef(identity.UserId),
            expectedHandle,
            capability));
    }

    private async Task ObservePreferenceAsync(
        AccountFixtureIdentityReference identity,
        string capability,
        string postcondition,
        string expectedSecurityDigest,
        LocaleDescriptor? explicitCookieLocale,
        string acceptLanguage,
        DateTimeOffset expectedUpdatedAt,
        string scenarioRoleId,
        DateTimeOffset scenarioInstant,
        ICollection<AccountFixtureObservedEntity> entities,
        ICollection<AccountFixtureEntityIdentity> identities,
        ICollection<AccountLocaleDeviceProjection> projections,
        CancellationToken cancellationToken,
        IDictionary<string, object?>? extraFields = null)
    {
        AccountProfilePreferenceObservedState database = await stateReader
            .ReadAsync(identity.UserId, cancellationToken)
            .ConfigureAwait(false);
        UserLocalePreferenceDto reader = await preferenceReader
            .GetAsync(identity.UserId, cancellationToken)
            .ConfigureAwait(false);
        UserAccountSnapshot? account = await accountReader.GetAccountByIdAsync(identity.UserId).ConfigureAwait(false);
        if (!database.Exists
            || !account.HasValue
            || database.SecurityStateDigest != expectedSecurityDigest
            || !SamePreference(database.Preference, reader)
            || reader.UpdatedAt.ToUniversalTime() != expectedUpdatedAt.UtcDateTime)
        {
            throw new InvalidOperationException($"preference postcondition failed for {identity.SemanticRole}");
        }

        string[] deviceRoles = (identity.DeviceRoles is { Count: > 0 }
            ? identity.DeviceRoles
            : ["device-primary"]).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        LocaleDescriptor? effectiveCookieLocale = explicitCookieLocale;
        if (string.Equals(reader.Mode, LocalePreferenceModes.Fixed, StringComparison.Ordinal))
        {
            if (!LocaleCatalog.TryParse(reader.FixedLocale, out LocaleDescriptor accountLocale)
                || !string.Equals(reader.FixedLocale, accountLocale.Code, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("fixed account locale is not catalog canonical");
            }
            effectiveCookieLocale = accountLocale;
        }
        foreach (string deviceRole in deviceRoles)
        {
            LocaleResolutionResult resolution = localeResolver.Resolve(new LocaleResolutionInput(
                effectiveCookieLocale,
                acceptLanguage,
                LocaleCatalog.Default));
            projections.Add(new AccountLocaleDeviceProjection(
                capability,
                UserRef(identity.UserId),
                deviceRole,
                reader.Mode,
                reader.FixedLocale,
                explicitCookieLocale?.Code,
                effectiveCookieLocale?.Code,
                acceptLanguage,
                resolution.Locale.Code,
                resolution.Source.ToString(),
                reader.Revision,
                resolution.CatalogDigest));
        }

        var fields = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["localeMode"] = reader.Mode,
            ["fixedLocale"] = reader.FixedLocale,
            ["revision"] = reader.Revision,
            ["updatedAt"] = reader.UpdatedAt,
            ["readerMatchesDatabase"] = true,
            ["catalogDigest"] = LocaleCatalog.Digest,
            ["identityDigest"] = identity.IdentityDigest,
            ["sessionDigest"] = identity.SessionDigest,
            ["securityStateDigest"] = database.SecurityStateDigest,
            ["publicHandleMutation"] = false,
            ["deviceRoles"] = deviceRoles,
            ["deviceProjectionCount"] = deviceRoles.Length,
            ["incomingDeviceLocales"] = projections
                .Where(projection => projection.CapabilityId == capability
                    && projection.UserRef == UserRef(identity.UserId))
                .Select(projection => projection.IncomingDeviceLocale)
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            ["explicitCookieLocales"] = projections
                .Where(projection => projection.CapabilityId == capability
                    && projection.UserRef == UserRef(identity.UserId))
                .Select(projection => projection.ExplicitCookieLocale)
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            ["serverResolvedLocales"] = projections
                .Where(projection => projection.CapabilityId == capability
                    && projection.UserRef == UserRef(identity.UserId))
                .Select(projection => projection.ResolvedLocale)
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            ["isCatalogDefault"] = reader.FixedLocale == LocaleCatalog.Default.Code,
            ["isCatalogNonDefault"] = reader.FixedLocale is not null
                && reader.FixedLocale != LocaleCatalog.Default.Code,
            ["securityStateUnchanged"] = true,
            ["updatedAtRoleId"] = "preference.revision",
            ["scenarioRoleId"] = scenarioRoleId,
            ["scenarioInstantUtc"] = scenarioInstant.ToString(
                "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                CultureInfo.InvariantCulture)
        };
        foreach ((string key, object? value) in extraFields ?? new Dictionary<string, object?>())
        {
            fields[key] = value;
        }
        entities.Add(new AccountFixtureObservedEntity(
            "preference",
            UserRef(identity.UserId),
            true,
            capability,
            postcondition,
            fields));
        identities.Add(new AccountFixtureEntityIdentity(
            "preference",
            UserRef(identity.UserId),
            reader.FixedLocale,
            capability));
    }

    private static RequestContext ValidateRequest(AccountProfilePreferenceFixtureRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        string[] capabilities = request.Capabilities
            .Select(value => value?.Trim() ?? string.Empty)
            .Where(value => value.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (capabilities.Length == 0
            || capabilities.Any(capability => !AccountProfilePreferenceFixtureCapabilities.All.Contains(capability)))
        {
            throw new InvalidOperationException("unknown or empty account profile/preference capability set");
        }
        if (!SafeIdentity(request.Namespace)
            || !SafeIdentity(request.RunId)
            || !SafeIdentity(request.Owner))
        {
            throw new InvalidOperationException("fixture namespace, run, and owner identities are required");
        }

        if (request.ResolvedTemporalRoles is not JsonElement
            {
                ValueKind: JsonValueKind.Object
            } temporalArtifact)
        {
            throw new InvalidOperationException("resolved temporal role artifact is required");
        }
        string temporalDigest = temporalArtifact.GetProperty("contentDigest").GetString()
            ?? throw new InvalidOperationException("resolved temporal role artifact digest is required");
        ResolvedTemporalRoleContext temporalRoles = ResolvedTemporalRoleContext.Parse(
            temporalArtifact.GetRawText(),
            temporalDigest);
        if (temporalRoles.ProducerId != ProducerId
            || temporalRoles.SchedulerRunId != request.RunId)
        {
            throw new InvalidOperationException(
                "resolved temporal role artifact is cross-producer or cross-run");
        }

        var identities = new Dictionary<string, AccountFixtureIdentityReference>(StringComparer.Ordinal);
        foreach (AccountFixtureIdentityReference identity in request.IdentityReferences)
        {
            if (!SafeIdentity(identity.SemanticRole)
                || identity.UserId <= 0
                || identity.Namespace != request.Namespace
                || identity.RunId != request.RunId
                || identity.Owner != request.Owner
                || !IsSha256(identity.IdentityDigest)
                || !IsSha256(identity.SessionDigest)
                || !identities.TryAdd(identity.SemanticRole, identity))
            {
                throw new InvalidOperationException("identity reference is stale, cross-run, duplicate, or unverified");
            }
        }
        return new RequestContext(
            capabilities,
            identities,
            temporalRoles.RequireInstant("profile.updated"),
            temporalRoles.RequireInstant("preference.revision"),
            temporalRoles.RequireInstant("preference.conflict"),
            temporalRoles.RequireInstant("preference.device-sync"));
    }

    private static void RequireExistingIdentity(
        AccountProfilePreferenceObservedState state,
        AccountFixtureIdentityReference identity)
    {
        if (!state.Exists)
        {
            throw new InvalidOperationException($"verified identity role {identity.SemanticRole} does not exist");
        }
    }

    private static AccountFixtureCleanupState CleanupState(
        AccountFixtureIdentityReference identity,
        AccountProfilePreferenceObservedState before)
        => new(
            identity.SemanticRole,
            identity.UserId,
            identity.IdentityDigest,
            before.SecurityStateDigest,
            false,
            before.PublicHandle,
            false,
            before.Preference,
            before.PreferenceExists,
            null);

    private static string DeriveHandle(
        AccountProfilePreferenceFixtureRequest request,
        string semanticRole)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(
            string.Join('|', request.Namespace, request.RunId, request.Owner, semanticRole)));
        return string.Concat("fx", Convert.ToHexStringLower(hash.AsSpan(0, 8)));
    }

    private static bool SamePreference(
        UserLocalePreferenceDto left,
        UserLocalePreferenceDto right)
        => left.Mode == right.Mode
            && left.FixedLocale == right.FixedLocale
            && left.Revision == right.Revision
            && left.UpdatedAt.ToUniversalTime() == right.UpdatedAt.ToUniversalTime();

    private static string UserRef(int userId)
        => string.Concat("user-", userId.ToString(CultureInfo.InvariantCulture));

    private static int ParseUserRef(string userRef)
        => userRef.StartsWith("user-", StringComparison.Ordinal)
            && int.TryParse(userRef.AsSpan(5), NumberStyles.None, CultureInfo.InvariantCulture, out int userId)
            && userId > 0
                ? userId
                : throw new InvalidOperationException("fixture result contains an invalid user reference");

    private static bool SafeIdentity(string value)
        => !string.IsNullOrWhiteSpace(value)
            && value.Length <= 96
            && value.All(character => char.IsAsciiLetterOrDigit(character)
                || character is '-' or '_' or ':' or '.');

    private static bool IsSha256(string value)
        => value.Length == 64 && value.All(char.IsAsciiHexDigit);

    private static string? ReadNullableString(
        IReadOnlyDictionary<string, object?> fields,
        string key)
    {
        object? value = fields[key];
        return value switch
        {
            null => null,
            string text => text,
            JsonElement { ValueKind: JsonValueKind.Null } => null,
            JsonElement { ValueKind: JsonValueKind.String } element => element.GetString(),
            _ => throw new InvalidOperationException($"fixture field {key} is not a nullable string")
        };
    }

    private static long ReadInt64(
        IReadOnlyDictionary<string, object?> fields,
        string key)
    {
        object? value = fields[key];
        return value switch
        {
            long number => number,
            int number => number,
            JsonElement { ValueKind: JsonValueKind.Number } element
                when element.TryGetInt64(out long number) => number,
            _ => throw new InvalidOperationException($"fixture field {key} is not an integer")
        };
    }

    private static string ComputeResultDigest(
        string fixtureNamespace,
        string runId,
        string owner,
        IReadOnlyList<string> capabilities,
        IReadOnlyList<AccountFixtureEntityIdentity> identities,
        AccountFixtureObservations observations,
        IReadOnlyList<AccountLocaleDeviceProjection> projections,
        IReadOnlyList<AccountFixtureCleanupState> cleanupState)
    {
        byte[] canonical = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schema = "fsusblog.account-profile-preference-fixture-result.v1",
            producerId = ProducerId,
            strategy = Strategy,
            Namespace = fixtureNamespace,
            RunId = runId,
            Owner = owner,
            localeCatalogDigest = LocaleCatalog.Digest,
            capabilities,
            identities,
            observations,
            projections,
            cleanupState
        });
        return Convert.ToHexStringLower(SHA256.HashData(canonical));
    }

    private static void ValidateResultBindings(AccountProfilePreferenceFixtureResult result)
    {
        if (!SafeIdentity(result.Namespace)
            || !SafeIdentity(result.RunId)
            || !SafeIdentity(result.Owner)
            || result.Observations.Database.Namespace != result.Namespace
            || result.Observations.Cache.Namespace != result.Namespace
            || result.Observations.Database.SchemaIdentity != "public")
        {
            throw new InvalidOperationException("fixture result namespace or schema binding is invalid");
        }

        string[] capabilities = result.ProvidedCapabilities
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (!capabilities.SequenceEqual(result.ProvidedCapabilities, StringComparer.Ordinal)
            || result.Observations.Database.Entities.Count != capabilities.Length
            || result.EntityIdentities.Count != capabilities.Length)
        {
            throw new InvalidOperationException("fixture result capability cardinality is invalid");
        }

        Dictionary<int, AccountFixtureCleanupState> cleanupByUser;
        try
        {
            cleanupByUser = result.CleanupState.ToDictionary(item => item.UserId);
        }
        catch (ArgumentException exception)
        {
            throw new InvalidOperationException("fixture cleanup contains duplicate user ownership", exception);
        }
        if (cleanupByUser.Count != result.CleanupState.Count
            || result.CleanupState.Any(item => !SafeIdentity(item.SemanticRole)
                || item.UserId <= 0
                || !IsSha256(item.IdentityDigest)
                || !IsSha256(item.SecurityStateDigest)))
        {
            throw new InvalidOperationException("fixture cleanup ownership binding is invalid");
        }

        foreach (AccountFixtureObservedEntity entity in result.Observations.Database.Entities)
        {
            int userId = ParseUserRef(entity.Id);
            if (!entity.Owned
                || !AccountProfilePreferenceFixtureCapabilities.Postconditions.TryGetValue(
                    entity.CapabilityHint,
                    out string? expectedPostcondition)
                || entity.PostconditionId != expectedPostcondition
                || !cleanupByUser.TryGetValue(userId, out AccountFixtureCleanupState? cleanup)
                || ReadNullableString(entity.Fields, "identityDigest") != cleanup.IdentityDigest
                || !IsSha256(ReadNullableString(entity.Fields, "sessionDigest") ?? string.Empty)
                || ReadNullableString(entity.Fields, "securityStateDigest") != cleanup.SecurityStateDigest
                || !result.EntityIdentities.Any(identity => identity.Kind == entity.Kind
                    && identity.Id == entity.Id
                    && identity.CapabilityHint == entity.CapabilityHint))
            {
                throw new InvalidOperationException(
                    $"fixture entity {entity.Id} is not bound to exact capability ownership");
            }
        }

        foreach (AccountLocaleDeviceProjection projection in result.DeviceProjections)
        {
            if (projection.CatalogDigest != LocaleCatalog.Digest
                || !result.Observations.Database.Entities.Any(entity => entity.Kind == "preference"
                    && entity.Id == projection.UserRef
                    && entity.CapabilityHint == projection.CapabilityId))
            {
                throw new InvalidOperationException("fixture device projection is not bound to an owned preference");
            }
        }
    }

    private sealed record PreferenceMutation(
        AccountProfilePreferenceObservedState StateBefore,
        UserLocalePreferenceDto Committed);

    private sealed record RequestContext(
        IReadOnlyList<string> Capabilities,
        IReadOnlyDictionary<string, AccountFixtureIdentityReference> IdentityReferences,
        DateTimeOffset ProfileUpdatedInstant,
        DateTimeOffset PreferenceRevisionInstant,
        DateTimeOffset PreferenceConflictInstant,
        DateTimeOffset PreferenceDeviceSyncInstant)
    {
        public AccountFixtureIdentityReference RequireIdentity(string semanticRole)
            => IdentityReferences.TryGetValue(semanticRole, out AccountFixtureIdentityReference? identity)
                ? identity
                : throw new InvalidOperationException(
                    $"capability requires verified identity semantic role {semanticRole}");
    }
}
