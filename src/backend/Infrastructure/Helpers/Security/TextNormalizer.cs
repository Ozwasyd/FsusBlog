using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;

namespace FsusBlog.Server.Infrastructure.Helpers.Security;

/// <summary>
/// Normalizes text into the canonical fingerprint consumed by the content-filter automaton.
/// </summary>
public static class TextNormalizer
{
    // The fixed 65,536-entry table trades 128 KiB for one direct lookup per UTF-16 code unit.
    private static char[] s_charMap;
    private static readonly Lock s_initLock = new();
    private static PhraseNode s_phraseRoot = new();
    private static int s_openCcLoaded;

    static TextNormalizer()
    {
        var charMap = new char[char.MaxValue + 1];

        // Unconfigured characters preserve their original code unit.
        for (int i = 0; i < charMap.Length; i++)
        {
            charMap[i] = (char)i;
        }

        // 仅保留基础 ASCII 归一化。OpenCC 词典在显式初始化阶段加载，避免静态构造吞异常。
        ApplyAsciiNormalization(charMap);
        s_charMap = charMap;
    }

    public static Result Initialize(ILogger logger)
    {
        if (Volatile.Read(ref s_openCcLoaded) == 1)
        {
            return Result.Success();
        }

        lock (s_initLock)
        {
            if (s_openCcLoaded == 1)
            {
                return Result.Success();
            }

            var result = LoadOpenCcSuperDictionary(logger);
            if (result.IsSuccess)
            {
                Volatile.Write(ref s_openCcLoaded, 1);
            }

            return result;
        }
    }

    private static Result LoadOpenCcSuperDictionary(ILogger logger)
    {
        string baseDirectory = AppContext.BaseDirectory;
        string dictDirectory = Path.Combine(baseDirectory, "Dictionaries");
        var phraseRoot = new PhraseNode();
        char[] charMap = (char[])Volatile.Read(ref s_charMap).Clone();

        var variantsResult = LoadOpenCcFile(Path.Combine(dictDirectory, "TWVariants.txt"), phraseRoot, charMap, logger);
        if (variantsResult.IsFailure)
        {
            return variantsResult;
        }

        var phrasesResult = LoadOpenCcFile(Path.Combine(dictDirectory, "TWPhrases.txt"), phraseRoot, charMap, logger);
        if (phrasesResult.IsFailure)
        {
            return phrasesResult;
        }

        var charactersResult = LoadOpenCcFile(Path.Combine(dictDirectory, "TSCharacters.txt"), phraseRoot, charMap, logger);
        if (charactersResult.IsSuccess)
        {
            ApplyAsciiNormalization(charMap);
            Volatile.Write(ref s_charMap, charMap);
            Volatile.Write(ref s_phraseRoot, phraseRoot);
        }

        return charactersResult;
    }

    private static Result LoadOpenCcFile(string path, PhraseNode phraseRoot, char[] charMap, ILogger logger)
    {
        if (!File.Exists(path))
        {
            logger.LogWarning("OpenCC dictionary file not found, skipping: {Path}", path);
            return Result.Success();
        }

        return BoundaryExecutor.Execute(
            () =>
            {
                foreach (var line in File.ReadLines(path))
                {
                    if (string.IsNullOrWhiteSpace(line) || line.StartsWith("#"))
                    {
                        continue;
                    }

                    var parts = line.Split('\t');
                    if (parts.Length != 2)
                    {
                        continue;
                    }

                    string key = parts[0];
                    string value = parts[1];

                    if (key.Length == value.Length)
                    {
                        for (int i = 0; i < key.Length; i++)
                        {
                            // 使用 char 值作为索引，直接覆盖
                            // TryAdd 的逻辑在这里通过加载顺序来保证
                            charMap[key[i]] = value[i];
                        }
                    }
                    else
                    {
                        AddPhraseMapping(phraseRoot, key, value);
                    }
                }
            },
            ex => ErrorDetail.Create(
                ErrorCode.InfraFailure,
                $"加载 OpenCC 词典失败: {Path.GetFileName(path)}",
                path,
                ex.Message),
            logger,
            $"TextNormalizer.LoadOpenCcFile[{Path.GetFileName(path)}]",
            LogLevel.Warning);
    }

