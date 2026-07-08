using System.Diagnostics;
using System.Text.Json;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CoverageScriptContractTests
{
    private static readonly string[] CoverageScripts =
    [
        "tools/coverage/collect-backend-coverage.sh",
        "tools/coverage/collect-frontend-coverage.sh",
        "tools/coverage/merge-coverage.sh",
        "tools/coverage/check-scope-snapshot.sh",
        "tools/coverage/check-threshold.sh"
    ];

    [Theory]
    [MemberData(nameof(CoverageScriptPaths))]
    public void CoverageScripts_ExistAndAreExecutable(string relativePath)
    {
        string script = BackendTestPaths.FromRoot(relativePath);

        Assert.True(File.Exists(script), $"{relativePath} must exist.");

        if (!OperatingSystem.IsWindows())
        {
            UnixFileMode mode = File.GetUnixFileMode(script);
            Assert.True((mode & (UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute)) != 0,
                $"{relativePath} must be executable.");
        }
    }

    [Theory]
    [MemberData(nameof(CoverageScriptPaths))]
    public void CoverageScripts_DryRunEmitsContractSchema(string relativePath)
    {
        string root = BackendTestPaths.RepositoryRoot;
        string script = BackendTestPaths.FromRoot(relativePath);
        Assert.True(File.Exists(script), $"{relativePath} must exist.");
        using Process process = new()
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "bash",
                WorkingDirectory = root,
                RedirectStandardError = true,
                RedirectStandardOutput = true
            }
        };
        process.StartInfo.ArgumentList.Add(script);
        process.StartInfo.ArgumentList.Add("--dry-run");

        process.Start();
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        Assert.True(process.ExitCode == 0, $"{relativePath} dry-run failed: {stderr}");

        using JsonDocument document = JsonDocument.Parse(stdout);
        JsonElement rootElement = document.RootElement;
        Assert.Equal("dry-run", rootElement.GetProperty("status").GetString());
        Assert.StartsWith("fsusblog.coverage.", rootElement.GetProperty("schema").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public void FrontendCoverageCollection_DefaultsLocalVitestThresholdsToArtifactOnly()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "coverage", "collect-frontend-coverage.sh");

        Assert.Contains(
            "FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "export FSUSBLOG_USE_LOCAL_FSUSUI=\"${FSUSBLOG_USE_LOCAL_FSUSUI:-0}\"",
            source,
            StringComparison.Ordinal);
    }

    [Fact]
    public void BackendCoverageCollection_ExcludesTimingSensitiveCategories()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "coverage", "collect-backend-coverage.sh");

        Assert.Contains(
            "--filter \"Category!=Integration&Category!=Concurrency&Category!=Performance\"",
            source,
            StringComparison.Ordinal);
    }

    [Fact]
    public void AcceptanceBootstrap_EnablesAnonymousIdentityModeForSecurityRuntime()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "bootstrap-acceptance-env.sh");

        Assert.Contains(
            "ANONYMOUS_IDENTITY_MODE=\"${FSUSBLOG_ANONYMOUS_IDENTITY_MODE:-1}\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "FSUSBLOG_ANONYMOUS_IDENTITY_MODE=$ANONYMOUS_IDENTITY_MODE",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "FSUSBLOG_ANONYMOUS_IDENTITY_MODE=$(printf '%q' \"$ANONYMOUS_IDENTITY_MODE\")",
            source,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ProductionCompose_DefaultsAnonymousIdentityModeOn()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("ops", "docker", "docker-compose.yml");

        Assert.Contains(
            "FSUSBLOG_ANONYMOUS_IDENTITY_MODE=${FSUSBLOG_ANONYMOUS_IDENTITY_MODE:-1}",
            source,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ProductionCompose_DefaultsZkProdGateOnWithRealArtifactInputs()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("ops", "docker", "docker-compose.yml");

        Assert.Contains(
            "AnonymousIdentity__ZkProd__Enabled=${FSUSBLOG_ZK_PROD_ENABLED:-true}",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "AnonymousIdentity__ZkProd__TrustedSetupVerified=${FSUSBLOG_ZK_TRUSTED_SETUP_VERIFIED:-true}",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "AnonymousIdentity__ZkProd__CredentialReady=${FSUSBLOG_ZK_CREDENTIAL_READY:-true}",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "AnonymousIdentity__ZkProd__VerifyingKeyHash=${FSUSBLOG_ZK_VERIFYING_KEY_HASH}",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "AnonymousIdentity__ZkVerifier__Enabled=${FSUSBLOG_ZK_VERIFIER_ENABLED:-true}",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "AnonymousIdentity__ZkVerifier__NativeGroth16__VerifyingKeyPath=${FSUSBLOG_ZK_GROTH16_VERIFYING_KEY}",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "AnonymousCredentialIssuer__CircuitNative__Enabled=${FSUSBLOG_ZK_CREDENTIAL_ISSUER_ENABLED:-true}",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "AnonymousCredentialIssuer__CircuitNative__IssuerPrivateKeyPath=${FSUSBLOG_ZK_ISSUER_PRIVATE_KEY}",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "AnonymousCredentialIssuer__CircuitNative__IssuerPublicKeyHash=${FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH}",
            source,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ProductionCompose_MountsZkProdMaterialDirectoriesReadOnly()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("ops", "docker", "docker-compose.yml");

        Assert.Contains(
            "${FSUSBLOG_ZK_CONFIG_DIR:?Set FSUSBLOG_ZK_CONFIG_DIR to the host ZK config directory}:/app/config/zk:ro",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "${FSUSBLOG_ZK_SECRET_DIR:?Set FSUSBLOG_ZK_SECRET_DIR to the host ZK secret directory}:/app/secrets/zk:ro",
            source,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ProductionDeployScript_GuidesZkProdMaterialsBeforeComposeUp()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "deploy-production.sh");

        Assert.Contains("FSUSBLOG_ZK_CONFIG_DIR", source, StringComparison.Ordinal);
        Assert.Contains("FSUSBLOG_ZK_SECRET_DIR", source, StringComparison.Ordinal);
        Assert.Contains("npm --prefix src/frontend run check:privacy-zk-prod-release", source, StringComparison.Ordinal);
        Assert.Contains("tools/security/bootstrap-anonymous-credential-root.mjs", source, StringComparison.Ordinal);
        Assert.Contains("tools/build-final-image.sh", source, StringComparison.Ordinal);
        Assert.Contains("docker compose --env-file", source, StringComparison.Ordinal);
        Assert.Contains("--dry-run", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AcceptanceBootstrap_RefreshesRedisAfterFixtureSeeding()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "bootstrap-acceptance-env.sh");

        Assert.Contains("refresh_acceptance_cache_after_fixtures", source, StringComparison.Ordinal);
        Assert.Contains("redis-cli FLUSHDB", source, StringComparison.Ordinal);
        Assert.Contains("refresh_acceptance_cache_after_fixtures", ExtractFunction(source, "prepare_fixtures"), StringComparison.Ordinal);
    }

    [Fact]
    public void AcceptanceBootstrap_DisablesPublicReadRiskChallengeForViewportSweeps()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "bootstrap-acceptance-env.sh");

        Assert.Contains("RISK_PUBLIC_READ_CHALLENGE_ENABLED=\"${FSUSBLOG_ACCEPTANCE_PUBLIC_READ_CHALLENGE_ENABLED:-false}\"", source, StringComparison.Ordinal);
        Assert.Contains("Security__RiskControl__PublicReadChallenge__Enabled=$RISK_PUBLIC_READ_CHALLENGE_ENABLED", source, StringComparison.Ordinal);
        Assert.Contains("Security__RiskControl__PublicReadChallenge__Enabled=$(printf '%q' \"$RISK_PUBLIC_READ_CHALLENGE_ENABLED\")", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AcceptanceBootstrap_RaisesPublicReadRateLimitForViewportSweeps()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "bootstrap-acceptance-env.sh");

        Assert.Contains("PUBLIC_READ_PERMIT_LIMIT=\"${FSUSBLOG_ACCEPTANCE_PUBLIC_READ_PERMIT_LIMIT:-100000}\"", source, StringComparison.Ordinal);
        Assert.Contains("PUBLIC_READ_QUEUE_LIMIT=\"${FSUSBLOG_ACCEPTANCE_PUBLIC_READ_QUEUE_LIMIT:-10000}\"", source, StringComparison.Ordinal);
        Assert.Contains("RateLimiting__PublicReadPermitLimit=$PUBLIC_READ_PERMIT_LIMIT", source, StringComparison.Ordinal);
        Assert.Contains("RateLimiting__PublicReadQueueLimit=$PUBLIC_READ_QUEUE_LIMIT", source, StringComparison.Ordinal);
        Assert.Contains("RateLimiting__PublicReadPermitLimit=$(printf '%q' \"$PUBLIC_READ_PERMIT_LIMIT\")", source, StringComparison.Ordinal);
        Assert.Contains("RateLimiting__PublicReadQueueLimit=$(printf '%q' \"$PUBLIC_READ_QUEUE_LIMIT\")", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AcceptanceBootstrap_RaisesNotificationStreamAccountLimitForPressure()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "bootstrap-acceptance-env.sh");

        Assert.Contains("NOTIFICATION_STREAM_MAX_CONNECTIONS_PER_ACCOUNT=\"${FSUSBLOG_ACCEPTANCE_NOTIFICATION_STREAM_MAX_CONNECTIONS_PER_ACCOUNT:-50}\"", source, StringComparison.Ordinal);
        Assert.Contains("NotificationStream__MaxConnectionsPerAccount=$NOTIFICATION_STREAM_MAX_CONNECTIONS_PER_ACCOUNT", source, StringComparison.Ordinal);
        Assert.Contains("NotificationStream__MaxConnectionsPerAccount=$(printf '%q' \"$NOTIFICATION_STREAM_MAX_CONNECTIONS_PER_ACCOUNT\")", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AcceptanceBootstrapSecurityResetClearsPersistedRiskEvents()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "bootstrap-acceptance-env.sh");
        string function = ExtractFunction(source, "reset_security_test_state");

        Assert.Contains("POSTGRES_CONTAINER", function, StringComparison.Ordinal);
        Assert.Contains("security_risk_event", function, StringComparison.Ordinal);
        Assert.Contains("expires_at_utc > (now() AT TIME ZONE 'utc')", function, StringComparison.Ordinal);
        Assert.Contains("FORCE_BOOTSTRAP=1", function, StringComparison.Ordinal);
    }

    [Fact]
    public void LegacyTestReloadsAcceptanceUrlsAfterReadingBootstrapEnv()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "test", "legacy-test.sh");
        string function = ExtractFunction(source, "require_bootstrapped_namespace");

        Assert.Contains("DEBUG_FRONTEND_URL=\"${FSUSBLOG_DEBUG_FRONTEND_URL:-$DEBUG_FRONTEND_URL}\"", function, StringComparison.Ordinal);
        Assert.Contains("DEBUG_BACKEND_URL=\"${FSUSBLOG_DEBUG_BACKEND_URL:-$DEBUG_BACKEND_URL}\"", function, StringComparison.Ordinal);
        Assert.Contains("RELEASE_PREVIEW_URL=\"${FSUSBLOG_RELEASE_PREVIEW_URL:-$RELEASE_PREVIEW_URL}\"", function, StringComparison.Ordinal);
    }

    [Fact]
    public void LegacyRuntimeSecurityResetClearsHotAndPersistedRiskState()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "test", "legacy-test.sh");
        string function = ExtractFunction(source, "reset_security_runtime_state");

        Assert.Contains("FSUSBLOG_REDIS_CONTAINER_NAME", function, StringComparison.Ordinal);
        Assert.Contains("fsus:sec:pow-risk:*", function, StringComparison.Ordinal);
        Assert.Contains("FSUSBLOG_POSTGRES_CONTAINER_NAME", function, StringComparison.Ordinal);
        Assert.Contains("security_risk_event", function, StringComparison.Ordinal);
        Assert.Contains("expires_at_utc > (now() AT TIME ZONE 'utc')", function, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadLaneResetsRiskStateImmediatelyBeforeNotificationPressure()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "test", "legacy-test.sh");
        string function = ExtractFunction(source, "run_load_only");

        int resetIndex = function.IndexOf("reset_security_runtime_state \"pre notification stream pressure\"", StringComparison.Ordinal);
        int pressureIndex = function.IndexOf("npm run check:load:notification-stream-pressure", StringComparison.Ordinal);

        Assert.True(resetIndex >= 0, "load lane must reset local risk state immediately before notification stream pressure");
        Assert.True(pressureIndex > resetIndex, "notification stream pressure must run after its dedicated risk reset");
    }

    [Fact]
    public void CoverageThresholdLane_UsesArtifactOnlyFrontendDefaults()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "test", "lanes", "coverage-threshold.sh");

        Assert.Contains(
            "FSUSBLOG_COVERAGE_LINE_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "FSUSBLOG_COVERAGE_BRANCH_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "FSUSBLOG_COVERAGE_FUNCTION_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ChangedCodeCoverage_DoesNotFallbackWhenBaseDiffIsEmpty()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "coverage", "write-changed-code-coverage.mjs");

        Assert.Contains("return result.status === 0 ? result.stdout.trim() : null", source, StringComparison.Ordinal);
        Assert.Contains("const changed = diff ?? git(['diff', '--name-only', 'HEAD~1..HEAD']) ?? ''", source, StringComparison.Ordinal);
        Assert.DoesNotContain("]) || git(['diff', '--name-only', 'HEAD~1..HEAD'])", source, StringComparison.Ordinal);
    }

    [Fact]
    public void FrontendBuildLane_UsesLocalFsusUiReleaseSurface()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "test", "legacy-test.sh");

        Assert.Contains("FSUSBLOG_SKIP_ENSURE_WASM=1", source, StringComparison.Ordinal);
        Assert.Contains("FSUSBLOG_VITE_WARN_AS_ERROR=1", source, StringComparison.Ordinal);
        Assert.DoesNotContain("FSUSBLOG_USE_LOCAL_FSUSUI=0", source, StringComparison.Ordinal);
    }

    public static IEnumerable<object[]> CoverageScriptPaths()
    {
        foreach (string script in CoverageScripts)
        {
            yield return [script];
        }
    }

    private static string ExtractFunction(string source, string functionName)
    {
        string marker = $"{functionName}()";
        int start = source.IndexOf(marker, StringComparison.Ordinal);
        if (start < 0)
        {
            return string.Empty;
        }

        int nextFunction = source.IndexOf("\n}\n\n", start, StringComparison.Ordinal);
        return nextFunction < 0 ? source[start..] : source[start..(nextFunction + 3)];
    }
}
