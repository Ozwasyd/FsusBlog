using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Server.Services.Security;

public interface IPerceptionCharacterV3Renderer
{
    byte[] RenderVisual(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default);
    byte[] RenderAudio(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default);
}

public sealed record PerceptionCharacterV3SpokenAtlas(string Schema, int SampleRate, int Channels, int BitsPerSample, string Alphabet, Dictionary<string, PerceptionCharacterV3SpokenUnit> Units);
public sealed record PerceptionCharacterV3SpokenUnit(string SpokenName, int SampleCount, string Sha256, string Pcm16Base64);

public static class PerceptionCharacterV3SpokenAtlasContract
{
    private static readonly Lazy<PerceptionCharacterV3SpokenAtlas> s_value = new(Load, LazyThreadSafetyMode.ExecutionAndPublication);
    public static PerceptionCharacterV3SpokenAtlas Value => s_value.Value;

    private static PerceptionCharacterV3SpokenAtlas Load()
    {
        using Stream stream = typeof(PerceptionCharacterV3SpokenAtlasContract).Assembly.GetManifestResourceStream("FsusBlog.PerceptionCharacterV3.SpokenAtlas.json")
            ?? throw new InvalidOperationException("PerceptionCharacterV3 spoken atlas resource is missing.");
        PerceptionCharacterV3SpokenAtlas atlas = JsonSerializer.Deserialize<PerceptionCharacterV3SpokenAtlas>(stream, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("PerceptionCharacterV3 spoken atlas is invalid.");
        if (atlas.Schema != "fsus.perception-character.spoken-atlas.v1" || atlas.SampleRate != 12_000 || atlas.Channels != 1 || atlas.BitsPerSample != 16 || atlas.Alphabet != PerceptionCharacterV3CanonicalContract.Value.Answer.Alphabet)
            throw new InvalidOperationException("PerceptionCharacterV3 spoken atlas metadata is invalid.");
        foreach (char symbol in atlas.Alphabet)
        {
            if (!atlas.Units.TryGetValue(symbol.ToString(), out PerceptionCharacterV3SpokenUnit? unit))
                throw new InvalidOperationException("PerceptionCharacterV3 spoken atlas unit is missing.");
            byte[] pcm = Convert.FromBase64String(unit.Pcm16Base64);
            if (pcm.Length != checked(unit.SampleCount * 2) || Convert.ToHexStringLower(SHA256.HashData(pcm)) != unit.Sha256 || string.IsNullOrWhiteSpace(unit.SpokenName))
                throw new InvalidOperationException("PerceptionCharacterV3 spoken atlas unit failed integrity validation.");
        }
        return atlas;
    }
}

public sealed class PerceptionCharacterV3Renderer : IPerceptionCharacterV3Renderer
{
    public byte[] RenderVisual(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default)
    {
        string normalized = PerceptionCharacterV3Crypto.NormalizeAnswer(answer) ?? throw new ArgumentException("Invalid V3 answer.", nameof(answer));
        PerceptionCharacterV3RasterContract c = PerceptionCharacterV3CanonicalContract.Value.Raster;
        var random = new RasterRandom(seed);
        int width = c.PhysicalWidth, height = c.PhysicalHeight;
        byte[] pixels = GC.AllocateUninitializedArray<byte>(checked(width * height));
        Array.Fill(pixels, (byte)255);
        int originX = 52;
        for (int index = 0; index < normalized.Length; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int variant = random.Integer(0, c.GlyphVariantsPerSymbol - 1);
            int tx = random.Integer(c.TranslationX.Min, c.TranslationX.Max), ty = random.Integer(c.TranslationY.Min, c.TranslationY.Max);
            int rotation = random.Integer(c.RotationDegrees.Min, c.RotationDegrees.Max);
            double shear = random.Integer((int)Math.Round(c.ShearX.Min * 100), (int)Math.Round(c.ShearX.Max * 100)) / 100d;
            double scaleX = random.Integer((int)Math.Round(c.ScaleX.Min * 100), (int)Math.Round(c.ScaleX.Max * 100)) / 100d;
            double scaleY = random.Integer((int)Math.Round(c.ScaleY.Min * 100), (int)Math.Round(c.ScaleY.Max * 100)) / 100d;
            int baseline = random.Integer(c.BaselineOffsetPixels.Min, c.BaselineOffsetPixels.Max);
            int overlap = index == normalized.Length - 1 ? 0 : random.Integer(c.OverlapPixels.Min, c.OverlapPixels.Max);
            int gray = random.Integer(0, 64);
            DrawGlyph(pixels, width, height, normalized[index].ToString(), variant, originX + 35 + tx, 96 + ty + baseline, rotation, shear, scaleX, scaleY, gray, c, cancellationToken);
            originX += 82 - overlap;
        }
        int curveCount = random.Integer(c.InterferenceCurves.MinCount, c.InterferenceCurves.MaxCount);
        for (int i = 0; i < curveCount; i++)
            DrawCurve(pixels, width, height, random.Integer(0, 96), random.Integer(16, 175), random.Integer(176, 336), random.Integer(0, 191), random.Integer(415, 511), random.Integer(16, 175), random.Integer(c.InterferenceCurves.MinWidthPixels, c.InterferenceCurves.MaxWidthPixels), random.Integer(c.InterferenceCurves.MinGray, c.InterferenceCurves.MaxGray), cancellationToken);
        int occluderCount = random.Integer(c.Occluders.MinCount, c.Occluders.MaxCount);
        for (int i = 0; i < occluderCount; i++)
            DrawOccluder(pixels, width, height, random.Integer(24, 487), random.Integer(20, 171), random.Integer(c.Occluders.MinWidthPixels, c.Occluders.MaxWidthPixels), random.Integer(c.Occluders.MinHeightPixels, c.Occluders.MaxHeightPixels), random.Integer(c.Occluders.MinGray, c.Occluders.MaxGray), cancellationToken);
        var lattice = new Point[c.Displacement.LatticeRows, c.Displacement.LatticeColumns];
        for (int y = 0; y < lattice.GetLength(0); y++)
            for (int x = 0; x < lattice.GetLength(1); x++)
                lattice[y, x] = new(random.Integer(c.Displacement.ComponentMinPixels, c.Displacement.ComponentMaxPixels), random.Integer(c.Displacement.ComponentMinPixels, c.Displacement.ComponentMaxPixels));
        byte[] warped = GC.AllocateUninitializedArray<byte>(pixels.Length);
        for (int y = 0; y < height; y++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            for (int x = 0; x < width; x++)
            {
                Point d = Bicubic(lattice, x * 8d / (width - 1), y * 4d / (height - 1));
                warped[y * width + x] = Bilinear(pixels, width, height, x - d.X, y - d.Y);
            }
        }
        for (int i = 0; i < warped.Length; i++)
        {
            if ((i & 1023) == 0)
                cancellationToken.ThrowIfCancellationRequested();
            warped[i] = ClampByte(warped[i] + random.Integer(-c.Noise.AdditiveAmplitude, c.Noise.AdditiveAmplitude));
        }
        int impulses = random.Integer(c.Noise.MinImpulseCount, c.Noise.MaxImpulseCount);
        for (int i = 0; i < impulses; i++)
            warped[random.Integer(0, warped.Length - 1)] = random.Integer(0, 1) == 0 ? (byte)0 : (byte)255;
        return warped;
    }

