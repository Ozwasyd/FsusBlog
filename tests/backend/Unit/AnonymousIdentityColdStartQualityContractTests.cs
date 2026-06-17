using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousIdentityColdStartQualityContractTests
{
    [Fact]
    public void ColdStartResetOperation_GuardsBeforeTransactionAndPurgesLegacyProductionTables()
    {
        string reset = BackendTestPaths.ReadAllTextFromRoot(
            "src/backend/Infrastructure/Operations/LegacyIdentityColdStartResetOperation.cs");

        Assert.Contains("ConfirmationEnvironmentVariable = \"FSUSBLOG_CONFIRM_IDENTITY_RESET\"", reset, StringComparison.Ordinal);
        Assert.Contains("RequiredConfirmation = \"DELETE_LEGACY_USERS\"", reset, StringComparison.Ordinal);

        int guardIndex = reset.IndexOf("ValidateConfirmation(confirmation);", StringComparison.Ordinal);
        int transactionIndex = reset.IndexOf("_db.Ado.UseTranAsync", StringComparison.Ordinal);
        Assert.True(guardIndex >= 0, "Cold-start reset must validate the destructive confirmation.");
        Assert.True(transactionIndex >= 0, "Cold-start reset must run destructive SQL in a transaction.");
        Assert.True(guardIndex < transactionIndex, "Confirmation must fail before the destructive transaction opens.");

        foreach (string destructiveDelete in new[]
        {
            "DELETE FROM comment_moderation_signal",
            "DELETE FROM comment_region_compliance",
            "DELETE FROM comment",
            "DELETE FROM msg_participant_state",
            "DELETE FROM msg_message",
            "DELETE FROM msg_conversation",
            "DELETE FROM passkey_credential",
            "DELETE FROM sys_user_session",
            "DELETE FROM sys_user"
        })
        {
            Assert.Contains(destructiveDelete, reset, StringComparison.Ordinal);
        }

        Assert.DoesNotContain("INSERT INTO comment(", reset, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("UPDATE comment", reset, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ColdStartResetIntegrationTestsAndSmokeDocs_PinDestructiveCutoverEvidence()
    {
        string integrationTests = BackendTestPaths.ReadAllTextFromRoot(
            "tests/backend/Integration/LegacyIdentityColdStartResetIntegrationTests.cs");
        string migrationRunbook = BackendTestPaths.ReadAllTextFromRoot("docs/database-migration.md");
        string securityRunbook = BackendTestPaths.ReadAllTextFromRoot("docs/security.md");
        string smokeRunbookPath = BackendTestPaths.FromRoot("docs", "anonymous-identity-smoke-flow.md");

        Assert.Contains("RunAsync_FailsBeforeDeletingRows_WhenConfirmationIsMissing", integrationTests, StringComparison.Ordinal);
        Assert.Contains("RunAsync_DeletesLegacyIdentityCommentsAndUserBoundMessages_WhenConfirmationMatches", integrationTests, StringComparison.Ordinal);
        Assert.Contains("Assert.Equal(0, await CountRowsAsync(connectionString, \"comment\"))", integrationTests, StringComparison.Ordinal);
        Assert.Contains("Assert.True(await fixture.TableExistsAsync(connectionString, \"comment\"))", integrationTests, StringComparison.Ordinal);

        Assert.Contains("intentionally deletes legacy users and historical comments", migrationRunbook, StringComparison.Ordinal);
        Assert.Contains("FSUSBLOG_CONFIRM_IDENTITY_RESET=DELETE_LEGACY_USERS", migrationRunbook, StringComparison.Ordinal);
        Assert.Contains("legacy Passkey", securityRunbook, StringComparison.Ordinal);
        Assert.True(
            securityRunbook.Contains("历史评论", StringComparison.Ordinal) ||
            securityRunbook.Contains("historical comments", StringComparison.Ordinal),
            "docs/security.md must state that historical comments are intentionally cleared.");

        Assert.True(File.Exists(smokeRunbookPath), "docs/anonymous-identity-smoke-flow.md must document the cold-start smoke flow.");
        string smokeRunbook = File.ReadAllText(smokeRunbookPath);
        foreach (string requiredStep in new[]
        {
            "cold-start reset",
            "bootstrap admin",
            "Passkey registration/login",
            "Recovery Key creation/recovery",
            "anonymous default comment submission",
            "public opt-in comment submission",
            "moderation review",
            "old users and historical comments are intentionally cleared"
        })
        {
            Assert.Contains(requiredStep, smokeRunbook, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void CrossStackAnonymousIdentityContracts_PinFramesRecoveryAdminAndCommentActors()
    {
        string coreFrames = BackendTestPaths.ReadAllTextFromRoot("src/core/Algorithms/AedsFrameType.cs");
        string sharedFrames = BackendTestPaths.ReadAllTextFromRoot("src/shared/AedsFrameHeader.cs");
        string frontendFrames = BackendTestPaths.ReadAllTextFromRoot("src/frontend/wasm/web/protocol/frame.ts");
        string podTests = BackendTestPaths.ReadAllTextFromRoot("tests/backend/Unit/PodBinaryCodecTests.cs");
        string adminTests = BackendTestPaths.ReadAllTextFromRoot("tests/backend/Unit/AdminPrincipalSecurityContractTests.cs");
        string actorTests = BackendTestPaths.ReadAllTextFromRoot("tests/backend/Unit/CommentActorContractTests.cs");

        foreach ((string name, ushort value) in new[]
        {
            ("RecoveryKeyCreateResponse", (ushort)159),
            ("RecoveryKeyVerifyRequest", (ushort)160),
            ("RecoveryKeyVerifyResponse", (ushort)161),
            ("RecoveryKeySessionRequest", (ushort)162),
            ("IdentityAccountSnapshot", (ushort)163),
            ("CommentPolicySnapshot", (ushort)164),
            ("CommentPolicyUpdateRequest", (ushort)165),
            ("CommentCreateV2Request", (ushort)166),
            ("CommentAuthorView", (ushort)167)
        })
        {
            Assert.Contains($"{name} = {value}", coreFrames, StringComparison.Ordinal);
            Assert.Contains($"{name} = {value}", sharedFrames, StringComparison.Ordinal);
            Assert.Contains($"{name} = {value}", frontendFrames, StringComparison.Ordinal);
        }

        foreach (string requiredCoverage in new[]
        {
            "RecoveryKeyPods_RoundTrip_PreserveFields",
            "IdentityAccountSnapshot_RoundTrip_PreservesNullableHandleAndCredentialState",
            "CommentPolicySnapshotAndUpdate_RoundTrip_PreserveModesLanguagesAndPatchSemantics",
            "CommentCreateV2Request_RoundTrip_PreservesAnonymousFieldsWithoutChangingLegacyLayout",
            "CommentAuthorView_RoundTrip_PreservesLocalizedAnonymousProjection"
        })
        {
            Assert.Contains(requiredCoverage, podTests, StringComparison.Ordinal);
        }

        Assert.Contains("AnonymousIdentityRuntime_DoesNotGrantAdminFromLegacyUserRole", adminTests, StringComparison.Ordinal);
        Assert.Contains("AnonymousDisplayNameGenerator_LocalizesStablyWithoutIdentityLeakage", actorTests, StringComparison.Ordinal);
    }
}
