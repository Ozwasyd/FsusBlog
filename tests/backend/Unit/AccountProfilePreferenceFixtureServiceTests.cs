using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Shared.Contracts.Localization;
using FsusBlog.Shared.Contracts.Outputs;

using NSubstitute;

namespace FsusBlog.Server.Tests;

public sealed class AccountProfilePreferenceFixtureServiceTests
{
    [Fact]
    public async Task Prepare_VerifiesCompleteProfileAndPreferenceMatrix_AndCleansOwnedFields()
    {
        FixtureHarness harness = new();
        AccountProfilePreferenceFixtureRequest request = harness.FullRequest();

        AccountProfilePreferenceFixtureResult result = await harness.Service.PrepareAsync(request);
        AccountProfilePreferenceFixtureVerification verification = await harness.Service.VerifyAsync(result);

        Assert.True(verification.Ok, verification.Failure);
        Assert.Equal(10, result.ProvidedCapabilities.Count);
        Assert.Equal(10, result.Observations.Database.Entities.Count);
        Assert.Equal(LocaleCatalog.Digest, result.LocaleCatalogDigest);
        Assert.All(result.Observations.Database.Entities, entity =>
        {
            Assert.True(entity.Owned);
            Assert.Equal(true, entity.Fields["readerMatchesDatabase"]);
            Assert.Equal(true, entity.Fields["securityStateUnchanged"]);
        });

        AccountFixtureObservedEntity profileConflict = Assert.Single(
            result.Observations.Database.Entities,
            entity => entity.PostconditionId == "profile-public-handle-conflict");
        Assert.Equal("conflict", profileConflict.Fields["conflictErrorCode"]);
        Assert.Equal(true, profileConflict.Fields["challengerPreserved"]);

        AccountFixtureObservedEntity revisionConflict = Assert.Single(
            result.Observations.Database.Entities,
            entity => entity.PostconditionId == "preference-locale-revision-conflict");
        Assert.Equal("locale_preference_revision_conflict", revisionConflict.Fields["conflictErrorCode"]);
        Assert.Equal(true, revisionConflict.Fields["newerValuePreserved"]);

        AccountFixtureObservedEntity twoDevice = Assert.Single(
            result.Observations.Database.Entities,
            entity => entity.PostconditionId == "preference-locale-two-device-sync");
        Assert.Equal(2, twoDevice.Fields["deviceProjectionCount"]);
        Assert.Equal(2, result.DeviceProjections.Count(projection =>
            projection.CapabilityId == AccountProfilePreferenceFixtureCapabilities.LocaleTwoDeviceSync));

        AccountLocaleDeviceProjection accountDeviceConflict = Assert.Single(
            result.DeviceProjections,
            projection => projection.CapabilityId == AccountProfilePreferenceFixtureCapabilities.LocaleAccountDeviceConflict);
        Assert.NotEqual(accountDeviceConflict.AccountLocale, accountDeviceConflict.IncomingDeviceLocale);
        Assert.Equal(accountDeviceConflict.AccountLocale, accountDeviceConflict.ExplicitCookieLocale);
        Assert.Equal(accountDeviceConflict.AccountLocale, accountDeviceConflict.ResolvedLocale);

        Assert.All(harness.States.Values, state => Assert.Equal(state.InitialSecurityDigest, state.SecurityDigest));

        await harness.Service.CleanupAsync(result);

        Assert.All(harness.States.Values, state =>
        {
            Assert.Equal(state.InitialPublicHandle, state.PublicHandle);
            Assert.Equal(state.InitialPreferenceExists, state.PreferenceExists);
            Assert.Equal(state.InitialPreference, state.Preference);
            Assert.Equal(state.InitialSecurityDigest, state.SecurityDigest);
        });
    }