    private static void ApplyAsciiNormalization(char[] charMap)
    {
        for (int i = 0; i < charMap.Length; i++)
        {
            charMap[i] = NormalizeAsciiRune(charMap[i]);
        }
    }

    private static char NormalizeAsciiRune(char value)
    {
        if (value == '\u3000')
        {
            return ' ';
        }

        if (value is >= '\uFF01' and <= '\uFF5E')
        {
            value = (char)(value - 0xFEE0);
        }

        return value is >= 'A' and <= 'Z'
            ? (char)(value + ('a' - 'A'))
            : value;
    }

    /// <summary>
    /// 在给定的 Span<char> 缓冲区上，原地执行归一化。
    /// 所有转换逻辑已被预计算到 _charMap 中，这里只做一次查表。
    /// </summary>
    public static void NormalizeInPlace(Span<char> buffer)
    {
        char[] charMap = Volatile.Read(ref s_charMap);
        // Every UTF-16 code unit maps through the precomputed fixed table.
        for (int i = 0; i < buffer.Length; i++)
        {
            buffer[i] = charMap[buffer[i]];
        }
    }

    public static string Normalize(string value, bool usePhraseMappings = false)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        if (!usePhraseMappings)
        {
            char[] charMap = Volatile.Read(ref s_charMap);
            return string.Create(value.Length, (Value: value, CharMap: charMap), static (buffer, state) =>
            {
                for (int i = 0; i < state.Value.Length; i++)
                {
                    buffer[i] = state.CharMap[state.Value[i]];
                }
            });
        }

        return NormalizeWithPhraseRoot(value, Volatile.Read(ref s_phraseRoot));
    }

    internal static string NormalizeWithPhraseMappingsForTests(string value, IReadOnlyDictionary<string, string> phrases)
    {
        var root = new PhraseNode();
        foreach ((string key, string replacement) in phrases)
        {
            AddPhraseMapping(root, key, replacement);
        }

        return NormalizeWithPhraseRoot(value, root);
    }

    private static string NormalizeWithPhraseRoot(string value, PhraseNode phraseRoot)
    {
        var builder = new StringBuilder(value.Length);
        char[] charMap = Volatile.Read(ref s_charMap);
        int index = 0;
        while (index < value.Length)
        {
            PhraseNode current = phraseRoot;
            string? replacement = null;
            int replacementEnd = -1;

            for (int cursor = index; cursor < value.Length; cursor++)
            {
                if (!current.Children.TryGetValue(value[cursor], out PhraseNode? next))
                {
                    break;
                }

                current = next;
                if (current.Replacement is not null)
                {
                    replacement = current.Replacement;
                    replacementEnd = cursor + 1;
                }
            }

            if (replacement is not null)
            {
                builder.Append(replacement);
                index = replacementEnd;
                continue;
            }

            builder.Append(charMap[value[index]]);
            index++;
        }

        return builder.ToString();
    }

    private static void AddPhraseMapping(PhraseNode root, string key, string replacement)
    {
        if (string.IsNullOrEmpty(key) || string.IsNullOrEmpty(replacement))
        {
            return;
        }

        PhraseNode current = root;
        foreach (char ch in key)
        {
            if (!current.Children.TryGetValue(ch, out PhraseNode? next))
            {
                next = new PhraseNode();
                current.Children[ch] = next;
            }

            current = next;
        }

        current.Replacement = replacement;
    }

    private sealed class PhraseNode
    {
        public Dictionary<char, PhraseNode> Children { get; } = [];
        public string? Replacement
        {
            get; set;
        }
    }
}
