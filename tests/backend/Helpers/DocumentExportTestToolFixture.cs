using System.Collections.Immutable;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Tests.Unit;

namespace FsusBlog.Server.Tests.Helpers;

/// <summary>
/// Compiles a local deterministic static executable that exercises the production
/// sandbox protocol. It simulates the unavailable canonical renderer boundary; it
/// does not replace or claim integration with the upstream Markdown renderer.
/// </summary>
internal sealed class DocumentExportTestToolFixture : IDisposable
{
    public const string HostBuildDigestSeed = "test-host-build";

    private static readonly Lazy<DocumentExportSystemdCgroupAuthorityContract> s_installedAuthorityContract =
        new(DocumentExportSystemdCgroupAuthority.DiscoverInstalledContract);

    public static readonly string DefaultFragment = """
        <h1 id="heading">Heading 中文 🌍</h1><p dir="rtl">שלום</p><p>&lt;script&gt;escaped raw html&lt;/script&gt;</p><a href="https://example.com/reference">external reference</a><figure><img data-asset-id="3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f" src="data:image/png;base64,iVBORw0KGgo=" alt="hero" /><figcaption>caption</figcaption></figure><table><thead><tr><th>column</th></tr></thead><tbody><tr><td>value</td></tr></tbody></table><pre class="shiki"><code>print(&quot;safe&quot;)</code></pre><figure class="mermaid-static"><svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="diagram"><text x="0" y="15">A to B</text></svg><figcaption>diagram</figcaption></figure><span class="katex" aria-label="x squared">x²</span><p id="note-ref"><a href="#footnote-1">footnote</a></p><aside id="footnote-1">note</aside><section data-embed="preserved"><p>embedded content preserved as static text</p></section>
        """;

    public static readonly ImmutableArray<string> DefaultObservedFeatures =
    [
        "headings", "links", "images", "tables", "code-shiki", "mermaid", "katex-latex",
        "footnotes", "anchors", "embeds", "captions", "cjk", "rtl", "emoji", "page-ebook-limits"
    ];

    public DocumentExportTestToolFixture(
        string? fragment = null,
        string? responseDigest = null)
    {
        Root = Path.Combine(Path.GetTempPath(), $"fsusblog-document-export-{Guid.NewGuid():N}");
        RuntimeRoot = Path.Combine(Root, "tool-runtime");
        string responseFragment = fragment ?? DefaultFragment;
        Tool = CreateTool(RuntimeRoot, responseFragment, responseDigest ?? Digest(responseFragment));
    }

    public string Root
    {
        get;
    }

    public string RuntimeRoot
    {
        get;
    }

    public DocumentExportToolContract Tool
    {
        get;
    }

    public string RunsRoot => Path.Combine(Root, "runs");

    public string HostBuildDigest => Digest(HostBuildDigestSeed);

    public DocumentExportSystemdCgroupAuthority CreateAuthority(int cpuPollIntervalMilliseconds = 10)
        => new(s_installedAuthorityContract.Value, cpuPollIntervalMilliseconds);

    public DocumentExportSandboxRuntime CreateSandbox(
        DocumentExportToolContract? tool = null,
        DocumentExportResourceBudgets? executionLimits = null)
        => new(
            RunsRoot,
            [tool ?? Tool],
            HostBuildDigest,
            CreateAuthority(),
            executionLimits: executionLimits is null
                ? null
                : new Dictionary<string, DocumentExportResourceBudgets>(StringComparer.Ordinal)
                {
                    ["document-export.self-contained-html"] = executionLimits
                });