    [Fact]
    public async Task ProfileOnly_DoesNotMutatePreferenceOrAuthState()
    {
        FixtureHarness harness = new();
        AccountProfilePreferenceFixtureRequest request = harness.Request(
            [AccountProfilePreferenceFixtureCapabilities.ProfileSet],
            ["profile-set"]);

        AccountProfilePreferenceFixtureResult result = await harness.Service.PrepareAsync(request);

        MutableState state = harness.States[request.IdentityReferences[0].UserId];
        Assert.False(state.PreferenceExists);
        Assert.Equal(state.InitialSecurityDigest, state.SecurityDigest);
        Assert.Single(result.Observations.Database.Entities);
        Assert.Equal(false, result.Observations.Database.Entities[0].Fields["preferenceMutation"]);
    }

    [Fact]
    public async Task Prepare_RejectsUnknownCapabilityAndCrossRunIdentity()
    {
        FixtureHarness harness = new();
        AccountProfilePreferenceFixtureRequest unknown = harness.Request(
            ["preferences.locale.fixed.unknown"],
            ["preference-fixed-default"]);
        await Assert.ThrowsAsync<InvalidOperationException>(() => harness.Service.PrepareAsync(unknown));

        AccountProfilePreferenceFixtureRequest valid = harness.Request(
            [AccountProfilePreferenceFixtureCapabilities.LocaleFixedDefault],
            ["preference-fixed-default"]);
        AccountFixtureIdentityReference stale = valid.IdentityReferences[0] with
        {
            RunId = "other-run"
        };
        await Assert.ThrowsAsync<InvalidOperationException>(() => harness.Service.PrepareAsync(
            valid with
            {
                IdentityReferences = [stale]
            }));
    }

