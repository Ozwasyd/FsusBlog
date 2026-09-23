using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class MySqlDdlFixture : IAsyncLifetime
{
    private const string Image = "mysql@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d";
    private readonly string _name = $"fsus-mysql-ddl-{Guid.NewGuid():N}";
    private readonly Dictionary<string, string> _labels = CreateLabels();
    private string? _containerId;
    private string? _imageId;
    private string? _created;

    public string EngineVersion { get; private set; } = string.Empty;

    public async Task InitializeAsync()
    {
        try
        {
            _imageId = (await DockerAsync(["image", "inspect", Image, "--format", "{{.Id}}"])).RequireSuccess();
            List<string> args = ["run", "-d", "--name", _name, "--network", "none"];
            foreach ((string key, string value) in _labels)
            {
                args.AddRange(["--label", $"{key}={value}"]);
            }
            args.AddRange(ResourceArguments());
            args.AddRange(["--env", "MYSQL_ALLOW_EMPTY_PASSWORD=yes", Image]);
            _containerId = (await DockerAsync([.. args])).RequireSuccess();
            using JsonDocument created = JsonDocument.Parse((await DockerAsync(["inspect", _containerId])).RequireSuccess());
            _created = created.RootElement[0].GetProperty("Created").GetString();

            using var startupTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            for (int attempt = 0; attempt < 60; attempt++)
            {
                SqlResult ready = await ExecuteAsync(null, "SELECT VERSION();", startupTimeout.Token);
                if (ready.ExitCode == 0)
                {
                    EngineVersion = ready.Output.Trim();
                    return;
                }
                await Task.Delay(500, startupTimeout.Token);
            }
            throw new InvalidOperationException("Task-owned MySQL did not become ready within its startup budget.");
        }
        catch
        {
            await DisposeAsync();
            throw;
        }
    }

    public async Task DisposeAsync()
    {
        SqlResult inspection = await DockerAsync(["inspect", _containerId ?? _name]);
        if (inspection.ExitCode != 0)
        {
            if (_containerId is null && inspection.Error.Contains("No such object", StringComparison.Ordinal))
            {
                return;
            }
            throw new InvalidOperationException($"Cannot verify MySQL fixture cleanup identity: {inspection.Error}");
        }
        using JsonDocument document = JsonDocument.Parse(inspection.Output);
        JsonElement container = document.RootElement[0];
        string id = container.GetProperty("Id").GetString()!;
        JsonElement labels = container.GetProperty("Config").GetProperty("Labels");
        if ((_containerId is not null && id != _containerId)
            || container.GetProperty("Image").GetString() != _imageId
            || (_created is not null && container.GetProperty("Created").GetString() != _created)
            || _labels.Any(label => !labels.TryGetProperty(label.Key, out JsonElement actual) || actual.GetString() != label.Value))
        {
            throw new InvalidOperationException("MySQL fixture cleanup refused an identity mismatch.");
        }
        (await DockerAsync(["rm", "-f", "-v", id])).RequireSuccess();
        SqlResult remaining = await DockerAsync(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", $"id={id}"]);
        Assert.Equal(string.Empty, remaining.RequireSuccess());
        _containerId = null;
    }

    public async Task<string> CreateDatabaseAsync()
    {
        string database = $"ddl_{Guid.NewGuid():N}";
        (await ExecuteAsync(null, $"CREATE DATABASE {database} CHARACTER SET utf8mb4;")).RequireSuccess();
        return database;
    }

    public Task<SqlResult> ExecuteAsync(string? database, string sql, CancellationToken cancellationToken = default)
    {
        if (_containerId is null)
        {
            throw new InvalidOperationException("MySQL fixture is not initialized.");
        }
        // The image's bootstrap server exposes a temporary socket before it
        // restarts. Admit only the final TCP listener inside this isolated container.
        List<string> args = ["exec", _containerId, "mysql", "-uroot", "--protocol=TCP", "--host=127.0.0.1", "--batch", "--raw", "--skip-column-names", "--default-character-set=utf8mb4"];
        if (database is not null)
        {
            args.Add($"--database={database}");
        }
        args.AddRange(["-e", sql]);
        return DockerAsync([.. args], cancellationToken);
    }

    private static Dictionary<string, string> CreateLabels()
    {
        string? digest = Environment.GetEnvironmentVariable("FSUSBLOG_REPOSITORY_ROOT_DIGEST");
        if (string.IsNullOrWhiteSpace(digest))
        {
            DirectoryInfo? root = new(AppContext.BaseDirectory);
            while (root is not null && !File.Exists(Path.Combine(root.FullName, "FsusBlog.slnx")))
            {
                root = root.Parent;
            }
            string repository = root?.FullName ?? throw new InvalidOperationException("Repository root is required for fixture ownership.");
            digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(repository)));
        }
        return new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["com.fsusblog.test.kind"] = "schema-migration",
            ["com.fsusblog.test.owner-pid"] = Environment.ProcessId.ToString(CultureInfo.InvariantCulture),
            ["io.fsusblog.test.repository-root-digest"] = digest,
            ["io.fsusblog.test.run-id"] = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_RUN_ID") ?? $"local-{Guid.NewGuid():N}",
            ["io.fsusblog.test.namespace"] = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_NAMESPACE") ?? "migration-mysql",
            ["io.fsusblog.test.bundle-id"] = Environment.GetEnvironmentVariable("FSUSBLOG_PHYSICAL_BUNDLE_ID") ?? "standalone-migration",
            ["io.fsusblog.test.step-id"] = Environment.GetEnvironmentVariable("FSUSBLOG_STEP_ID") ?? "mysql-ddl-tests"
        };
    }

    private static string[] ResourceArguments()
    {
        string? cpu = Environment.GetEnvironmentVariable("FSUSBLOG_DOCKER_CPU_UNITS");
        string? high = Environment.GetEnvironmentVariable("FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES");
        string? max = Environment.GetEnvironmentVariable("FSUSBLOG_DOCKER_MEMORY_MAX_BYTES");
        string? pids = Environment.GetEnvironmentVariable("FSUSBLOG_DOCKER_PIDS_MAX");
        if (new[] { cpu, high, max, pids }.All(string.IsNullOrWhiteSpace))
        {
            return [];
        }
        if (!double.TryParse(cpu, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out double cpuValue) || cpuValue <= 0
            || !long.TryParse(high, NumberStyles.None, CultureInfo.InvariantCulture, out long highValue) || highValue <= 0
            || !long.TryParse(max, NumberStyles.None, CultureInfo.InvariantCulture, out long maxValue) || maxValue < highValue
            || !long.TryParse(pids, NumberStyles.None, CultureInfo.InvariantCulture, out long pidsValue) || pidsValue <= 0)
        {
            throw new InvalidOperationException("Docker resource grant is incomplete or invalid.");
        }
        return
        [
            "--cpus", cpu!, "--memory-reservation", high!, "--memory", max!, "--pids-limit", pids!,
            "--label", $"io.fsusblog.test.cpu-units={cpu}",
            "--label", $"io.fsusblog.test.memory-high-bytes={high}",
            "--label", $"io.fsusblog.test.memory-max-bytes={max}",
            "--label", $"io.fsusblog.test.pids-max={pids}"
        ];
    }

    private static async Task<SqlResult> DockerAsync(string[] args, CancellationToken cancellationToken = default)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo("docker")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
        };
        foreach (string argument in args)
        {
            process.StartInfo.ArgumentList.Add(argument);
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        process.Start();
        Task<string> output = process.StandardOutput.ReadToEndAsync();
        Task<string> error = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
            using var cleanupTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await process.WaitForExitAsync(cleanupTimeout.Token);
            await Task.WhenAll(output, error).WaitAsync(cleanupTimeout.Token);
            throw;
        }
        return new SqlResult(process.ExitCode, await output, await error);
    }

    public sealed record SqlResult(int ExitCode, string Output, string Error)
    {
        public string RequireSuccess()
        {
            Assert.True(ExitCode == 0, $"MySQL fixture command failed ({ExitCode}): {Error}");
            return Output.Trim();
        }
    }
}
