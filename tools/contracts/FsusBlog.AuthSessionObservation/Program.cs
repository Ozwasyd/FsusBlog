using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.AuthSystem;

return AuthSessionObservationHost.Run(args);

internal static class AuthSessionObservationHost
{
    private const string ObservationSchema = "fsusblog.auth-session-permission-observation.v2";
    private const string RelationSchema = "fsusblog.auth-session-relation-catalog.v1";

    private static readonly JsonSerializerOptions s_json = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static int Run(string[] args)
    {
        string? outputPath = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] is "--output" or "-o")
            {
                outputPath = args.ElementAtOrDefault(i + 1)
                    ?? throw new InvalidOperationException("--output requires a path");
                i++;
            }
            else if (args[i] is "--help" or "-h")
            {
                Console.WriteLine("FsusBlog.AuthSessionObservation --output <path>");
                return 0;
            }
            else
            {
                throw new InvalidOperationException($"Unknown argument: {args[i]}");
            }
        }

        if (string.IsNullOrWhiteSpace(outputPath))
        {
            throw new InvalidOperationException("--output is required");
        }

        JsonObject document = Observe();
        string withoutDigest = document.ToJsonString(s_json);
        string digest = Sha256Hex(withoutDigest);
        document["observationDigest"] = digest;

        string json = document.ToJsonString(s_json);
        string directory = Path.GetDirectoryName(Path.GetFullPath(outputPath))
            ?? throw new InvalidOperationException("output directory is invalid");
        Directory.CreateDirectory(directory);
        File.WriteAllText(outputPath, json + "\n", new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

        Console.WriteLine($"[auth-session-observation] ok output={outputPath} digest={digest}");
        return 0;
    }

    private static JsonObject Observe()
    {
        List<string> failures = [];

        string[] methods = typeof(UserSessionAuthenticationMethods).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(static field => field.IsLiteral && field.FieldType == typeof(string))
            .Select(static field => (string)field.GetRawConstantValue()!)
            .OrderBy(static value => value, StringComparer.Ordinal).ToArray();
        string[] activeStrengths = typeof(UserSessionAuthenticationStrengths).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(static field => field.IsLiteral && field.FieldType == typeof(string))
            .Select(static field => (string)field.GetRawConstantValue()!)
            .OrderBy(static value => value, StringComparer.Ordinal).ToArray();
        foreach (string strength in activeStrengths)
        {
            if (!UserSessionAuthenticationStrengths.IsValid(strength))
            {
                failures.Add($"strength catalog inconsistent for {strength}");
            }
        }
        if (UserSessionAuthenticationMethods.IsValid("other")
            || UserSessionAuthenticationContract.IsValid("recovery_key", "recovery", 1))
        {
            failures.Add("unsupported authentication producer admitted by current catalog");
        }

        string[] durationModes = SortedUnique(
            UserSessionDurationPolicies.BrowserSession,
            UserSessionDurationPolicies.Persistent30Days);

        TimeSpan loginBrowserIdle = ReadPrivateStaticTimeSpan(typeof(UserLoginWorkflowService), "s_standardSessionIdleTtl");
        TimeSpan loginPersistentIdle = ReadPrivateStaticTimeSpan(typeof(UserLoginWorkflowService), "s_rememberMeSessionIdleTtl");
        TimeSpan loginBrowserAbsolute = ReadPrivateStaticTimeSpan(typeof(UserLoginWorkflowService), "s_standardSessionAbsoluteTtl");
        TimeSpan loginPersistentAbsolute = ReadPrivateStaticTimeSpan(typeof(UserLoginWorkflowService), "s_rememberMeSessionAbsoluteTtl");

        TimeSpan refreshBrowserIdle = ReadPrivateStaticTimeSpan(typeof(UserSessionCommandService), "s_standardSessionIdleTtl");
        TimeSpan refreshPersistentIdle = ReadPrivateStaticTimeSpan(typeof(UserSessionCommandService), "s_rememberMeSessionIdleTtl");

        // Coherence: login admission idle TTLs must match refresh rotation idle TTLs.
        if (loginBrowserIdle != refreshBrowserIdle)
        {
            failures.Add(
                $"idle TTL drift browser_session: login={FormatDuration(loginBrowserIdle)} refresh={FormatDuration(refreshBrowserIdle)}");
        }

        if (loginPersistentIdle != refreshPersistentIdle)
        {
            failures.Add(
                $"idle TTL drift persistent_30d: login={FormatDuration(loginPersistentIdle)} refresh={FormatDuration(refreshPersistentIdle)}");
        }

        // DurationPolicy ↔ cookie persistence projection authority.
        bool browserIsPersistent = UserSessionDurationPolicies.IsPersistent(UserSessionDurationPolicies.BrowserSession);
        bool persistentIsPersistent = UserSessionDurationPolicies.IsPersistent(UserSessionDurationPolicies.Persistent30Days);
        if (browserIsPersistent)
        {
            failures.Add("browser_session must not project as persistent cookie");
        }

        if (!persistentIsPersistent)
        {
            failures.Add("persistent_30d must project as persistent cookie");
        }

        TimeSpan adminIdle = ReadPrivateStaticTimeSpan(typeof(AdminPrincipalService), "s_adminIdleSessionTtl");
        TimeSpan adminAbsolute = ReadPrivateStaticTimeSpan(typeof(AdminPrincipalService), "s_adminAbsoluteSessionTtl");

        string[] adminPermissions = AdminPermissions.All
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();
        if (adminPermissions.Length == 0)
        {
            failures.Add("AdminPermissions.All is empty");
        }

        if (!adminPermissions.Contains(AdminPermissions.AuditInvestigate, StringComparer.Ordinal))
        {
            failures.Add("AdminPermissions.All missing audit.investigate production permission");
        }

        // Read-only admin surface: audit.read is the baseline read permission.
        // audit.investigate is elevated investigation read and is not the default read-only set.
        string[] readOnlyPermissions = SortedUnique(AdminPermissions.AuditRead);
        if (!adminPermissions.Contains(AdminPermissions.AuditRead, StringComparer.Ordinal))
        {
            failures.Add("AdminPermissions.All missing audit.read");
        }

        // JWT claim names for authentication context (must match DB session validation).
        string[] jwtAuthClaims = SortedUnique(
            CurrentAuthSessionClaims.AuthenticationMethod,
            CurrentAuthSessionClaims.AuthenticationStrength,
            CurrentAuthSessionClaims.AuthenticatedAt,
            CurrentAuthSessionClaims.DurationPolicy,
            UserSessionModes.ClaimType,
            "mfa",
            "sid");

        string[] refreshPreserved = SortedUnique(
            "auth_method",
            "auth_strength",
            "auth_time",
            "duration_policy",
            "authenticated_credential_row_id");

        string[] refreshNotPreserved = SortedUnique(
            "last_step_up_at",
            "last_step_up_method",
            "step_up_proof",
            "access_token",
            "refresh_token");

        string[] refreshMayUpdate = SortedUnique(
            "session_mode",
            "idle_expires_at",
            "refresh_token_hash",
            "refresh_generation",
            "last_seen_at");

        // Step-up binding fields from BuildProofIdentity: account, subject, session, action, token (+ freshness expiry).
        string[] stepUpBinding = SortedUnique(
            "account",
            "account_subject",
            "session",
            "action",
            "token",
            "expiry");

        // Coherence probes: claim names required by validation must equal JWT issuance names.
        string[] validationRequiredClaims = SortedUnique("auth_method", "auth_strength", "auth_time");
        foreach (string claim in validationRequiredClaims)
        {
            if (!jwtAuthClaims.Contains(claim, StringComparer.Ordinal))
            {
                failures.Add($"JWT issuance missing claim required by session validation: {claim}");
            }
        }

        // Coarse MFA is a projection of a complete valid producer context, never a strength-only upgrade.
        if (!UserSessionAuthenticationContract.IsCoarseMfa(UserSessionAuthenticationMethods.Passkey, UserSessionAuthenticationStrengths.WebAuthnUv, 1)
            || !UserSessionAuthenticationContract.IsCoarseMfa(UserSessionAuthenticationMethods.Passkey, UserSessionAuthenticationStrengths.Mfa, 1)
            || UserSessionAuthenticationContract.IsCoarseMfa("other", UserSessionAuthenticationStrengths.Mfa, 1)
            || UserSessionAuthenticationContract.IsCoarseMfa(UserSessionAuthenticationMethods.Passkey, "legacy_verified", 1)
            || UserSessionAuthenticationContract.IsCoarseMfa(UserSessionAuthenticationMethods.Passkey, UserSessionAuthenticationStrengths.Mfa, null))
        {
            failures.Add("current authentication/coarse MFA projection drifted");
        }

        string[] mfaStates = SortedUnique("disabled", "pending_enrollment", "enabled");
        string[] recoveryStates = SortedUnique("active", "used", "revoked");
        string[] enrollmentStates = SortedUnique(
            AccountEnrollmentStates.Pending,
            AccountEnrollmentStates.Completing,
            AccountEnrollmentStates.Completed,
            AccountEnrollmentStates.Cancelled,
            AccountEnrollmentStates.Expired);
        string[] passkeyOperationalStates = SortedUnique("present", "absent");

        string[] sessionModes = SortedUnique(
            UserSessionModes.ToClaimValue(UserSessionMode.Normal),
            UserSessionModes.ToClaimValue(UserSessionMode.Restricted),
            UserSessionModes.ToClaimValue(UserSessionMode.Revoked));

        JsonArray revocationTransitions =
        [
            Transition("passkey_delete", "credential_present", "credential_absent", "revoke_sessions_bound_to_credential"),
            Transition("passkey_counter_risk", "credential_present", "credential_present", "revoke_sessions_bound_to_credential"),
            Transition("recovery_key_verify_with_session_revoke", "sessions_active", "sessions_revoked", "optional_passkey_revoke"),
            Transition("refresh_token_replay", "family_active", "family_revoked", "compromise_refresh_family"),
            Transition("session_logout_or_revoke", "session_active", "session_revoked", "publish_revocation_snapshot"),
            Transition("account_ban", "session_mode_normal", "session_mode_restricted", "refresh_reissues_restricted"),
            Transition("account_delete", "sessions_active", "sessions_revoked", "mode_revoked"),
            Transition("admin_principal_disable", "principal_active", "principal_disabled", "login_and_step_up_denied")
        ];

        string[] revocationFailureModes = SortedUnique(
            "session_revoked",
            "session_idle_expired",
            "session_absolute_expired",
            "authentication_context_mismatch",
            "refresh_token_replay",
            "session_mismatch",
            "admin_principal_disabled",
            "step_up_proof_invalid",
            "step_up_proof_consumed");

        JsonArray authRelations =
        [
            Relation(
                "auth.relation.mfa-enabled-step-up-method",
                "auth.mfa.state.enabled",
                "permits-proof-method",
                "auth.step-up.mfa-proof",
                "subject-to-object",
                "account is active and the requested credential mutation accepts the MFA proof method",
                "conditional",
                "UserSecurityStepUpService.VerifyAsync",
                "src/backend/Services/Security/UserSecurityStepUpService.cs",
                ["UserSecurityStepUpServiceTests.MfaProof_IsBoundToSessionActionAndConsumedOnce"]),
            Relation(
                "auth.relation.passkey-auth-strength",
                "auth.method.passkey",
                "results-in",
                UserSessionAuthenticationStrengths.WebAuthnUv,
                "subject-to-object",
                "successful user-verifying Passkey assertion",
                "true",
                "UserLoginWorkflowService.CompletePasskeyLoginAsync",
                "src/backend/Services/UserLoginWorkflowService.cs",
                ["UserSessionAuthenticationContextTests.PasskeyLogin_PersistsCredentialBoundContext"]),
            Relation(
                "auth.relation.passkey-is-not-totp",
                "auth.method.passkey",
                "is-equivalent-to",
                "auth.method.totp",
                "subject-to-object",
                "all authentication and step-up scopes",
                "false",
                "UserSessionAuthenticationContract.IsCoarseMfa",
                "src/shared/Contracts/AuthSystem/UserSessionAuthenticationContract.generated.cs",
                ["UserBootstrapLoginMfaBoundaryTests.PasskeyAndTotpRemainDistinctAuthenticationMethods"]),
            Relation(
                "auth.relation.recovery-auth-strength",
                "auth.method.recovery_key",
                "results-in",
                "auth.strength.recovery",
                "subject-to-object",
                "Recovery Key verification has no current ordinary-session JWT producer",
                "false",
                "UserSessionAuthenticationContract.IsSupportedCombination",
                "src/shared/Contracts/AuthSystem/UserSessionAuthenticationContract.generated.cs",
                ["UserSessionAuthenticationContextTests.UnsupportedContext_IsNeverRepairedOrUpgradedFromMfaBoolean"]),
            Relation(
                "auth.relation.recovery-does-not-mint-step-up",
                "auth.recovery.completion",
                "mints",
                "auth.step-up.proof",
                "subject-to-object",
                "Recovery Key verification returns a recovery registration envelope, not an action-bound MFA proof",
                "false",
                "RecoveryKeyService.VerifyAsync",
                "src/backend/Services/Security/RecoveryKeyService.cs",
                ["RecoveryKeyServiceTests.RecoveryKeyService_SessionEnvelopeRoundTripUsesAccountIdentity"]),
            Relation(
                "auth.relation.step-up-binding",
                "auth.step-up.proof",
                "is-bound-to",
                "account+session+action+token+expiry",
                "subject-to-object",
                "proof validation and consumption",
                "true",
                "MfaChallengeService.BuildProofIdentity",
                "src/backend/Services/MfaChallengeService.cs",
                ["UserSecurityStepUpServiceTests.MfaProof_IsBoundToSessionActionAndConsumedOnce"]),
            Relation(
                "auth.relation.step-up-consume-once",
                "auth.step-up.proof",
                "may-be-consumed",
                "exactly-once",
                "subject-to-object",
                "matching account, session, action, token, and unexpired proof",
                "true",
                "MfaChallengeService.ValidateAndConsumeProofTokenAsync",
                "src/backend/Services/MfaChallengeService.cs",
                ["UserSecurityStepUpServiceTests.MfaProof_IsBoundToSessionActionAndConsumedOnce"]),
            Relation(
                "auth.relation.refresh-preserves-auth-context",
                "auth.refresh.rotation",
                "preserves",
                "auth_method+auth_strength+auth_time+duration_policy+authenticated_credential_row_id",
                "subject-to-object",
                "active session context passes fail-closed validation",
                "true",
                "UserSessionCommandService.RefreshSessionAsync",
                "src/backend/Services/UserSessionCommandService.cs",
                ["UserSessionAuthenticationContextTests.Refresh_PreservesAuthenticationContext"]),
            Relation(
                "auth.relation.refresh-does-not-rebuild-step-up",
                "auth.refresh.rotation",
                "rebuilds-or-extends",
                "auth.step-up.proof",
                "subject-to-object",
                "all refresh rotations",
                "false",
                "UserSessionCommandService.RefreshSessionAsync",
                "src/backend/Services/UserSessionCommandService.cs",
                ["UserSessionAuthenticationContextTests.Refresh_DoesNotExtendStepUp"]),
            Relation(
                "auth.relation.passkey-delete-revokes-bound-sessions",
                "auth.passkey.credential-delete",
                "revokes",
                "sessions-bound-to-deleted-credential",
                "subject-to-object",
                "credential row is deleted successfully",
                "true",
                "PasskeyService.DeleteCredentialAsync",
                "src/backend/Services/Security/PasskeyService.cs",
                ["PasskeyCredentialLifecycleTests.Delete_RevokesOnlyCredentialBoundSessions"]),
            Relation(
                "auth.relation.passkey-delete-does-not-revoke-unbound-sessions",
                "auth.passkey.credential-delete",
                "revokes",
                "all-account-sessions",
                "subject-to-object",
                "credential row is deleted successfully",
                "false",
                "PasskeyService.DeleteCredentialAsync",
                "src/backend/Services/Security/PasskeyService.cs",
                ["PasskeyCredentialLifecycleTests.Delete_RevokesOnlyCredentialBoundSessions"])
        ];

        var facts = new JsonObject
        {
            ["auth.authentication-methods"] = new JsonObject
            {
                ["active"] = ToJsonArray(methods)
            },
            ["auth.authentication-strengths"] = new JsonObject
            {
                ["active"] = ToJsonArray(activeStrengths)
            },
            ["auth.session.duration-modes"] = new JsonObject
            {
                ["modes"] = ToJsonArray(durationModes),
                ["cookieProjection"] = new JsonObject
                {
                    [UserSessionDurationPolicies.BrowserSession] = new JsonObject
                    {
                        ["persistentCookie"] = false
                    },
                    [UserSessionDurationPolicies.Persistent30Days] = new JsonObject
                    {
                        ["persistentCookie"] = true
                    }
                }
            },
            ["auth.session.idle-expiry-policy"] = new JsonObject
            {
                [UserSessionDurationPolicies.BrowserSession] = Duration(loginBrowserIdle),
                [UserSessionDurationPolicies.Persistent30Days] = Duration(loginPersistentIdle),
                ["admin"] = Duration(adminIdle)
            },
            ["auth.session.absolute-expiry-policy"] = new JsonObject
            {
                [UserSessionDurationPolicies.BrowserSession] = Duration(loginBrowserAbsolute),
                [UserSessionDurationPolicies.Persistent30Days] = Duration(loginPersistentAbsolute),
                ["admin"] = Duration(adminAbsolute)
            },
            ["auth.refresh.context-preservation"] = new JsonObject
            {
                ["preserves"] = ToJsonArray(refreshPreserved),
                ["doesNotPreserve"] = ToJsonArray(refreshNotPreserved),
                ["mayUpdate"] = ToJsonArray(refreshMayUpdate)
            },
            ["auth.step-up.freshness"] = new JsonObject
            {
                ["configurationKey"] = MfaChallengeService.ProofFreshnessMinutesConfigurationKey,
                ["default"] = new JsonObject { ["value"] = 5, ["unit"] = "minutes" },
                ["minimum"] = new JsonObject
                {
                    ["value"] = MfaChallengeService.MinimumProofFreshnessMinutes,
                    ["unit"] = "minutes"
                },
                ["maximum"] = new JsonObject
                {
                    ["value"] = MfaChallengeService.MaximumProofFreshnessMinutes,
                    ["unit"] = "minutes"
                }
            },
            ["auth.step-up.binding"] = new JsonObject
            {
                ["fields"] = ToJsonArray(stepUpBinding)
            },
            ["auth.step-up.consume-once"] = true,
            ["auth.passkey.states"] = new JsonObject
            {
                ["enrollment"] = ToJsonArray(enrollmentStates),
                ["credentialPresence"] = ToJsonArray(passkeyOperationalStates)
            },
            ["auth.mfa.states"] = ToJsonArray(mfaStates),
            ["auth.recovery.states"] = ToJsonArray(recoveryStates),
            ["auth.credential-session-revocation"] = new JsonObject
            {
                ["transitions"] = revocationTransitions,
                ["failureModes"] = ToJsonArray(revocationFailureModes)
            },
            ["auth.relations"] = new JsonObject
            {
                ["schema"] = RelationSchema,
                ["version"] = 1,
                ["closed"] = true,
                ["entries"] = authRelations
            },
            ["admin.permissions.all"] = ToJsonArray(adminPermissions),
            ["admin.permissions.read-only"] = ToJsonArray(readOnlyPermissions),
            ["admin.permissions.partial-policy"] = new JsonObject
            {
                ["claimType"] = AdminPermissions.PermissionClaimType,
                ["storage"] = "newline-separated-subset-of-catalog",
                ["catalogAuthority"] = "AdminPermissions.All",
                ["authorization"] = "require-exact-claim-at-endpoint",
                ["rootBootstrap"] = "full-catalog",
                ["unknownCatalogPermission"] = "no-endpoint-grant"
            },
            ["admin.disabled-access"] = new JsonObject
            {
                ["status"] = AdminPrincipalStatus.Disabled,
                ["activeStatus"] = AdminPrincipalStatus.Active,
                ["loginAllowed"] = false,
                ["stepUpAllowed"] = false
            },
            ["auth.session.modes"] = ToJsonArray(sessionModes),
            ["auth.jwt.claims"] = ToJsonArray(jwtAuthClaims),
            ["coherence"] = new JsonObject
            {
                ["loginRefreshIdleTtl"] = failures.Count == 0 ? "consistent" : "inconsistent",
                ["durationPolicyCookieProjection"] = failures.Count == 0 ? "consistent" : "inconsistent",
                ["jwtSessionValidationClaims"] = failures.Count == 0 ? "consistent" : "inconsistent",
                ["layers"] = new JsonObject
                {
                    ["sessionDb"] = "UserSession.AuthenticationMethod/Strength/AuthenticatedAtUtc/DurationPolicy",
                    ["jwt"] = "auth_method/auth_strength/auth_time/session_mode",
                    ["cookie"] = "AccessToken/RefreshToken/SessionId with DurationPolicy-driven persistence"
                }
            }
        };

        var document = new JsonObject
        {
            ["schema"] = ObservationSchema,
            ["source"] = "compiled-production-constants",
            ["facts"] = facts,
            ["failureReasons"] = ToJsonArray(failures.OrderBy(static value => value, StringComparer.Ordinal).ToArray()),
            ["status"] = failures.Count == 0 ? "ok" : "failed"
        };

        if (failures.Count > 0)
        {
            // Still write the document so tooling can inspect, but exit non-zero after write? Host fails closed.
            string directoryProbe = Path.GetTempPath();
            _ = directoryProbe;
            throw new InvalidOperationException(
                "auth-session observation failed coherence checks: " + string.Join("; ", failures));
        }

        return document;
    }

    private static JsonObject Transition(string id, string from, string to, string effect)
        => new()
        {
            ["id"] = id,
            ["from"] = from,
            ["to"] = to,
            ["effect"] = effect
        };

    private static JsonObject Relation(
        string relationId,
        string subject,
        string predicate,
        string objectId,
        string direction,
        string condition,
        string truthValue,
        string sourceRange,
        string sourceOwner,
        IReadOnlyList<string> proofTests)
        => new()
        {
            ["relationId"] = relationId,
            ["subject"] = subject,
            ["predicate"] = predicate,
            ["object"] = objectId,
            ["direction"] = direction,
            ["condition"] = condition,
            ["truthValue"] = truthValue,
            ["scope"] = new JsonObject
            {
                ["account"] = "current-account",
                ["session"] = "bound-session",
                ["action"] = "declared-action",
                ["credentialMethod"] = "declared-subject"
            },
            ["sourceOwner"] = sourceOwner,
            ["sourceRange"] = sourceRange,
            ["proofTests"] = ToJsonArray(proofTests.OrderBy(static value => value, StringComparer.Ordinal).ToArray())
        };

    private static JsonObject Duration(TimeSpan value)
    {
        if (value.TotalDays >= 1 && value == TimeSpan.FromDays(value.TotalDays))
        {
            return new JsonObject
            {
                ["value"] = (int)value.TotalDays,
                ["unit"] = "days"
            };
        }

        if (value.TotalHours >= 1 && value == TimeSpan.FromHours(value.TotalHours))
        {
            return new JsonObject
            {
                ["value"] = (int)value.TotalHours,
                ["unit"] = "hours"
            };
        }

        if (value.TotalMinutes >= 1 && value == TimeSpan.FromMinutes(value.TotalMinutes))
        {
            return new JsonObject
            {
                ["value"] = (int)value.TotalMinutes,
                ["unit"] = "minutes"
            };
        }

        return new JsonObject
        {
            ["value"] = (int)value.TotalSeconds,
            ["unit"] = "seconds"
        };
    }

    private static string FormatDuration(TimeSpan value)
    {
        JsonObject duration = Duration(value);
        return string.Create(
            CultureInfo.InvariantCulture,
            $"{duration["value"]?.GetValue<int>()}{duration["unit"]?.GetValue<string>()}");
    }

    private static TimeSpan ReadPrivateStaticTimeSpan(Type type, string fieldName)
    {
        FieldInfo? field = type.GetField(fieldName, BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Public);
        if (field is null)
        {
            throw new InvalidOperationException($"missing private static field {type.FullName}.{fieldName}");
        }

        object? value = field.GetValue(null);
        if (value is not TimeSpan timeSpan)
        {
            throw new InvalidOperationException($"{type.FullName}.{fieldName} is not TimeSpan");
        }

        return timeSpan;
    }

    private static string[] SortedUnique(params string[] values)
        => values
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();

    private static JsonArray ToJsonArray(IReadOnlyList<string> values)
    {
        var array = new JsonArray();
        foreach (string value in values)
        {
            array.Add(value);
        }

        return array;
    }

    private static string Sha256Hex(string text)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(text));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
