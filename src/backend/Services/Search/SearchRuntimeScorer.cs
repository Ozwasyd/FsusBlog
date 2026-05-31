namespace FsusBlog.Server.Services;

internal static class SearchRuntimeScorer
{
    private const double K1 = 1.2d;
    private const double B = 0.75d;

    public static double ComputeBm25(
        double weightedTermFrequency,
        int documentCount,
        int documentFrequency,
        int documentLength,
        double averageDocumentLength)
    {
        if (weightedTermFrequency <= 0d || documentCount <= 0 || documentFrequency <= 0)
        {
            return 0d;
        }

        double safeAverageLength = Math.Max(averageDocumentLength, 1d);
        double safeDocumentLength = Math.Max(documentLength, 1);
        double idf = Math.Log(1d + ((documentCount - documentFrequency + 0.5d) / (documentFrequency + 0.5d)));
        double normalization = K1 * (1d - B + (B * safeDocumentLength / safeAverageLength));
        return idf * ((weightedTermFrequency * (K1 + 1d)) / (weightedTermFrequency + normalization));
    }
}
