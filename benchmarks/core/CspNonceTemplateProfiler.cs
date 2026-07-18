using System.Buffers;
using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.PublicAot;

internal static class CspNonceTemplateProfiler
{
    private const string Placeholder = "%%FSUSBLOG_CSP_NONCE%%";
    private const string Nonce = "profile_nonce_0123456789";

    internal static int Run(string[] args)
    {
        string outputPath = ReadOption(args, "--output")
            ?? Path.Combine(".tmp", "release-evidence", "csp-nonce-template-profile.json");
        string html = CspNonceHtmlHotPathBenchmarks.CreateRepresentativeHtml();
        CspNonceUtf8Template template = CspNonceUtf8Template.Compile(html, "profile:renderer:frontend:digest")
            ?? throw new InvalidOperationException("profile HTML did not compile a nonce template");
        byte[] nonceBytes = Encoding.UTF8.GetBytes(Nonce);
        string legacyTemplate = html
            .Replace("<head>", $"<head><meta property=\"csp-nonce\" nonce=\"{Placeholder}\" />", StringComparison.Ordinal)
            .Replace("<script", $"<script nonce=\"{Placeholder}\"", StringComparison.Ordinal)
            .Replace("<style", $"<style nonce=\"{Placeholder}\"", StringComparison.Ordinal);
        byte[] legacyTemplateBytes = Encoding.UTF8.GetBytes(legacyTemplate);
        var writer = new ReusableBufferWriter(template.GetRenderedLength(nonceBytes.Length));

        int Legacy()
        {
            string decoded = Encoding.UTF8.GetString(legacyTemplateBytes);
            string rendered = decoded.Replace(Placeholder, Nonce, StringComparison.Ordinal);
            return Encoding.UTF8.GetBytes(rendered).Length;
        }

        int Current()
        {
            writer.Reset();
            template.Write(writer, nonceBytes);
            return writer.WrittenCount;
        }

        Measurement before = Measure(Legacy, 2048);
        Measurement after = Measure(Current, 2048);
        writer.Reset();
        template.Write(writer, nonceBytes);
        byte[] renderedBytes = writer.ToArray();
        CompressionEvidence gzip = MeasureCompression(renderedBytes, "gzip");
        CompressionEvidence brotli = MeasureCompression(renderedBytes, "br");
        long legacyCopiedBytes = legacyTemplateBytes.LongLength
            + ((long)legacyTemplate.Length * sizeof(char))
            + ((long)before.ResponseBytes * sizeof(char))
            + before.ResponseBytes;

        var payload = new
        {
            schema = "fsusblog.csp-nonce-template-profile.v1",
            generatedAtUtc = DateTimeOffset.UtcNow,
            machine = new
            {
                processorCount = Environment.ProcessorCount,
                framework = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
                os = System.Runtime.InteropServices.RuntimeInformation.OSDescription
            },
            artifact = new
            {
                sourceUtf8Bytes = Encoding.UTF8.GetByteCount(html),
                responseBytes = after.ResponseBytes,
                template.SlotCount,
                template.ResidentBytes,
                template.TemplateDigest,
                template.ArtifactIdentity,
                staticInlineHashCount = template.StaticInlineSha256Sources.Count
            },
            before = new
            {
                path = "decode complete UTF-8 + replace complete string + encode complete byte array",
                before.MeanNanoseconds,
                before.P999Nanoseconds,
                before.AllocatedBytesPerOperation,
                estimatedBytesCopiedPerOperation = legacyCopiedBytes,
                lohArraysPerOperation = before.ResponseBytes >= 85_000 ? 1 : 0,
                lohStringsPerOperation = legacyTemplate.Length * sizeof(char) >= 85_000 ? 2 : 0
            },
            after = new
            {
                path = "precompiled UTF-8 segments + one nonce encode + BodyWriter",
                after.MeanNanoseconds,
                after.P999Nanoseconds,
                after.AllocatedBytesPerOperation,
                estimatedBytesCopiedPerOperation = after.ResponseBytes,
                lohAllocationsPerOperation = 0
            },
            ratios = new
            {
                mean = Ratio(after.MeanNanoseconds, before.MeanNanoseconds),
                p999 = Ratio(after.P999Nanoseconds, before.P999Nanoseconds),
                allocation = Ratio(after.AllocatedBytesPerOperation, before.AllocatedBytesPerOperation),
                copiedBytes = Ratio(after.ResponseBytes, legacyCopiedBytes)
            },
            compression = new
            {
                identityBytes = renderedBytes.Length,
                gzip,
                brotli,
                selected = "identity-streaming",
                reason = "PublicHotRead bypasses response compression; per-request compression would allocate/render a mutable entity. Static documents retain publish-time br/gzip variants."
            }
        };

        string fullPath = Path.GetFullPath(outputPath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        File.WriteAllText(fullPath, string.Concat(JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true }), "\n"));
        Console.WriteLine(fullPath);
        return 0;
    }

    private static Measurement Measure(Func<int> operation, int samples)
    {
        for (int i = 0; i < 128; i++)
        {
            operation();
        }

        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        var elapsed = new long[samples];
        long allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
        int responseBytes = 0;
        for (int i = 0; i < samples; i++)
        {
            long started = Stopwatch.GetTimestamp();
            responseBytes = operation();
            elapsed[i] = Stopwatch.GetTimestamp() - started;
        }

        long allocated = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
        Array.Sort(elapsed);
        double tickNanoseconds = 1_000_000_000d / Stopwatch.Frequency;
        return new Measurement(
            elapsed.Average() * tickNanoseconds,
            elapsed[(int)Math.Ceiling(samples * 0.999) - 1] * tickNanoseconds,
            (double)allocated / samples,
            responseBytes);
    }

    private static CompressionEvidence MeasureCompression(byte[] bytes, string encoding)
    {
        byte[] Compress()
        {
            using var output = new MemoryStream();
            using (Stream compressor = encoding == "br"
                ? new BrotliStream(output, CompressionLevel.Fastest, leaveOpen: true)
                : new GZipStream(output, CompressionLevel.Fastest, leaveOpen: true))
            {
                compressor.Write(bytes);
            }

            return output.ToArray();
        }

        byte[] compressed = Compress();
        Measurement measurement = Measure(() => Compress().Length, 256);
        return new CompressionEvidence(
            compressed.Length,
            measurement.MeanNanoseconds,
            measurement.P999Nanoseconds,
            measurement.AllocatedBytesPerOperation);
    }

    private static string? ReadOption(string[] args, string name)
    {
        int index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static double Ratio(double numerator, double denominator)
        => denominator == 0 ? (numerator == 0 ? 0 : double.PositiveInfinity) : numerator / denominator;

    private readonly record struct Measurement(
        double MeanNanoseconds,
        double P999Nanoseconds,
        double AllocatedBytesPerOperation,
        int ResponseBytes);

    private readonly record struct CompressionEvidence(
        int Bytes,
        double MeanNanoseconds,
        double P999Nanoseconds,
        double AllocatedBytesPerOperation);

    private sealed class ReusableBufferWriter(int capacity) : IBufferWriter<byte>
    {
        private readonly byte[] _buffer = new byte[capacity];
        private int _written;
        public int WrittenCount => _written;
        public byte[] ToArray() => _buffer.AsSpan(0, _written).ToArray();
        public void Reset() => _written = 0;
        public void Advance(int count) => _written = checked(_written + count);
        public Memory<byte> GetMemory(int sizeHint = 0) => _buffer.AsMemory(_written);
        public Span<byte> GetSpan(int sizeHint = 0) => _buffer.AsSpan(_written);
    }
}
