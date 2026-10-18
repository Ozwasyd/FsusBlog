using System.Collections.ObjectModel;
using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

internal sealed record OfflineMigrationShellBackupDrillTools(
    CurrentSchemaArtifactReference Backup,
    CurrentSchemaArtifactReference Restore,
    CurrentSchemaArtifactReference Drill,
    CurrentSchemaArtifactReference Bash,
    CurrentSchemaArtifactReference Session,
    CurrentSchemaArtifactReference DotNet,
    CurrentSchemaArtifactReference Migration);

internal sealed record OfflineMigrationShellBackupDrillInputScope(
    CurrentSchemaDatabaseIdentity ExpectedDatabase,
    string EnvironmentFilePath,
    string RestoreEnvironmentFilePath,
    string BackupPackagePath,
    string OutputParent,
    string PlanOutputPath);

/// <summary>
/// Process-owned original tool and operation input binding. Expected tool bytes come
/// from the composition owner, not CLI JSON; this is neither backup authentication nor
/// target/DAG approval. Secret files are admitted by descriptor without reading content.
/// </summary>
internal sealed class OfflineMigrationShellBackupDrillOwnedInputs
{
    private readonly OfflineMigrationShellBackupDrillConfiguration _configuration;
    private readonly OfflineMigrationShellBackupDrillTools _tools;
    private readonly OfflineMigrationShellBackupDrillInputScope _scope;
    private readonly Action<string>? _afterToolReadForFixture;

    // Original immutable locators for early Host scope comparison, not a
    // verified backup, source observation or invocation/execution capability.
    internal OfflineMigrationShellBackupDrillInputScope InputScope => _scope;

    internal OfflineMigrationShellBackupDrillOwnedInputs(
        OfflineMigrationShellBackupDrillConfiguration configuration,
        OfflineMigrationShellBackupDrillTools tools,
        OfflineMigrationShellBackupDrillInputScope scope)
        : this(configuration, tools, scope, null)
    {
    }

