using System.Diagnostics;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration;

internal sealed record CurrentSchemaProducerFile(string RelativePath, long Bytes, string Sha256);

internal sealed record CurrentSchemaProducerExecution(
    string AssemblyPath,
    string SourceRevision,
    string DotnetHostPath,
    string DotnetHostSha256,
    IReadOnlyList<CurrentSchemaProducerFile> ProducerFiles,
    string EvidenceDirectory,
    string ArtifactPath,
    string ArtifactSha256,
    int ExitCode);

// Only an actual successful invocation can construct this capability. A caller JSON,
// a claimed producer identity or a matching hash alone cannot create it.
internal sealed class OwnedCurrentSchemaTarget
{
    private readonly CurrentSchemaOwnedTargetArtifact _artifact;

    private OwnedCurrentSchemaTarget(CurrentSchemaOwnedTargetArtifact artifact, CurrentSchemaProducerExecution execution)
    {
        _artifact = artifact;
        Execution = execution;
    }

    internal CurrentSchemaProducerExecution Execution { get; }

    internal CurrentSchemaIdentity Target => _artifact.Target;

    internal CurrentSchemaCompletePhysicalProjection ProjectExpectedPhysicalTarget(SchemaProviderKind provider)
    {
        ValidateArtifact(_artifact, _artifact.Input.Producer);
        return CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(ReadBoundInput(), provider);
    }

    internal CompiledCurrentSchemaBootstrap Compile(SchemaProviderKind provider)
    {
        ValidateArtifact(_artifact, _artifact.Input.Producer);
        return CurrentSchemaBootstrapCompiler.Compile(
            _artifact.Input, _artifact.Input.Producer, provider, _artifact.InputSha256);
    }

    internal CurrentSchemaBootstrapInput ReadBoundInput()
    {
        ValidateArtifact(_artifact, _artifact.Input.Producer);
        // The consumer gets its own copy; mutating it cannot mutate the retained capability.
        return JsonSerializer.Deserialize<CurrentSchemaBootstrapInput>(JsonSerializer.SerializeToUtf8Bytes(_artifact.Input), s_json)!;
    }

