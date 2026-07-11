using System.Diagnostics;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class BackupRestoreScriptBehaviorTests
{
    [Theory]
    [InlineData("Host=db.internal;Port=15432;Database=fsusblog;Username=fsus_user;Password=fsus_pw", "db.internal", "15432", "fsusblog", "fsus_user", "fsus_pw")]
    [InlineData("postgres://fsus_user:fsus_pw@db.internal:15432/fsusblog", "db.internal", "15432", "fsusblog", "fsus_user", "fsus_pw")]
    [InlineData("host=db.internal port=15432 dbname=fsusblog user=fsus_user password=fsus_pw", "db.internal", "15432", "fsusblog", "fsus_user", "fsus_pw")]
    public void BackupScript_ExecutesPgDumpWithEverySupportedConnectionStringStyle(
        string connectionString,
        string expectedHost,
        string expectedPort,
        string expectedDatabase,
        string expectedUser,
        string expectedPassword)
    {
        using ScriptHarness harness = ScriptHarness.Create();

        ScriptCapture result = harness.RunBackup(connectionString);

        Assert.Equal("ok|", result.State);
        Assert.NotNull(result.Command);
        Assert.Contains($"PGPASSWORD={expectedPassword}", result.Command, StringComparison.Ordinal);
        Assert.Contains($" -h {expectedHost} ", result.Command, StringComparison.Ordinal);
        Assert.Contains($" -p {expectedPort} ", result.Command, StringComparison.Ordinal);
        Assert.Contains($" -U {expectedUser} ", result.Command, StringComparison.Ordinal);
        Assert.Contains($" -d {expectedDatabase} ", result.Command, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Host=db.internal;Port=15432;Database=fsusblog;Username=fsus_user;Password=fsus_pw", "db.internal", "15432", "fsusblog", "fsus_user", "fsus_pw")]
    [InlineData("postgres://fsus_user:fsus_pw@db.internal:15432/fsusblog", "db.internal", "15432", "fsusblog", "fsus_user", "fsus_pw")]
    [InlineData("host=db.internal port=15432 dbname=fsusblog user=fsus_user password=fsus_pw", "db.internal", "15432", "fsusblog", "fsus_user", "fsus_pw")]
    public void RestoreScript_ExecutesPgRestoreWithEverySupportedConnectionStringStyle(
        string connectionString,
        string expectedHost,
        string expectedPort,
        string expectedDatabase,
        string expectedUser,
        string expectedPassword)
    {
        using ScriptHarness harness = ScriptHarness.Create();

        ScriptCapture result = harness.RunRestore(connectionString);

        Assert.Equal("ok|", result.State);
        Assert.NotNull(result.Command);
        Assert.Contains($"PGPASSWORD={expectedPassword}", result.Command, StringComparison.Ordinal);
        Assert.Contains($" -h {expectedHost} ", result.Command, StringComparison.Ordinal);
        Assert.Contains($" -p {expectedPort} ", result.Command, StringComparison.Ordinal);
        Assert.Contains($" -U {expectedUser} ", result.Command, StringComparison.Ordinal);
        Assert.Contains($" -d {expectedDatabase} ", result.Command, StringComparison.Ordinal);
        Assert.Contains(" --clean --if-exists ", result.Command, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("", "database-connection-missing")]
    [InlineData("not-a-postgres-connection", "database-connection-invalid")]
    public void BackupScript_InvalidConnectionBlocksWithoutInvokingPgDump(string connectionString, string blocker)
    {
        using ScriptHarness harness = ScriptHarness.Create();

        ScriptCapture result = harness.RunBackup(connectionString);

        Assert.Equal($"blocked|{blocker}", result.State);
        Assert.Null(result.Command);
    }

    [Theory]
    [InlineData("", "database-connection-missing")]
    [InlineData("not-a-postgres-connection", "database-connection-invalid")]
    public void RestoreScript_InvalidConnectionBlocksWithoutInvokingPgRestore(string connectionString, string blocker)
    {
        using ScriptHarness harness = ScriptHarness.Create();

        ScriptCapture result = harness.RunRestore(connectionString);

        Assert.Equal($"blocked|{blocker}", result.State);
        Assert.Null(result.Command);
    }

    [Fact]
    public void RestoreScript_MissingDatabaseDumpBlocksBeforeInvokingPgRestore()
    {
        using ScriptHarness harness = ScriptHarness.Create();

        ScriptCapture result = harness.RunRestore(
            "Host=db.internal;Database=fsusblog;Username=fsus_user;Password=fsus_pw",
            createDump: false);

        Assert.Equal("blocked|database-dump-missing", result.State);
        Assert.Null(result.Command);
    }

    [Fact]
    public void BackupRestoreDrillFixture_ExercisesScheduledAndBlockedEvidencePaths()
    {
        using Process process = new()
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "bash",
                WorkingDirectory = BackendTestPaths.RepositoryRoot,
                RedirectStandardError = true,
                RedirectStandardOutput = true
            }
        };
        process.StartInfo.ArgumentList.Add("tools/operations/test-backup-restore-drill-fixture.sh");

        process.Start();
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        Assert.True(process.ExitCode == 0, $"backup/restore drill fixture failed with {process.ExitCode}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}");
        Assert.Contains("[backup-restore-drill-fixture] ok", stdout, StringComparison.Ordinal);
    }

    private sealed record ScriptCapture(string? Command, string State);

    private sealed class ScriptHarness : IDisposable
    {
        private readonly string _root;
        private readonly string _binDir;
        private readonly string _backupRoot;
        private readonly string _restoreRoot;
        private readonly string _dataRoot;
        private readonly string _webRoot;
        private readonly string _commandPath;
        private readonly string _statePath;

        private ScriptHarness(string root)
        {
            _root = root;
            _binDir = Path.Combine(root, "bin");
            _backupRoot = Path.Combine(root, "backup");
            _restoreRoot = Path.Combine(root, "restore");
            _dataRoot = Path.Combine(root, "data");
            _webRoot = Path.Combine(root, "wwwroot");
            _commandPath = Path.Combine(root, "pg-command.txt");
            _statePath = Path.Combine(root, "script-state.txt");
        }

        public static ScriptHarness Create()
        {
            string root = Path.Combine(Path.GetTempPath(), "fsusblog-ops-script-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            var harness = new ScriptHarness(root);
            harness.Initialize();
            return harness;
        }

        public ScriptCapture RunBackup(string connectionString)
        {
            RunBashFunction(
                "script_source=\"$(mktemp)\"; sed '$d' tools/operations/backup-site.sh > \"$script_source\"; source \"$script_source\"; rm -f \"$script_source\"; WORK_DIR=\"$1\"; dump_database; printf '%s|%s' \"$status\" \"${blockers[*]-}\" > \"$FSUSBLOG_STATE_PATH\"",
                connectionString,
                [_backupRoot]);
            return ReadCapture();
        }

        public ScriptCapture RunRestore(string connectionString, bool createDump = true)
        {
            string packageRoot = Path.Combine(_restoreRoot, "package");
            Directory.CreateDirectory(packageRoot);
            if (createDump)
            {
                File.WriteAllText(Path.Combine(packageRoot, "database.dump"), "dump");
            }
            RunBashFunction(
                "script_source=\"$(mktemp)\"; sed '$d' tools/operations/restore-site.sh > \"$script_source\"; set --; source \"$script_source\"; rm -f \"$script_source\"; restore_database; printf '%s|%s' \"$status\" \"${blockers[*]-}\" > \"$FSUSBLOG_STATE_PATH\"",
                connectionString,
                []);
            return ReadCapture();
        }

        public void Dispose()
        {
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }

        private ScriptCapture ReadCapture()
            => new(
                File.Exists(_commandPath) ? File.ReadAllText(_commandPath) : null,
                File.ReadAllText(_statePath));

        private void Initialize()
        {
            Directory.CreateDirectory(_binDir);
            Directory.CreateDirectory(Path.Combine(_dataRoot, "data-protection-keys"));
            Directory.CreateDirectory(Path.Combine(_webRoot, "uploads"));
            Directory.CreateDirectory(Path.Combine(_webRoot, "aot-cache"));
            Directory.CreateDirectory(Path.Combine(_webRoot, "search"));
            File.WriteAllText(Path.Combine(_dataRoot, "data-protection-keys", "key.xml"), "<key />");
            WriteCaptureCommand("pg_dump");
            WriteCaptureCommand("pg_restore");
        }

        private void WriteCaptureCommand(string name)
        {
            string path = Path.Combine(_binDir, name);
            File.WriteAllText(path, """
#!/usr/bin/env bash
set -euo pipefail
{
  printf 'PGPASSWORD=%s\n' "${PGPASSWORD-}"
  printf 'ARGS='
  printf ' %s' "$@"
  printf '\n'
} > "${FSUSBLOG_CAPTURE_PATH:?}"
for arg in "$@"; do
  case "$arg" in
    --file=*)
      mkdir -p "$(dirname "${arg#--file=}")"
      printf 'dump' > "${arg#--file=}"
      ;;
  esac
done
""");
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
        }

        private void RunBashFunction(string command, string connectionString, IReadOnlyList<string> args)
        {
            List<string> bashArgs = ["-c", command, "_"];
            bashArgs.AddRange(args);
            RunProcess("bash", bashArgs, connectionString);
        }

        private void RunProcess(string fileName, IReadOnlyList<string> args, string connectionString)
        {
            using Process process = new()
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = fileName,
                    WorkingDirectory = BackendTestPaths.RepositoryRoot,
                    RedirectStandardError = true,
                    RedirectStandardOutput = true
                }
            };

            foreach (string arg in args)
            {
                process.StartInfo.ArgumentList.Add(arg);
            }

            process.StartInfo.Environment["PATH"] = _binDir + Path.PathSeparator + (Environment.GetEnvironmentVariable("PATH") ?? string.Empty);
            process.StartInfo.Environment["FSUSBLOG_CAPTURE_PATH"] = _commandPath;
            process.StartInfo.Environment["FSUSBLOG_STATE_PATH"] = _statePath;
            process.StartInfo.Environment["FSUSBLOG_BACKUP_ROOT"] = _backupRoot;
            process.StartInfo.Environment["FSUSBLOG_BACKUP_RUN_ID"] = "test";
            process.StartInfo.Environment["FSUSBLOG_BACKUP_PACKAGE"] = Path.Combine(_backupRoot, "site.tar.gz");
            process.StartInfo.Environment["FSUSBLOG_RESTORE_ROOT"] = _restoreRoot;
            process.StartInfo.Environment["FSUSBLOG_RESTORE_RUN_ID"] = "test";
            process.StartInfo.Environment["FSUSBLOG_DATA_ROOT"] = _dataRoot;
            process.StartInfo.Environment["FSUSBLOG_WEB_ROOT"] = _webRoot;
            process.StartInfo.Environment["ConnectionStrings__DefaultConnection"] = connectionString;

            process.Start();
            string stdout = process.StandardOutput.ReadToEnd();
            string stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            Assert.True(process.ExitCode == 0, $"{fileName} failed with {process.ExitCode}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}");
        }
    }
}