    // Deterministic filesystem-race fixture only: it cannot supply hash/identity results
    // or skip the original FD predicate. Production composition uses the three arguments.
    internal OfflineMigrationShellBackupDrillOwnedInputs(
        OfflineMigrationShellBackupDrillConfiguration configuration,
        OfflineMigrationShellBackupDrillTools tools,
        OfflineMigrationShellBackupDrillInputScope scope,
        Action<string>? afterToolReadForFixture)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(tools);
        ArgumentNullException.ThrowIfNull(scope);
        ArgumentNullException.ThrowIfNull(configuration.ExecutionEnvironment);
        _configuration = configuration with
        {
            ExecutionEnvironment = new ReadOnlyDictionary<string, string>(
                configuration.ExecutionEnvironment.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal)),
            OwnedInputs = null
        };
        _tools = tools;
        _scope = scope;
        _afterToolReadForFixture = afterToolReadForFixture;
    }

    internal async Task<OfflineMigrationShellBackupDrillConfiguration> CreateConfigurationAsync(
        CancellationToken cancellationToken)
    {
        await VerifyToolsAsync(cancellationToken).ConfigureAwait(false);
        return _configuration with { OwnedInputs = this };
    }

    internal async Task VerifyInvocationAsync(OfflineMigrationShellBackupDrillConfiguration configuration,
        OfflineMigrationPlanCommandOptions options, string privateRoot, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(options);
        cancellationToken.ThrowIfCancellationRequested();
        // A record clone must not preserve an old byte binding while changing execution
        // paths, credentials or environment. The copied environment is read-only and owned.
        Require((configuration with { OwnedInputs = null }) == _configuration,
            "configuration_changed");
        Require(options.ExpectedDatabase == _scope.ExpectedDatabase
            && options.EnvironmentFilePath == _scope.EnvironmentFilePath
            && options.RestoreEnvironmentFilePath == _scope.RestoreEnvironmentFilePath
            && options.BackupPackagePath == _scope.BackupPackagePath
            && options.PlanOutputPath == _scope.PlanOutputPath
            && Path.GetDirectoryName(Canonical(privateRoot)) == _scope.OutputParent,
            "invocation_scope_changed");
        OfflineMigrationOperationDeadline deadline = options.OperationDeadline
            ?? throw Failure("original_operation_deadline_required");
        _ = deadline.RemainingWholeSeconds(cancellationToken);
        await VerifyToolsAsync(cancellationToken).ConfigureAwait(false);
        _ = deadline.RemainingWholeSeconds(cancellationToken);
    }

    private async Task VerifyToolsAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!OperatingSystem.IsLinux())
        {
            throw Failure("linux_operation_owner_required");
        }
        Require(_scope.ExpectedDatabase is not null
            && _scope.ExpectedDatabase.Provider == CurrentSchemaProviderKind.PostgreSql
            && !string.IsNullOrWhiteSpace(_scope.ExpectedDatabase.InstanceId)
            && !string.IsNullOrWhiteSpace(_scope.ExpectedDatabase.DatabaseId),
            "provider_capture_capability_missing");
        Require(_configuration.TerminateGraceSeconds is > 0 and <= int.MaxValue / 1000
            && _configuration.KillReapSeconds is > 0 and <= int.MaxValue / 1000,
            "cleanup_selection_invalid");
        RequireDirectory(Canonical(_configuration.RepositoryRoot));
        RequireDirectory(Canonical(_scope.OutputParent));
        RequireDirectory(Path.GetDirectoryName(Canonical(_scope.PlanOutputPath))!);
        foreach ((string name, string value) in _configuration.ExecutionEnvironment)
        {
            Require(!string.IsNullOrEmpty(name) && !name.Contains('=') && !name.Any(char.IsControl)
                && value is not null && !value.Contains('\0')
                && !name.StartsWith("FSUSBLOG_", StringComparison.Ordinal) && name != "DOTNET_BIN"
                && name is not ("BASH_ENV" or "ENV" or "SHELLOPTS" or "BASHOPTS" or "CDPATH")
                && !name.StartsWith("BASH_FUNC_", StringComparison.Ordinal),
                "execution_environment_override_refused");
        }
        // These admissions intentionally read no identity, passphrase or connection text.
        // Original restore/envelope and native observation owners still enforce custody.
        foreach (string path in new[] { _configuration.IdentityFile, _scope.EnvironmentFilePath,
            _scope.RestoreEnvironmentFilePath, _scope.BackupPackagePath })
        {
            AdmitRegularFile(path, cancellationToken);
        }
        if (_configuration.IdentityPassphraseFile is not null)
        {
            AdmitRegularFile(_configuration.IdentityPassphraseFile, cancellationToken);
        }

        string operations = Path.Combine(_configuration.RepositoryRoot, "tools", "operations");
        (CurrentSchemaArtifactReference Artifact, string Path)[] files =
        [
            (_tools.Backup, Path.Combine(operations, "backup-site.sh")),
            (_tools.Restore, Path.Combine(operations, "restore-site.sh")),
            (_tools.Drill, Path.Combine(operations, "backup-restore-drill.sh")),
            (_tools.Bash, _configuration.BashExecutable),
            (_tools.Session, _configuration.SessionExecutable),
            (_tools.DotNet, _configuration.DotNetExecutable),
            (_tools.Migration, _configuration.MigrationAssembly)
        ];
        foreach ((CurrentSchemaArtifactReference artifact, string path) in files)
        {
            Require(artifact is not null && artifact.Reference == Canonical(path)
                && artifact.Sha256 is { Length: 64 }
                && artifact.Sha256.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f'),
                "original_tool_identity_required");
            using var handle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(path, cancellationToken);
            var initial = OfflineMigrationCurrentSchemaArtifactReader.CaptureOriginalRegularFileIdentity(
                path, handle, cancellationToken);
            await using var input = new FileStream(handle, FileAccess.Read, 64 * 1024);
            long length = input.Length;
            string digest = Convert.ToHexStringLower(await SHA256.HashDataAsync(input, cancellationToken).ConfigureAwait(false));
            _afterToolReadForFixture?.Invoke(path);
            OfflineMigrationCurrentSchemaArtifactReader.ValidateOriginalRegularFileUnchanged(
                path, handle, initial, cancellationToken);
            Require(input.Position == length && input.Length == length && digest == artifact.Sha256,
                "original_tool_bytes_changed");
        }
        foreach (string path in new[] { _configuration.BashExecutable, _configuration.SessionExecutable,
            _configuration.DotNetExecutable })
        {
            Require((File.GetUnixFileMode(path) & (UnixFileMode.UserExecute | UnixFileMode.GroupExecute
                | UnixFileMode.OtherExecute)) != 0, "original_executable_required");
        }
        cancellationToken.ThrowIfCancellationRequested();
        // This is an observed input guard, not an atomic execute-by-FD claim: deployment
        // must retain these original paths/bytes for the owned invocation's lifetime.
    }

    private static void AdmitRegularFile(string path, CancellationToken cancellationToken)
    {
        using var handle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(
            Canonical(path), cancellationToken);
    }

    private static string Canonical(string path)
    {
        Require(!string.IsNullOrWhiteSpace(path) && !path.Any(char.IsControl)
            && Path.IsPathFullyQualified(path) && Path.GetFullPath(path) == path,
            "canonical_path_required");
        return path;
    }

    private static void RequireDirectory(string path)
    {
        for (DirectoryInfo? directory = new(path); directory is not null; directory = directory.Parent)
        {
            Require(directory.Exists && directory.LinkTarget is null, "owned_directory_required");
        }
    }

    private static void Require([DoesNotReturnIf(false)] bool condition, string code)
    {
        if (!condition) throw Failure(code);
    }

    private static InvalidOperationException Failure(string code)
        => new("offline_backup_tool_configuration_" + code);
}
