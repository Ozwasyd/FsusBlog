using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;

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
    private static readonly Lock _initLock = new();
    private static int _openCcLoaded;

    // 静态构造函数，在服务启动时只执行一次，负责构建这个巨大的查找表
    static TextNormalizer()
    {
        _charMap = new char[char.MaxValue + 1];

        // 第一步：初始化映射表，让每个字符默认映射到自身
        for (int i = 0; i < _charMap.Length; i++)
        {
            _charMap[i] = (char)i;
        }

        // 仅保留基础 ASCII 归一化。OpenCC 词典在显式初始化阶段加载，避免静态构造吞异常。
        ApplyAsciiNormalization();
    }

    public static Result Initialize(ILogger logger)
    {
        if (Volatile.Read(ref _openCcLoaded) == 1)
        {
            return Result.Success();
        }

        lock (_initLock)
        {
            if (_openCcLoaded == 1)
            {
                return Result.Success();
            }

            var result = LoadOpenCcSuperDictionary(logger);
            if (result.IsSuccess)
            {
                Volatile.Write(ref _openCcLoaded, 1);
            }

            return result;
        }
    }

    private static Result LoadOpenCcSuperDictionary(ILogger logger)
    {
        string baseDirectory = AppContext.BaseDirectory;
        string dictDirectory = Path.Combine(baseDirectory, "Dictionaries");

        var variantsResult = LoadOpenCcFile(Path.Combine(dictDirectory, "TWVariants.txt"), logger);
        if (variantsResult.IsFailure)
        {
            return variantsResult;
        }

        var phrasesResult = LoadOpenCcFile(Path.Combine(dictDirectory, "TWPhrases.txt"), logger);
        if (phrasesResult.IsFailure)
        {
            return phrasesResult;
        }

        var charactersResult = LoadOpenCcFile(Path.Combine(dictDirectory, "TSCharacters.txt"), logger);
        return charactersResult;
    }

    private static Result LoadOpenCcFile(string path, ILogger logger)
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
                            _charMap[key[i]] = value[i];
                        }
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
