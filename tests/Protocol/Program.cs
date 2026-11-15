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
Equal(Fixture("page-content-v1.hex"), SitePageWire.Encode("about", "# About\n\nHydration-safe binary payload."));
SiteConfigVectors.Run(fixtures);
SubscriptionPreferenceVectors.Run(fixtures);

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
PublishedArticleMediaVectors.Run();
Equal(
    Convert.FromHexString(string.Concat(File.ReadAllLines(Path.Combine(fixtures, "pow-challenge-v1.hex")))),
    PowWire.EncodeChallenge(new("salt-value", 4, 1778290000L, "signature-value")));
CommentReadVectors.Run(fixtures);
byte[] CategoryFixture() => Convert.FromHexString(string.Concat(File.ReadAllLines(Path.Combine(fixtures, "category-list-v1.hex"))));
Equal(CategoryFixture(), TaxonomyWire.EncodeList(FrameType.CategoryList, [new(1, "Tech", 2), new(2, "Life", 0)]));
Equal(Fixture("taxonomy-exact-metadata.hex"), TaxonomyWire.EncodeMetadata(new(34, "Étoile", "旧名不可占用")));
var assignment = new TaxonomyAssignment(42, 9_007_199_254_740_993, Guid.Parse("01020304-0506-4040-8080-000000000003"), 3, [101, 105]);
var taxonomyVector = Fixture("taxonomy-assignment.hex");
Equal(taxonomyVector, Wire.EncodeTaxonomyAssignment(assignment));
Equal(taxonomyVector, Wire.EncodeTaxonomyAssignment(Wire.DecodeTaxonomyAssignment(taxonomyVector)));
Reject(() => Wire.EncodeTaxonomyAssignment(assignment with { TagIds = [101, 101] }));
InboxVectors.Run(fixtures);
var canvasVector = Fixture("canvas-link-plan.hex");
var canvasPlan = new CanvasLinkPlan(Guid.Parse("76aff0f0-ba5e-4bd3-ab12-a42d29b9131a"), 3, 8, 12,
    21, 9, 30, "\r\n\r\n[规划 🐝](/article/21)", 1794680000);
Equal(canvasVector, Wire.EncodeCanvasLinkPlan(canvasPlan));
if (Wire.DecodeCanvasLinkPlan(canvasVector) != canvasPlan)
    throw new InvalidOperationException("Canvas plan differs from the independent vector");
Reject(() => Wire.DecodeCanvasConfirm(canvasVector));
var inboxTime = DateTimeOffset.FromUnixTimeMilliseconds(1794659381000);
var inboxEvents = new InboxReplayRecord[]
{
    new(701, 12, 1234567890123456, 9102, inboxTime),
    new(702, 13, 1234567890123456, 9102, inboxTime.AddSeconds(1))
};
Equal(Fixture("inbox-replay.hex"), InboxReplayWire.Encode(702, true, false, inboxEvents));
Reject(() => InboxReplayWire.Encode(703, true, false, inboxEvents));
Reject(() => InboxReplayWire.Encode(702, true, true, inboxEvents));
LocalSearchVectors.Run(fixtures);
PropertyValueVectors.Run(fixtures);
RelatedReadingVectors.Run(fixtures);
ArticleCanonicalHashVectors.Run(fixtures);
NativeArticleCanonicalVectors.Run(fixtures);
NativePublicationProofVectors.Run(fixtures);
var cluster = new AdminClusterStatus(1, "lab-a", Guid.Parse("bd978cbd-7565-44ed-876d-d734cbe45c79"), "2.0.0+ca32",
    1794680000000, 1794680040012, 349, true);
Equal(Fixture("admin-cluster-status-v2.hex"), Wire.EncodeAdminClusterStatus(cluster));
if (Wire.DecodeAdminClusterStatus(Fixture("admin-cluster-status-v2.hex")) != cluster)
    throw new InvalidOperationException("Standalone deployment differs from the independent vector");
Reject(() => Wire.EncodeAdminClusterStatus(cluster with { LeaseAgeMs = 1000 }));
Reject(() => Wire.EncodeAdminClusterStatus(cluster with { NodeId = "lab-a\n" }));
Reject(() => Wire.EncodeAdminClusterStatus(cluster with { Mode = 2 }));
Console.WriteLine("AEDS C# vectors and malformed data checks passed");
