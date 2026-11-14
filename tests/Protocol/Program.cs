using FsusBlog.V2.Contracts;

string fixtures = args.Length == 1 ? args[0] : throw new ArgumentException("Supply the fixture directory");
byte[] Fixture(string name) => Convert.FromHexString(File.ReadAllText(Path.Combine(fixtures, name)).Trim());

void Equal(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual)
{
    if (!expected.SequenceEqual(actual))
        throw new InvalidOperationException("AEDS bytes differ from independent vector");
}

void Reject(Action run)
{
    try
    {
        run();
    }
    catch (ProtocolException)
    {
        return;
    }
    throw new InvalidOperationException("Invalid AEDS data accepted");
}

var error = Fixture("api-error-v1.hex");
Equal(error, Wire.EncodeError(403, "权限不足", "role_required", "trace-123"));
Equal(new byte[] { 1, 0, 0, 0 }, Aeds.Decode(Wire.EncodeEmptySuccess(), FrameType.EmptySuccess));

var command = new ArticleCommand(0, 0, Guid.Parse("00446688-2244-6688-99aa-bbccddeeff00"), "独立向量", "first draft 🐈\n");
var expected = Fixture("article-command.hex");
Equal(expected, Wire.EncodeArticleCommand(command));
if (Wire.DecodeArticleCommand(expected) != command)
    throw new InvalidOperationException("AEDS command differs from independent vector");

foreach (int length in Enumerable.Range(0, expected.Length))
    Reject(() => Wire.DecodeArticleCommand(expected.AsSpan(0, length)));

var changed = expected.ToArray();
for (int offset = 0; offset < changed.Length; offset++)
{
    for (int bit = 0; bit < 8; bit++)
    {
        changed[offset] ^= (byte)(1 << bit);
        Reject(() => Wire.DecodeArticleCommand(changed));
        changed[offset] ^= (byte)(1 << bit);
    }
}

var payload = Aeds.Decode(expected, FrameType.ArticleCommand).ToArray();
payload[32] = 255;
Reject(() => Wire.DecodeArticleCommand(Aeds.Encode(FrameType.ArticleCommand, payload)));
Reject(() => Wire.DecodeArticleCommand(Aeds.Encode(FrameType.ArticleCommand, new byte[36 + WireLimits.BodyBytes + WireLimits.TitleBytes + 1])));
Reject(() => Wire.DecodeArticleCommand(Aeds.Encode(FrameType.ArticleCommand, [.. Aeds.Decode(expected, FrameType.ArticleCommand), 0])));

PublicArticleVectors.Run(fixtures);
InboxVectors.Run(fixtures);
Console.WriteLine("AEDS C# vectors and malformed data checks passed");