    internal static async Task<OwnedCurrentSchemaTarget> InvokeOriginalOwnerAsync(
        string producerAssemblyPath, string expectedSourceRevision, string taskOutputRoot,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string assemblyPath = Path.GetFullPath(producerAssemblyPath);
        string producerRoot = Path.GetDirectoryName(assemblyPath)!;
        string outputRoot = Path.GetFullPath(taskOutputRoot);
        if (Path.GetFileName(assemblyPath) != "FsusBlog.Server.dll" || !Directory.Exists(outputRoot)
            || outputRoot == producerRoot || outputRoot.StartsWith(producerRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            || !IsSourceRevision(expectedSourceRevision))
        {
            throw new InvalidOperationException("current_schema_owned_producer_configuration_invalid");
        }
        RequireRegularPath(assemblyPath);
        RequireRegularPath(outputRoot);
        string revision = ReadOriginalOwnerSourceRevision(assemblyPath);
        if (revision != expectedSourceRevision)
        {
            throw new InvalidOperationException("current_schema_owned_producer_source_mismatch");
        }
        string sharedPath = Path.Combine(producerRoot, Path.GetFileName(typeof(CurrentSchemaCanonicalAuthority).Assembly.Location));
        RequireRegularPath(sharedPath);
        string contractDigest = await HashFileAsync(typeof(CurrentSchemaCanonicalAuthority).Assembly.Location, cancellationToken).ConfigureAwait(false);
        if (await HashFileAsync(sharedPath, cancellationToken).ConfigureAwait(false) != contractDigest)
        {
            throw new InvalidOperationException("current_schema_owned_producer_contract_mismatch");
        }
        RequireRegularPath(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        RequireRegularPath(Path.ChangeExtension(assemblyPath, ".deps.json"));
        string dotnetHost = Path.GetFullPath(Path.Combine(RuntimeEnvironment.GetRuntimeDirectory(), "..", "..", "..",
            OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet"));
        RequireRegularPath(dotnetHost);
        string hostDigest = await HashFileAsync(dotnetHost, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<CurrentSchemaProducerFile> before = await SnapshotProducerAsync(producerRoot, cancellationToken).ConfigureAwait(false);
        var expectedProducer = new CurrentSchemaProducerIdentity(revision, "fsusblog.current-schema-owned-projection.v1",
            await HashFileAsync(assemblyPath, cancellationToken).ConfigureAwait(false), contractDigest);

        string evidenceDirectory = Path.Combine(outputRoot, "current-schema-owned-export-" + Guid.NewGuid().ToString("N"));
        if (Directory.Exists(evidenceDirectory) || File.Exists(evidenceDirectory))
        {
            throw new InvalidOperationException("current_schema_owned_export_evidence_already_exists");
        }
        Directory.CreateDirectory(evidenceDirectory);
        string artifactPath = Path.Combine(evidenceDirectory, "current-owned-target.json");
        await WriteNewJsonAsync(Path.Combine(evidenceDirectory, "producer-before.json"), before, cancellationToken).ConfigureAwait(false);
        try
        {
            int exitCode = await InvokeAsync(dotnetHost, assemblyPath, artifactPath, evidenceDirectory, cancellationToken).ConfigureAwait(false);
            IReadOnlyList<CurrentSchemaProducerFile> after = await SnapshotProducerAsync(producerRoot, cancellationToken).ConfigureAwait(false);
            await WriteNewJsonAsync(Path.Combine(evidenceDirectory, "producer-after.json"), after, cancellationToken).ConfigureAwait(false);
            if (!before.SequenceEqual(after) || await HashFileAsync(dotnetHost, cancellationToken).ConfigureAwait(false) != hostDigest
                || await HashFileAsync(typeof(CurrentSchemaCanonicalAuthority).Assembly.Location, cancellationToken).ConfigureAwait(false) != contractDigest)
            {
                throw new InvalidOperationException("current_schema_owned_producer_changed_during_export");
            }
            if (exitCode != 0)
            {
                throw new InvalidOperationException($"current_schema_owned_producer_failed:{exitCode}");
            }
            RequireRegularPath(artifactPath);
            byte[] bytes = await File.ReadAllBytesAsync(artifactPath, cancellationToken).ConfigureAwait(false);
            CurrentSchemaOwnedTargetArtifact artifact = ReadArtifact(bytes, expectedProducer);
            var execution = new CurrentSchemaProducerExecution(assemblyPath, revision, dotnetHost, hostDigest,
                before, evidenceDirectory, artifactPath, Hash(bytes), exitCode);
            await WriteNewJsonAsync(Path.Combine(evidenceDirectory, "execution.json"), execution, cancellationToken).ConfigureAwait(false);
            await WriteNewJsonAsync(Path.Combine(evidenceDirectory, "result.json"), new
            {
                successfulProducerInvocation = true,
                artifactPath,
                rawStdout = Path.Combine(evidenceDirectory, "stdout.log"),
                rawStderr = Path.Combine(evidenceDirectory, "stderr.log")
            }, cancellationToken).ConfigureAwait(false);
            return new OwnedCurrentSchemaTarget(artifact, execution);
        }
        catch (Exception exception)
        {
            string failureCode = exception is OperationCanceledException ? "current_schema_owned_export_cancelled"
                : exception.Message.Split(':', 2)[0];
            // Retain actual raw output even when export/validation is rejected. This is
            // producer evidence, not apply admission or a completed native operation.
            using var evidenceCancellation = new CancellationTokenSource();
            try
            {
                await WriteNewJsonAsync(Path.Combine(evidenceDirectory, "rejection.json"), new
                {
                    successfulProducerInvocation = false,
                    failureCode,
                    artifactPath,
                    rawStdout = Path.Combine(evidenceDirectory, "stdout.log"),
                    rawStderr = Path.Combine(evidenceDirectory, "stderr.log")
                }, evidenceCancellation.Token).ConfigureAwait(false);
            }
            catch (Exception retentionFailure)
            {
                throw new AggregateException("current_schema_owned_export_failure_evidence_unsealed", exception, retentionFailure);
            }
            throw;
        }
    }

    internal static CurrentSchemaOwnedTargetArtifact ReadArtifact(byte[] bytes, CurrentSchemaProducerIdentity expectedProducer)
    {
        using JsonDocument document = JsonDocument.Parse(bytes);
        RejectDuplicateProperties(document.RootElement);
        CurrentSchemaOwnedTargetArtifact artifact = JsonSerializer.Deserialize<CurrentSchemaOwnedTargetArtifact>(bytes, s_json)
            ?? throw new InvalidOperationException("current_schema_owned_artifact_empty");
        ValidateArtifact(artifact, expectedProducer);
        return artifact;
    }

    private static void ValidateArtifact(CurrentSchemaOwnedTargetArtifact artifact, CurrentSchemaProducerIdentity expectedProducer)
    {
        if (artifact.SchemaVersion != CurrentSchemaOwnedTargetProjection.ArtifactSchemaVersion
            || artifact.Input.Producer != expectedProducer
            || artifact.InputSha256 != CurrentSchemaOwnedTargetProjection.ComputeInputDigest(artifact.Input)
            || artifact.Target != CurrentSchemaOwnedTargetProjection.Observe(artifact.Input))
        {
            throw new InvalidOperationException("current_schema_owned_artifact_binding_invalid");
        }
    }

    private static readonly JsonSerializerOptions s_json = new()
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    private static void RejectDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!keys.Add(property.Name))
                {
                    throw new InvalidOperationException("current_schema_owned_artifact_duplicate_property");
                }
                RejectDuplicateProperties(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicateProperties(item);
            }
        }
    }

    private static async Task<int> InvokeAsync(string host, string assembly, string output, string evidence, CancellationToken cancellationToken)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo(host)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(assembly)!
            }
        };
        process.StartInfo.ArgumentList.Add(assembly);
        process.StartInfo.ArgumentList.Add("export-current-schema-owned-target");
        process.StartInfo.ArgumentList.Add("--output");
        process.StartInfo.ArgumentList.Add(output);
        await using var stdout = new FileStream(Path.Combine(evidence, "stdout.log"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        await using var stderr = new FileStream(Path.Combine(evidence, "stderr.log"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        cancellationToken.ThrowIfCancellationRequested();
        if (!process.Start())
        {
            throw new InvalidOperationException("current_schema_owned_export_start_failed");
        }
        Task outputTask = process.StandardOutput.BaseStream.CopyToAsync(stdout);
        Task errorTask = process.StandardError.BaseStream.CopyToAsync(stderr);
        Exception? failure = null;
        try
        {
            Task exitTask = process.WaitForExitAsync(cancellationToken);
            Task rawTask = Task.WhenAll(outputTask, errorTask);
            Task completed = await Task.WhenAny(exitTask, rawTask).ConfigureAwait(false);
            if (completed == rawTask)
            {
                await rawTask.ConfigureAwait(false);
            }
            await exitTask.ConfigureAwait(false);
            await Task.WhenAll(outputTask, errorTask).WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            failure = exception;
            using var terminalDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
                await process.WaitForExitAsync(terminalDeadline.Token).ConfigureAwait(false);
                await Task.WhenAll(outputTask, errorTask).WaitAsync(terminalDeadline.Token).ConfigureAwait(false);
            }
            catch (Exception cleanupFailure)
            {
                failure = new AggregateException("current_schema_owned_export_terminal_unproven", exception, cleanupFailure);
            }
        }
        try
        {
            stdout.Flush(flushToDisk: true);
            stderr.Flush(flushToDisk: true);
            using var evidenceCancellation = new CancellationTokenSource();
            await WriteNewJsonAsync(Path.Combine(evidence, "child-terminal.json"), new
            {
                processId = process.Id,
                childTerminalObserved = process.HasExited,
                childExitCode = process.HasExited ? process.ExitCode : (int?)null,
                taskTreeQualification = false
            }, evidenceCancellation.Token).ConfigureAwait(false);
        }
        catch (Exception retentionFailure)
        {
            failure = failure is null ? retentionFailure
                : new AggregateException("current_schema_owned_export_terminal_evidence_unsealed", failure, retentionFailure);
        }
        if (failure is not null)
        {
            ExceptionDispatchInfo.Capture(failure).Throw();
        }
        return process.ExitCode;
    }

    private static async Task<IReadOnlyList<CurrentSchemaProducerFile>> SnapshotProducerAsync(string root, CancellationToken cancellationToken)
    {
        var result = new List<CurrentSchemaProducerFile>();
        foreach (string entry in Directory.EnumerateFileSystemEntries(root).Order(StringComparer.Ordinal))
        {
            RequireRegularPath(entry);
            if (Directory.Exists(entry))
            {
                foreach (CurrentSchemaProducerFile child in await SnapshotProducerAsync(entry, cancellationToken).ConfigureAwait(false))
                {
                    result.Add(child with { RelativePath = Path.Combine(Path.GetFileName(entry), child.RelativePath) });
                }
            }
            else
            {
                result.Add(new CurrentSchemaProducerFile(Path.GetFileName(entry), new FileInfo(entry).Length,
                    await HashFileAsync(entry, cancellationToken).ConfigureAwait(false)));
            }
        }
        return result;
    }

    private static string ReadOriginalOwnerSourceRevision(string assemblyPath)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        MetadataReader reader = pe.GetMetadataReader();
        AssemblyDefinition assembly = reader.GetAssemblyDefinition();
        if (reader.GetString(assembly.Name) != "FsusBlog.Server")
        {
            throw new InvalidOperationException("current_schema_owned_producer_assembly_invalid");
        }
        var revisions = new List<string>();
        foreach (CustomAttributeHandle handle in assembly.GetCustomAttributes())
        {
            CustomAttribute attribute = reader.GetCustomAttribute(handle);
            if (attribute.Constructor.Kind != HandleKind.MemberReference)
            {
                continue;
            }
            MemberReference constructor = reader.GetMemberReference((MemberReferenceHandle)attribute.Constructor);
            if (constructor.Parent.Kind != HandleKind.TypeReference)
            {
                continue;
            }
            TypeReference type = reader.GetTypeReference((TypeReferenceHandle)constructor.Parent);
            if (reader.GetString(type.Namespace) != "System.Reflection" || reader.GetString(type.Name) != "AssemblyMetadataAttribute")
            {
                continue;
            }
            BlobReader value = reader.GetBlobReader(attribute.Value);
            if (value.ReadUInt16() != 1)
            {
                throw new InvalidOperationException("current_schema_owned_producer_metadata_invalid");
            }
            string? key = value.ReadSerializedString();
            string? metadata = value.ReadSerializedString();
            if (key == "FsusBlog.SourceCommit")
            {
                if (metadata is null || !IsSourceRevision(metadata))
                {
                    throw new InvalidOperationException("current_schema_owned_producer_source_missing");
                }
                revisions.Add(metadata);
            }
        }
        return revisions.Count == 1 ? revisions[0]
            : throw new InvalidOperationException("current_schema_owned_producer_source_missing");
    }

    private static bool IsSourceRevision(string value)
        => value.Length == 40 && value.Any(static character => character != '0')
            && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static void RequireRegularPath(string path)
    {
        string full = Path.GetFullPath(path);
        for (string? cursor = full; cursor is not null; cursor = Path.GetDirectoryName(cursor))
        {
            if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException("current_schema_owned_producer_symbolic_path");
            }
        }
    }

    private static async Task<string> HashFileAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken).ConfigureAwait(false)).ToLowerInvariant();
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static async Task WriteNewJsonAsync<T>(string path, T value, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read,
            4096, FileOptions.Asynchronous | FileOptions.WriteThrough);
        await JsonSerializer.SerializeAsync(stream, value, cancellationToken: cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        stream.Flush(flushToDisk: true);
    }
}
