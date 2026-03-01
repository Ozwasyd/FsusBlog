namespace FsusBlog.Server.Infrastructure.Helpers.Security;

/// <summary>
/// 文本归一化预处理器 (最终物理优化版)
/// 修复日期: 2026-02-22 (废弃 Dictionary，改用 char[65536] 直接内存寻址，实现 O(1) 物理极限查找)
/// 职责：以极致性能将文本转换为“标准指纹”，为 AC 自动机提供最干净的输入。
/// </summary>
public static class TextNormalizer
{
    // 终极优化：创建一个覆盖所有 char 范围的数组作为直接查找表 (Look-Up Table)。
    // 这将消耗 128KB 内存 (65536 * 2 bytes)，但会将繁简转换的性能提升到物理极限。
    private static readonly char[] _charMap;

    // 静态构造函数，在服务启动时只执行一次，负责构建这个巨大的查找表
    static TextNormalizer()
    {
        _charMap = new char[char.MaxValue + 1];

        // 第一步：初始化映射表，让每个字符默认映射到自身
        for (int i = 0; i < _charMap.Length; i++)
        {
            _charMap[i] = (char)i;
        }

        // 第二步：加载 OpenCC 超级字典，覆盖默认映射
        LoadOpenCcSuperDictionary();

        // 第三步：加载全角/半角和大小写转换，覆盖默认映射
        ApplyAsciiNormalization();
    }

    private static void LoadOpenCcSuperDictionary()
    {
        try
        {
            string baseDirectory = AppContext.BaseDirectory;
            string dictDirectory = Path.Combine(baseDirectory, "Dictionaries");

            // 严格按照 OpenCC 的转换链顺序加载，确保映射的优先级正确
            LoadOpenCcFile(Path.Combine(dictDirectory, "TWVariants.txt"));
            LoadOpenCcFile(Path.Combine(dictDirectory, "TWPhrases.txt"));
            LoadOpenCcFile(Path.Combine(dictDirectory, "TSCharacters.txt"));
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FATAL] Failed to load OpenCC super dictionary: {ex.Message}");
        }
    }

    private static void LoadOpenCcFile(string path)
    {
        if (!File.Exists(path))
        {
            Console.WriteLine($"[WARN] OpenCC dictionary file not found, skipping: {path}");
            return;
        }

        var lines = File.ReadAllLines(path);
        foreach (var line in lines)
        {
            if (string.IsNullOrWhiteSpace(line) || line.StartsWith("#")) continue;

            var parts = line.Split('\t');
            if (parts.Length != 2) continue;

            string key = parts[0];
            string value = parts[1];

            if (key.Length == value.Length)
            {
                for (int i = 0; i < key.Length; i++)
                {
                    // 使用 char 值作为索引，直接覆盖
                    // TryAdd 的逻辑在这里通过加载顺序来保证
                    _charMap[key[i]] = value[i];
                }
            }
        }
    }

    private static void ApplyAsciiNormalization()
    {
        // 全角转半角 (ASCII 区段)
        for (char c = (char)0xFF01; c <= 0xFF5E; c++)
        {
            _charMap[c] = (char)(c - 0xFEE0);
        }
        _charMap[0x3000] = ' '; // 全角空格

        // 大写转小写 (ASCII)
        for (char c = 'A'; c <= 'Z'; c++)
        {
            _charMap[c] = (char)(c + 32);
        }
    }

    /// <summary>
    /// 在给定的 Span<char> 缓冲区上，原地执行归一化。
    /// 所有转换逻辑已被预计算到 _charMap 中，这里只做一次查表。
    /// </summary>
    public static void NormalizeInPlace(Span<char> buffer)
    {
        // 由于所有转换逻辑已预烘焙到 _charMap 中，
        // 归一化过程简化为一次极致的、无分支的循环查表。
        for (int i = 0; i < buffer.Length; i++)
        {
            // 使用 ref 直接修改内存，并用 char 值作为索引进行 O(1) 物理寻址
            buffer[i] = _charMap[buffer[i]];
        }
    }
}