    public static (DocumentExportFrozenInput Input, DocumentExportTask Task) ValidTask(
        string? markdown = null)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput(
            markdown ?? new string('x', 100_001) + "\n\n# 中文\n\nRTL שלום 🌍");
        return (input, DocumentExportContractTests.ValidTask(input));
    }

    public static byte[] RequestBytes(DocumentExportFrozenInput input, string? mode = null, string? title = null)
        => JsonSerializer.SerializeToUtf8Bytes(new
        {
            schema = DocumentExportContractCatalog.RendererRequestSchema,
            inputId = input.InputId,
            inputDigest = input.ContentDigest,
            sourceDigest = input.SourceDigest,
            rendererId = input.RendererId,
            rendererVersion = input.RendererVersion,
            rendererDigest = input.RendererDigest,
            mode,
            title
        });

    public static string Digest(byte[] value)
        => $"sha256:{Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(value))}";

    public static string Digest(string value) => Digest(Encoding.UTF8.GetBytes(value));

    public DocumentExportToolContract CreateAdditionalTool(
        string fragment,
        string? responseDigest = null)
        => CreateTool(
            Path.Combine(Root, Guid.NewGuid().ToString("N")),
            fragment,
            responseDigest ?? Digest(fragment));

    public void Dispose()
    {
        if (Directory.Exists(Root))
        {
            Directory.Delete(Root, recursive: true);
        }
    }

    private static DocumentExportToolContract CreateTool(
        string runtimeRoot,
        string fragment,
        string responseDigest)
    {
        Directory.CreateDirectory(runtimeRoot);
        string sourcePath = Path.Combine(runtimeRoot, "worker.c");
        string executablePath = Path.Combine(runtimeRoot, "renderer-worker");
        string source = WorkerSource
            .Replace("FRAGMENT_LITERAL", EscapeJsonCString(fragment), StringComparison.Ordinal)
            .Replace("RESPONSE_DIGEST", responseDigest, StringComparison.Ordinal);
        File.WriteAllText(sourcePath, source, new UTF8Encoding(false));
        using Process compiler = Process.Start(new ProcessStartInfo("/usr/bin/cc")
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            ArgumentList =
            {
                "-static",
                "-O2",
                "-o",
                executablePath,
                sourcePath
            }
        }) ?? throw new InvalidOperationException("Unable to start the local document-export test provider compiler.");
        compiler.WaitForExit();
        if (compiler.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"Unable to compile the local document-export provider: {compiler.StandardError.ReadToEnd()}");
        }
        return new DocumentExportToolContract(
            "canonical-markdown-renderer",
            "current-v1",
            executablePath,
            Digest(File.ReadAllBytes(executablePath)),
            runtimeRoot,
            DocumentExportSandboxRuntime.ComputeRuntimeDigest(runtimeRoot),
            ["render"]);
    }

    private static string EscapeJsonCString(string value)
        => JsonSerializer.Serialize(value)[1..^1]
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal)
            .Replace("\r", "", StringComparison.Ordinal)
            .Replace("\n", "\\n", StringComparison.Ordinal);

    private const string WorkerSource = """
        #include <arpa/inet.h>
        #include <netdb.h>
        #include <stdio.h>
        #include <stdlib.h>
        #include <string.h>
        #include <sys/socket.h>
        #include <sys/types.h>
        #include <sys/wait.h>
        #include <unistd.h>

        extern char **environ;

        static char *read_request(void) {
            FILE *stream = fopen("/sandbox/input/request.json", "rb");
            if (!stream) return NULL;
            fseek(stream, 0, SEEK_END);
            long length = ftell(stream);
            rewind(stream);
            char *value = calloc((size_t)length + 1, 1);
            if (!value || fread(value, 1, (size_t)length, stream) != (size_t)length) exit(31);
            fclose(stream);
            return value;
        }

        static char *json_string(const char *json, const char *key) {
            char pattern[96];
            snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
            char *start = strstr((char *)json, pattern);
            if (!start) exit(32);
            start += strlen(pattern);
            char *end = strchr(start, '\"');
            if (!end) exit(33);
            size_t length = (size_t)(end - start);
            char *value = calloc(length + 1, 1);
            memcpy(value, start, length);
            return value;
        }

        static void verify_isolation(void) {
            if (!getenv("HOME") || strcmp(getenv("HOME"), "/sandbox/work") ||
                !getenv("TMPDIR") || strcmp(getenv("TMPDIR"), "/tmp") ||
                !getenv("LANG") || strcmp(getenv("LANG"), "C.UTF-8") ||
                !getenv("PWD") || strcmp(getenv("PWD"), "/sandbox/work")) { fprintf(stderr, "environment-values"); exit(41); }
            int environment_count = 0;
            while (environ[environment_count]) environment_count++;
            if (environment_count != 4) { fprintf(stderr, "environment-count:%d", environment_count); exit(42); }
            FILE *host_file = fopen("/etc/hostname", "rb");
            if (host_file) { fprintf(stderr, "host-file"); exit(43); }
            struct addrinfo *addresses = NULL;
            if (getaddrinfo("example.com", "443", NULL, &addresses) == 0) { fprintf(stderr, "dns"); exit(44); }
            int descriptor = socket(AF_INET, SOCK_STREAM, 0);
            if (descriptor < 0) { fprintf(stderr, "socket-create"); exit(45); }
            struct sockaddr_in address = {0};
            address.sin_family = AF_INET;
            address.sin_port = htons(443);
            inet_pton(AF_INET, "1.1.1.1", &address.sin_addr);
            if (connect(descriptor, (struct sockaddr *)&address, sizeof(address)) == 0) { fprintf(stderr, "network-connect"); exit(46); }
            close(descriptor);
        }

        static void consume_metered_cpu(void) {
            volatile unsigned long value = 1;
            for (;;) {
                value = value * 1664525UL + 1013904223UL;
            }
        }

        int main(int argc, char **argv) {
            if (argc != 2 || strcmp(argv[1], "render")) return 64;
            char *request = read_request();
            if (!request) return 65;
            if (strstr(request, "\"mode\":\"wall-budget\"")) sleep(60);
            if (strstr(request, "\"mode\":\"metered-work\"")) {
                consume_metered_cpu();
            }
            if (strstr(request, "\"mode\":\"memory-budget\"")) {
                size_t length = 64UL * 1024UL * 1024UL;
                volatile unsigned char *memory = malloc(length);
                if (!memory) return 81;
                for (size_t offset = 0; offset < length; offset += 4096) memory[offset] = (unsigned char)offset;
                sleep(60);
            }
            if (strstr(request, "\"mode\":\"stdout-budget\"")) {
                for (long index = 0; index < 1100000L; index++) fputc('x', stdout);
                fflush(stdout);
                return 0;
            }
            if (strstr(request, "\"mode\":\"stderr-budget\"")) {
                for (long index = 0; index < 1100000L; index++) fputc('x', stderr);
                fflush(stderr);
                return 0;
            }
            if (strstr(request, "\"mode\":\"output-budget\"")) {
                FILE *output = fopen("/sandbox/output/response.json", "wb");
                if (!output) return 82;
                int result = ftruncate(fileno(output), 64L * 1024L * 1024L + 1L);
                fclose(output);
                return result == 0 ? 0 : 83;
            }
            if (strstr(request, "\"mode\":\"file-count-budget\"")) {
                for (int index = 0; index < 70; index++) {
                    char path[96];
                    snprintf(path, sizeof(path), "/sandbox/output/file-%d", index);
                    FILE *file = fopen(path, "wb");
                    if (!file) return 87;
                    fclose(file);
                }
                return 0;
            }
            if (strstr(request, "\"mode\":\"file-bytes-budget\"")) {
                FILE *file = fopen("/sandbox/work/large.tmp", "wb");
                if (!file) return 88;
                int result = ftruncate(fileno(file), 64L * 1024L * 1024L + 1L);
                fclose(file);
                return result == 0 ? 0 : 89;
            }
            if (strstr(request, "\"mode\":\"sleep\"")) {
                FILE *started = fopen("/sandbox/work/started", "wb");
                if (!started) return 86;
                fputs("started", started);
                fclose(started);
                sleep(60);
            }
            if (strstr(request, "\"mode\":\"two-files\"")) {
                fclose(fopen("/sandbox/output/extra.txt", "wb"));
                FILE *output = fopen("/sandbox/output/response.json", "wb");
                fputs("{}", output); fclose(output); return 0;
            }
            if (strstr(request, "\"mode\":\"symlink-output\"")) {
                return symlink("/tool/worker.c", "/sandbox/output/response.json") == 0 ? 0 : 66;
            }
            if (strstr(request, "\"mode\":\"many-processes\"")) {
                for (int index = 0; index < 3; index++) {
                    if (fork() == 0) { sleep(60); _exit(0); }
                }
                sleep(60);
            }
            if (strstr(request, "\"mode\":\"daemon-escape\"")) {
                pid_t daemon = fork();
                if (daemon < 0) return 84;
                if (daemon == 0) {
                    if (setsid() < 0) _exit(85);
                    sleep(60);
                    _exit(0);
                }
                sleep(60);
            }
            verify_isolation();
            char *input_id = json_string(request, "inputId");
            char *input_digest = json_string(request, "inputDigest");
            char *source_digest = json_string(request, "sourceDigest");
            char *renderer_id = json_string(request, "rendererId");
            char *renderer_version = json_string(request, "rendererVersion");
            char *renderer_digest = json_string(request, "rendererDigest");
            const char *fragment = "FRAGMENT_LITERAL";
            FILE *output = fopen("/sandbox/output/response.json", "wb");
            if (!output) return 67;
            fprintf(output,
                "{\"schema\":\"fsusblog.document-export-renderer-response.v1\","
                "\"inputId\":\"%s\",\"inputDigest\":\"%s\",\"sourceDigest\":\"%s\","
                "\"rendererId\":\"%s\",\"rendererVersion\":\"%s\",\"rendererDigest\":\"%s\","
                "\"title\":\"\\u79bb\\u7ebf\\u6587\\u6863\",\"htmlFragment\":\"%s\","
                "\"observedFeatures\":[\"headings\",\"links\",\"images\",\"tables\",\"code-shiki\","
                "\"mermaid\",\"katex-latex\",\"footnotes\",\"anchors\",\"embeds\",\"captions\","
                "\"cjk\",\"rtl\",\"emoji\",\"page-ebook-limits\"],\"contentDigest\":\"RESPONSE_DIGEST\"}",
                input_id, input_digest, source_digest, renderer_id, renderer_version, renderer_digest, fragment);
            fclose(output);
            free(request); free(input_id); free(input_digest); free(source_digest);
            free(renderer_id); free(renderer_version); free(renderer_digest);
            return 0;
        }
        """;
}
