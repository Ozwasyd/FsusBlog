using System.Diagnostics;
using System.Text.Json;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotNodeSsrRenderer(
    IWebHostEnvironment env,
    IConfiguration configuration,
    ILogger<PublicAotNodeSsrRenderer> logger) : IPublicAotSsrRenderer
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly IWebHostEnvironment _env = env;
    private readonly IConfiguration _configuration = configuration;
    private readonly ILogger<PublicAotNodeSsrRenderer> _logger = logger;
    private readonly string _nodeExecutable = configuration["PublicAot:SsrNodePath"]?.Trim() is { Length: > 0 } configuredNode
        ? configuredNode
        : "node";

    public async Task<Result<PublicAotSsrRenderResult>> RenderAsync(
        PublicPageKind kind,
        string hydrationPropsJson,
        CancellationToken cancellationToken = default)
    {
        Result<string> clientRoot = ResolveClientRoot();
        if (clientRoot.IsFailure || string.IsNullOrWhiteSpace(clientRoot.Value))
        {
            return Result<PublicAotSsrRenderResult>.Failure(clientRoot.Error);
        }

        return await BoundaryExecutor.ExecuteValueAsync(
            () => RenderCoreAsync(clientRoot.Value!, kind, hydrationPropsJson, cancellationToken),
            ex => Result<PublicAotSsrRenderResult>.Failure(MapRenderException(ex)),
            _logger,
            $"public-aot-ssr:{kind}",
            LogLevel.Error);
    }

    private async Task<Result<PublicAotSsrRenderResult>> RenderCoreAsync(
        string clientRoot,
        PublicPageKind kind,
        string hydrationPropsJson,
        CancellationToken cancellationToken)
    {
        var request = new
        {
            pageKind = kind.ToString(),
            hydrationPropsJson
        };

        var startInfo = new ProcessStartInfo
        {
            FileName = _nodeExecutable,
            WorkingDirectory = clientRoot,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add("./scripts/server-public-ssr.mjs");

        using var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        if (!process.Start())
        {
            return Result<PublicAotSsrRenderResult>.Failure(ErrorCode.InfraFailure, "failed to start public AOT SSR worker process");
        }

        string stdinPayload = JsonSerializer.Serialize(request, JsonOptions);
        await process.StandardInput.WriteAsync(stdinPayload);
        await process.StandardInput.FlushAsync();
        process.StandardInput.Close();

        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
        Task<string> stderrTask = process.StandardError.ReadToEndAsync();

        await process.WaitForExitAsync(cancellationToken);
        string stdout = await stdoutTask;
        string stderr = await stderrTask;

        if (process.ExitCode != 0)
        {
            _logger.LogError(
                "Public AOT SSR worker exited with code {ExitCode}. stderr={Stderr}",
                process.ExitCode,
                string.IsNullOrWhiteSpace(stderr) ? "<empty>" : stderr);
            return Result<PublicAotSsrRenderResult>.Failure(
                ErrorCode.InfraFailure,
                $"public AOT SSR worker failed with exit code {process.ExitCode}");
        }

        return ParseWorkerResponse(stdout);
    }

    private Result<PublicAotSsrRenderResult> ParseWorkerResponse(string stdout)
    {
        try
        {
            PublicAotSsrWorkerResponse? response = JsonSerializer.Deserialize<PublicAotSsrWorkerResponse>(stdout, JsonOptions);
            if (response is null || string.IsNullOrWhiteSpace(response.Html))
            {
                return Result<PublicAotSsrRenderResult>.Failure(ErrorCode.InfraFailure, "public AOT SSR worker returned empty html");
            }

            return Result<PublicAotSsrRenderResult>.Success(new PublicAotSsrRenderResult(
                response.Html,
                string.IsNullOrWhiteSpace(response.RendererVersion)
                    ? PublicAotShellService.PublicRendererVersion
                    : response.RendererVersion));
        }
        catch (JsonException ex)
        {
            _logger.LogError(ex, "Public AOT SSR worker returned invalid JSON. stdout={Stdout}", stdout);
            return Result<PublicAotSsrRenderResult>.Failure(ErrorCode.InfraFailure, "public_aot_ssr_invalid_json");
        }
    }

    private Result<string> ResolveClientRoot()
    {
        string? configured = _configuration["PublicAot:SsrClientRoot"];
        if (!string.IsNullOrWhiteSpace(configured) && Directory.Exists(configured))
        {
            return Result<string>.Success(Path.GetFullPath(configured));
        }

        string[] candidates =
        [
            Path.Combine(_env.ContentRootPath, "..", "FsusBlog.Client"),
            Path.Combine(_env.ContentRootPath, "FsusBlog.Client"),
            Path.Combine(_env.ContentRootPath, "FsusBlog.ClientRuntime")
        ];

        foreach (string candidate in candidates)
        {
            string normalized = Path.GetFullPath(candidate);
            if (Directory.Exists(normalized))
            {
                return Result<string>.Success(normalized);
            }
        }

        return Result<string>.Failure(ErrorCode.InfraFailure, "unable to resolve client root for public AOT SSR worker");
    }

    private static ErrorDetail MapRenderException(Exception exception)
    {
        return exception switch
        {
            InvalidOperationException => ErrorDetail.Create(ErrorCode.InfraFailure, exception.Message),
            DirectoryNotFoundException => ErrorDetail.Create(ErrorCode.InfraFailure, exception.Message),
            JsonException => ErrorDetail.Create(ErrorCode.InfraFailure, "public AOT SSR worker returned invalid JSON"),
            _ => ErrorDetail.Create(ErrorCode.InfraFailure, "public AOT SSR worker failed")
        };
    }

    private sealed class PublicAotSsrWorkerResponse
    {
        public string Html { get; init; } = string.Empty;
        public string RendererVersion { get; init; } = string.Empty;
    }
}