    public byte[] RenderAudio(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default)
    {
        string normalized = PerceptionCharacterV3Crypto.NormalizeAnswer(answer) ?? throw new ArgumentException("Invalid V3 answer.", nameof(answer));
        if (seed.Length != 32)
            throw new ArgumentException("Audio seed must be 32 bytes.", nameof(seed));
        const int GapSamples = 2_160;
        PerceptionCharacterV3SpokenAtlas atlas = PerceptionCharacterV3SpokenAtlasContract.Value;
        PerceptionCharacterV3SpokenUnit[] units = normalized.Select(symbol => atlas.Units[symbol.ToString()]).ToArray();
        int totalSamples = checked(units.Sum(static unit => unit.SampleCount) + GapSamples * (units.Length - 1));
        byte[] wav = new byte[44 + totalSamples * 2];
        WriteWavHeader(wav, atlas.SampleRate, totalSamples);
        int cursor = 44;
        foreach (PerceptionCharacterV3SpokenUnit unit in units)
        {
            cancellationToken.ThrowIfCancellationRequested();
            byte[] pcm = Convert.FromBase64String(unit.Pcm16Base64);
            pcm.CopyTo(wav, cursor);
            cursor += pcm.Length + GapSamples * 2;
        }
        return wav;
    }

    private static void DrawGlyph(byte[] pixels, int width, int height, string ch, int variant, double cx, double cy, int rotation, double shear, double sx, double sy, int gray, PerceptionCharacterV3RasterContract c, CancellationToken cancellationToken)
    {
        bool[,] atlas = GlyphAtlas(ch, variant, c);
        double radians = rotation * Math.PI / 180d, cosine = Math.Cos(radians), sine = Math.Sin(radians);
        int left = Math.Max(0, (int)Math.Floor(cx - 54)), right = Math.Min(width - 1, (int)Math.Ceiling(cx + 54));
        int top = Math.Max(0, (int)Math.Floor(cy - 62)), bottom = Math.Min(height - 1, (int)Math.Ceiling(cy + 62));
        for (int y = top; y <= bottom; y++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            for (int x = left; x <= right; x++)
            {
                double tx = x + .5 - cx, ty = y + .5 - cy, shx = cosine * tx + sine * ty, shy = -sine * tx + cosine * ty;
                double sourceY = shy / sy, sourceX = (shx - shear * shy) / sx;
                int column = (int)Math.Floor((sourceX + 35) / 10), row = (int)Math.Floor((sourceY + 45) / 10);
                if (row is >= 0 and < 9 && column is >= 0 and < 7 && atlas[row, column])
                    pixels[y * width + x] = Math.Min(pixels[y * width + x], (byte)gray);
            }
        }
    }
    private static bool[,] GlyphAtlas(string ch, int variant, PerceptionCharacterV3RasterContract c)
    {
        var atlas = new bool[9, 7];
        string[] rows = c.GlyphAtlasBaseRows[ch];
        for (int row = 0; row < rows.Length; row++)
            for (int col = 0; col < rows[row].Length; col++)
                if (rows[row][col] == '1')
                    foreach (int[] offset in c.GlyphVariantOffsets[variant])
                        atlas[row + 1 + offset[1], col + 1 + offset[0]] = true;
        return atlas;
    }
    private static void DrawCurve(byte[] p, int w, int h, int x0, int y0, int x1, int y1, int x2, int y2, int radius, int gray, CancellationToken cancellationToken)
    {
        for (int k = 0; k <= 256; k++)
        {
            if ((k & 31) == 0)
                cancellationToken.ThrowIfCancellationRequested();
            double t = k / 256d, inv = 1 - t;
            int x = JsRound(inv * inv * x0 + 2 * inv * t * x1 + t * t * x2), y = JsRound(inv * inv * y0 + 2 * inv * t * y1 + t * t * y2);
            Stamp(p, w, h, x, y, radius, gray);
        }
    }
    private static void Stamp(byte[] p, int w, int h, int cx, int cy, int r, int gray)
    {
        for (int y = cy - r; y <= cy + r; y++)
            for (int x = cx - r; x <= cx + r; x++)
                if (x >= 0 && x < w && y >= 0 && y < h && (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r)
                    p[y * w + x] = Math.Min(p[y * w + x], (byte)gray);
    }
    private static void DrawOccluder(byte[] p, int w, int h, int cx, int cy, int width, int height, int gray, CancellationToken cancellationToken)
    {
        int left = Math.Max(0, (int)Math.Floor(cx - width / 2d)), right = Math.Min(w - 1, (int)Math.Ceiling(cx + width / 2d)), top = Math.Max(0, (int)Math.Floor(cy - height / 2d)), bottom = Math.Min(h - 1, (int)Math.Ceiling(cy + height / 2d));
        for (int y = top; y <= bottom; y++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            for (int x = left; x <= right; x++)
            {
                double dx = (x - cx) / (width / 2d), dy = (y - cy) / (height / 2d);
                if (dx * dx + dy * dy <= 1)
                    p[y * w + x] = Math.Min(p[y * w + x], (byte)gray);
            }
        }
    }

    private static Point Bicubic(Point[,] lattice, double x, double y)
    {
        int col = (int)Math.Floor(x), row = (int)Math.Floor(y);
        double fx = x - col, fy = y - row;
        double Component(bool useX)
        {
            Span<double> v = stackalloc double[4];
            for (int oy = -1; oy <= 2; oy++)
            {
                int r = Math.Clamp(row + oy, 0, 4);
                double Get(int ox)
                {
                    Point p = lattice[r, Math.Clamp(col + ox, 0, 8)];
                    return useX ? p.X : p.Y;
                }
                v[oy + 1] = Catmull(Get(-1), Get(0), Get(1), Get(2), fx);
            }
            return Catmull(v[0], v[1], v[2], v[3], fy);
        }
        return new(Component(true), Component(false));
    }
    private static double Catmull(double p0, double p1, double p2, double p3, double t) => .5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    private static byte Bilinear(byte[] p, int w, int h, double x, double y)
    {
        if (x < 0 || y < 0 || x > w - 1 || y > h - 1)
            return 255;
        int left = (int)Math.Floor(x), top = (int)Math.Floor(y), right = Math.Min(w - 1, left + 1), bottom = Math.Min(h - 1, top + 1);
        double fx = x - left, fy = y - top, tv = p[top * w + left] * (1 - fx) + p[top * w + right] * fx, bv = p[bottom * w + left] * (1 - fx) + p[bottom * w + right] * fx;
        return ClampByte((int)Math.Floor(tv * (1 - fy) + bv * fy + .5));
    }
    private static int JsRound(double x) => (int)Math.Floor(x + .5);
    private static byte ClampByte(int x) => (byte)Math.Clamp(x, 0, 255);
    private static void WriteWavHeader(byte[] wav, int rate, int samples)
    {
        Encoding.ASCII.GetBytes("RIFF").CopyTo(wav, 0);
        BinaryPrimitives.WriteInt32LittleEndian(wav.AsSpan(4), wav.Length - 8);
        Encoding.ASCII.GetBytes("WAVEfmt ").CopyTo(wav, 8);
        BinaryPrimitives.WriteInt32LittleEndian(wav.AsSpan(16), 16);
        BinaryPrimitives.WriteInt16LittleEndian(wav.AsSpan(20), 1);
        BinaryPrimitives.WriteInt16LittleEndian(wav.AsSpan(22), 1);
        BinaryPrimitives.WriteInt32LittleEndian(wav.AsSpan(24), rate);
        BinaryPrimitives.WriteInt32LittleEndian(wav.AsSpan(28), rate * 2);
        BinaryPrimitives.WriteInt16LittleEndian(wav.AsSpan(32), 2);
        BinaryPrimitives.WriteInt16LittleEndian(wav.AsSpan(34), 16);
        Encoding.ASCII.GetBytes("data").CopyTo(wav, 36);
        BinaryPrimitives.WriteInt32LittleEndian(wav.AsSpan(40), samples * 2);
    }
    private readonly record struct Point(double X, double Y);

    private sealed class RasterRandom
    {
        private readonly byte[] _key; private uint _counter; private byte[] _available = [];
        public RasterRandom(ReadOnlySpan<byte> seed)
        {
            if (seed.Length != 32)
                throw new ArgumentException("Raster seed must be 32 bytes.");
            _key = seed.ToArray();
        }
        public int Integer(int min, int max)
        {
            ulong span = (ulong)((long)max - min + 1), limit = (0x1_0000_0000UL / span) * span;
            while (true)
            {
                if (_available.Length < 4)
                    Fill();
                uint candidate = BinaryPrimitives.ReadUInt32BigEndian(_available);
                _available = _available[4..];
                if (candidate < limit)
                    return min + (int)(candidate % span);
            }
        }
        private void Fill()
        {
            Span<byte> counter = stackalloc byte[4];
            BinaryPrimitives.WriteUInt32BigEndian(counter, _counter++);
            byte[] domain = Encoding.ASCII.GetBytes("fsus.perception-character.raster.v3\0");
            byte[] material = new byte[domain.Length + 4];
            domain.CopyTo(material, 0);
            counter.CopyTo(material.AsSpan(domain.Length));
            _available = HMACSHA256.HashData(_key, material);
        }
    }
}