    [Fact]
    public async Task Verify_RejectsReceiptTamper()
    {
        FixtureHarness harness = new();
        AccountProfilePreferenceFixtureResult result = await harness.Service.PrepareAsync(harness.Request(
            [AccountProfilePreferenceFixtureCapabilities.LocaleRevisionConflict],
            ["preference-revision-conflict"]));

        AccountProfilePreferenceFixtureVerification verification = await harness.Service.VerifyAsync(
            result with
            {
                Owner = "fxacct:tampered"
            });

        Assert.False(verification.Ok);
        Assert.Contains("identity or catalog binding", verification.Failure, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Verify_AcceptsExactJsonTransportRoundTrip()
    {
        FixtureHarness harness = new();
        AccountProfilePreferenceFixtureResult result = await harness.Service.PrepareAsync(harness.Request(
            [AccountProfilePreferenceFixtureCapabilities.LocaleRevisionConflict],
            ["preference-revision-conflict"]));
        JsonSerializerOptions options = new(JsonSerializerDefaults.Web);
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(result, options);
        AccountProfilePreferenceFixtureResult transported = JsonSerializer.Deserialize<AccountProfilePreferenceFixtureResult>(
            payload,
            options)!;

        AccountProfilePreferenceFixtureVerification verification = await harness.Service.VerifyAsync(transported);

        Assert.True(verification.Ok, verification.Failure);
        Assert.Equal(result.ContentDigest, verification.ContentDigest);
    }

    private sealed class FixtureHarness
    {
        private const string Namespace = "account-profile-test";
        private const string RunId = "run-1717";
        private const string Owner = "fxacct:account-profile-test:run-1717";
        private int _nextUserId = 100;

        public FixtureHarness()
        {
            ProfileCommands = Substitute.For<IUserProfileCommandService>();
            AccountReader = Substitute.For<IUserAccountReader>();
            PreferenceCommands = Substitute.For<IAccountPreferenceFixtureCommand>();
            PreferenceReader = Substitute.For<IUserLocalePreferenceReader>();
            StateReader = Substitute.For<IAccountProfilePreferenceFixtureStateReader>();

            StateReader.ReadAsync(Arg.Any<int>(), Arg.Any<CancellationToken>())
                .Returns(call => Task.FromResult(Observed(States[(int)call[0]])));
            StateReader.CountHandleOwnersAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(call => Task.FromResult(States.Values.Count(state => state.PublicHandle == (string)call[0])));
            AccountReader.GetAccountByIdAsync(Arg.Any<int>())
                .Returns(call => Task.FromResult<UserAccountSnapshot?>(Account(States[(int)call[0]])));
            PreferenceReader.GetAsync(Arg.Any<int>(), Arg.Any<CancellationToken>())
                .Returns(call => Task.FromResult(States[(int)call[0]].Preference));

            ProfileCommands.UpdatePublicHandleAsync(
                    Arg.Any<int>(),
                    Arg.Any<string?>(),
                    Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    int userId = (int)call[0];
                    string? handle = call[1] as string;
                    if (handle is not null && States.Values.Any(state =>
                        state.UserId != userId && state.PublicHandle == handle))
                    {
                        return Task.FromResult((false, "公開稱呼已被佔用"));
                    }
                    MutableState state = States[userId];
                    state.PublicHandle = handle;
                    state.ProfileRevision++;
                    return Task.FromResult((true, "ok"));
                });
            PreferenceCommands.UpdateAtAsync(
                    Arg.Any<int>(),
                    Arg.Any<UserLocalePreferenceUpdateDto>(),
                    Arg.Any<DateTimeOffset>(),
                    Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    int userId = (int)call[0];
                    UserLocalePreferenceUpdateDto command = (UserLocalePreferenceUpdateDto)call[1];
                    DateTimeOffset updatedAt = (DateTimeOffset)call[2];
                    MutableState state = States[userId];
                    if (command.ExpectedRevision != state.Preference.Revision)
                    {
                        return Task.FromResult(new UserLocalePreferenceUpdateResult(
                            UserLocalePreferenceUpdateOutcome.RevisionConflict,
                            null,
                            state.Preference,
                            state.PreferenceExists));
                    }
                    if (command.Mode == LocalePreferenceModes.Fixed
                        && (!LocaleCatalog.TryParse(command.FixedLocale, out LocaleDescriptor descriptor)
                            || descriptor.Code != command.FixedLocale))
                    {
                        return Task.FromResult(new UserLocalePreferenceUpdateResult(
                            UserLocalePreferenceUpdateOutcome.InvalidLocale,
                            null,
                            state.Preference,
                            state.PreferenceExists));
                    }
                    UserLocalePreferenceDto previous = state.Preference;
                    bool existed = state.PreferenceExists;
                    state.Preference = new UserLocalePreferenceDto(
                        command.Mode,
                        command.FixedLocale,
                        checked(previous.Revision + 1),
                        updatedAt.UtcDateTime);
                    state.PreferenceExists = true;
                    return Task.FromResult(new UserLocalePreferenceUpdateResult(
                        UserLocalePreferenceUpdateOutcome.Success,
                        state.Preference,
                        previous,
                        existed));
                });
            PreferenceCommands.CompensateAsync(
                    Arg.Any<int>(),
                    Arg.Any<UserLocalePreferenceDto>(),
                    Arg.Any<UserLocalePreferenceDto>(),
                    Arg.Any<bool>(),
                    Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    MutableState state = States[(int)call[0]];
                    UserLocalePreferenceDto committed = (UserLocalePreferenceDto)call[1];
                    if (state.Preference != committed)
                    {
                        return Task.FromResult(false);
                    }
                    state.Preference = (UserLocalePreferenceDto)call[2];
                    state.PreferenceExists = (bool)call[3];
                    return Task.FromResult(true);
                });

            Service = new AccountProfilePreferenceFixtureService(
                ProfileCommands,
                AccountReader,
                PreferenceCommands,
                PreferenceReader,
                new LocaleResolver(),
                StateReader);
        }

        public Dictionary<int, MutableState> States { get; } = [];
        public IUserProfileCommandService ProfileCommands
        {
            get;
        }
        public IUserAccountReader AccountReader
        {
            get;
        }
        public IAccountPreferenceFixtureCommand PreferenceCommands
        {
            get;
        }
        public IUserLocalePreferenceReader PreferenceReader
        {
            get;
        }
        public IAccountProfilePreferenceFixtureStateReader StateReader
        {
            get;
        }
        public AccountProfilePreferenceFixtureService Service
        {
            get;
        }

