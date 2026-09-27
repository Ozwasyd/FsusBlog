using System.Globalization;
using System.Text.RegularExpressions;

using Xunit;

namespace FsusBlog.Migration.Tests;

/// <summary>
/// Consumes only an already admitted MySQL service. The enclosing scheduler
/// must own the resource grant, container lifecycle, observation and cleanup.
/// </summary>
public sealed class MySqlDdlFixture : IAsyncLifetime
{
    private readonly Func<string, string?> _readEnvironment;
    private MySqlDdlClient? _client;

    public MySqlDdlFixture() : this(Environment.GetEnvironmentVariable)
    {
    }

    internal MySqlDdlFixture(Func<string, string?> readEnvironment)
    {
        _readEnvironment = readEnvironment;
    }

    public string EngineVersion { get; private set; } = string.Empty;

    public async Task InitializeAsync()
    {
        string clientFile = RequiredEnvironment("FSUSBLOG_MYSQL_FIXTURE_CLIENT_FILE");
        if (!Path.IsPathFullyQualified(clientFile)
            || !File.Exists(clientFile)
            || (File.GetAttributes(clientFile) & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidOperationException("MySQL fixture requires a regular, absolute private client file.");
        }
        if (OperatingSystem.IsLinux()
            && (File.GetUnixFileMode(clientFile) & ~(UnixFileMode.UserRead | UnixFileMode.UserWrite)) != 0)
        {
            throw new InvalidOperationException("MySQL fixture client file is not private.");
        }
        if (new FileInfo(clientFile).Length != 83)
        {
            throw new InvalidOperationException("MySQL fixture client file has an unexpected shape.");
        }
        string contents = File.ReadAllText(clientFile);
        Match password = Regex.Match(contents, @"\A\[client\]\npassword=([a-f0-9]{64})\n\z", RegexOptions.CultureInvariant);
        if (!password.Success)
        {
            throw new InvalidOperationException("MySQL fixture client file has an unexpected shape.");
        }

        string portText = RequiredEnvironment("FSUSBLOG_MYSQL_FIXTURE_PORT");
        string uuidText = RequiredEnvironment("FSUSBLOG_MYSQL_FIXTURE_SERVER_UUID");
        string timeoutText = RequiredEnvironment("FSUSBLOG_MYSQL_FIXTURE_TIMEOUT_SECONDS");
        if (!uint.TryParse(portText, NumberStyles.None, CultureInfo.InvariantCulture, out uint port)
            || !Guid.TryParseExact(uuidText, "D", out Guid serverUuid)
            || !uint.TryParse(timeoutText, NumberStyles.None, CultureInfo.InvariantCulture, out uint timeoutSeconds))
        {
            throw new InvalidOperationException("MySQL fixture observation or operation budget is malformed.");
        }
        string expectedVersion = RequiredEnvironment("FSUSBLOG_MYSQL_FIXTURE_SERVER_VERSION");
        var client = new MySqlDdlClient(
            port,
            "fixture_user",
            password.Groups[1].Value,
            RequiredEnvironment("FSUSBLOG_MYSQL_FIXTURE_DATABASE_PREFIX"),
            serverUuid,
            expectedVersion,
            timeoutSeconds);
        string observedVersion = (await client.ExecuteAsync(null, "SELECT VERSION();")).RequireSuccess();
        if (observedVersion != expectedVersion)
        {
            throw new InvalidOperationException("MySQL fixture engine version changed after service admission.");
        }
        _client = client;
        EngineVersion = observedVersion;
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public Task<string> CreateDatabaseAsync()
        => RequireClient().CreateDatabaseAsync();

    public Task<MySqlDdlClient.SqlResult> ExecuteAsync(
        string? database,
        string sql,
        CancellationToken cancellationToken = default)
        => RequireClient().ExecuteAsync(database, sql, cancellationToken);

    private MySqlDdlClient RequireClient()
        => _client ?? throw new InvalidOperationException("MySQL fixture service was not admitted.");

    private string RequiredEnvironment(string name)
    {
        string? value = _readEnvironment(name);
        return string.IsNullOrWhiteSpace(value)
            ? throw new InvalidOperationException($"MySQL fixture requires {name} from its scheduler owner.")
            : value;
    }
}
