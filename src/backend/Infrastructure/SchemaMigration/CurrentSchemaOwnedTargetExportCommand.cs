using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

/// <summary>Runs the original current owner without starting the Web host or observing a database.</summary>
public static class CurrentSchemaOwnedTargetExportCommand
{
    /// <summary>The explicit read-only producer command; it does not select a runtime host mode.</summary>
    public const string Command = "export-current-schema-owned-target";

    /// <summary>Recognizes the export-only command before runtime host configuration.</summary>
    public static bool IsRequested(IReadOnlyList<string> arguments)
        => arguments.Count > 0 && arguments[0] == Command;

    /// <summary>Publishes a new, complete owned artifact; failure never authorizes migration.</summary>
    /// <param name="arguments">The command, <c>--output</c>, and a new absolute task-owned file path.</param>
    /// <param name="cancellationToken">Cancels export; existing or unpublished bytes are not deleted.</param>
    /// <returns>Zero only after the original producer has published the complete artifact.</returns>
    public static async Task<int> RunAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken)
    {
        var artifact = await CurrentSchemaOwnedProjectionExporter.WriteArtifactAsync(
            ParseOutputPath(arguments), cancellationToken).ConfigureAwait(false);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            status = "exported",
            producer = CurrentSchemaOwnedProjectionExporter.ProducerId,
            inputSha256 = artifact.InputSha256,
            target = artifact.Target
        }));
        return 0;
    }

    internal static string ParseOutputPath(IReadOnlyList<string> arguments)
    {
        if (arguments.Count != 3 || arguments[0] != Command || arguments[1] != "--output"
            || !Path.IsPathFullyQualified(arguments[2]))
        {
            throw new InvalidOperationException("current_schema_export_command_invalid");
        }
        string path = Path.GetFullPath(arguments[2]);
        if (File.Exists(path) || Directory.Exists(path) || !Directory.Exists(Path.GetDirectoryName(path)))
        {
            throw new InvalidOperationException("current_schema_export_output_not_new");
        }
        return path;
    }
}