        public AccountProfilePreferenceFixtureRequest FullRequest()
            => Request(
                AccountProfilePreferenceFixtureCapabilities.All.Order(StringComparer.Ordinal).ToArray(),
                [
                    "preference-account-device-conflict",
                    "preference-auto",
                    "preference-device-explicit",
                    "preference-fixed-default",
                    "preference-fixed-non-default",
                    "preference-revision-conflict",
                    "preference-two-device",
                    "profile-conflict-challenger",
                    "profile-conflict-owner",
                    "profile-empty",
                    "profile-set"
                ]);

        public AccountProfilePreferenceFixtureRequest Request(
            IReadOnlyList<string> capabilities,
            IReadOnlyList<string> roles)
        {
            AccountFixtureIdentityReference[] identities = roles.Select(role =>
            {
                MutableState state = AddState(role);
                if (role == "profile-conflict-challenger")
                {
                    state.PublicHandle = "externalowned";
                    state.InitialPublicHandle = state.PublicHandle;
                }
                return new AccountFixtureIdentityReference(
                    role,
                    state.UserId,
                    Digest($"identity:{role}"),
                    Digest($"session:{role}"),
                    Namespace,
                    RunId,
                    Owner,
                    role == "preference-two-device" ? ["device-a", "device-b"] : ["device-primary"]);
            }).ToArray();
            return new AccountProfilePreferenceFixtureRequest(
                capabilities,
                Namespace,
                RunId,
                Owner,
                identities,
                ResolvedTemporalRoles: TemporalArtifact());
        }

        private static JsonElement TemporalArtifact()
            => JsonSerializer.SerializeToElement(new
            {
                schema = "fsusblog.resolved-temporal-roles.v1",
                contextIdentity = new
                {
                    producerId = "account-profile-preferences",
                    schedulerRunId = RunId
                },
                roles = new[]
                {
                    Role("profile.updated", "2024-03-01T00:00:59.000Z"),
                    Role("preference.revision", "2024-03-01T00:01:59.000Z"),
                    Role("preference.conflict", "2024-03-01T00:01:59.000Z"),
                    Role("preference.device-sync", "2024-03-01T00:02:59.000Z")
                },
                contentDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            });

        private static object Role(string roleId, string instantUtc)
            => new
            {
                roleId,
                clockKind = "business-wall",
                semanticEffect = "included",
                precision = "millisecond",
                instantUtc
            };

        private MutableState AddState(string role)
        {
            var state = new MutableState(++_nextUserId, Digest($"security:{role}"));
            States.Add(state.UserId, state);
            return state;
        }

        private static AccountProfilePreferenceObservedState Observed(MutableState state)
            => new(
                state.UserId,
                true,
                state.PublicHandle,
                state.ProfileRevision,
                0,
                false,
                false,
                false,
                0,
                1,
                state.PreferenceExists,
                state.Preference,
                state.SecurityDigest);

        private static UserAccountSnapshot Account(MutableState state)
            => new(
                state.UserId,
                0,
                null,
                false,
                null,
                state.PublicHandle,
                AnonymousIdentityRuntime.AnonymousAccountKind,
                false,
                false,
                "active",
                "basic",
                Digest($"subject:{state.UserId}"));

        private static string Digest(string value)
            => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    }

    private sealed class MutableState(int userId, string securityDigest)
    {
        public int UserId { get; } = userId;
        public string? InitialPublicHandle
        {
            get; set;
        }
        public string? PublicHandle
        {
            get; set;
        }
        public long ProfileRevision
        {
            get; set;
        }
        public bool InitialPreferenceExists { get; } = false;
        public bool PreferenceExists
        {
            get; set;
        }
        public UserLocalePreferenceDto InitialPreference
        {
            get;
        } =
            new(LocalePreferenceModes.Auto, null, 0, DateTime.UnixEpoch);
        public UserLocalePreferenceDto Preference
        {
            get; set;
        } =
            new(LocalePreferenceModes.Auto, null, 0, DateTime.UnixEpoch);
        public string InitialSecurityDigest { get; } = securityDigest;
        public string SecurityDigest { get; } = securityDigest;
    }
}
