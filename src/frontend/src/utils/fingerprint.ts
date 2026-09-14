/**
 * FsusPow Engine - 指纹采集器
 * 核心职责：生成稳定的同步设备指纹，作为 PoW 校验盐值的一部分
 * 哈希策略：四路 32 位累积器分别吸收全部输入字符。
 */
const HASH_PRIME_3 = Number.parseInt('5f356495', 16);

export const getBrowserFp = (): string =>
{
    const navigator = window.navigator as any;
    const screen = window.screen;

    // 1. 采集特征维度 (保持高熵原始数据)
    const ua = navigator.userAgent || '';
    const resolution = `${screen.width}x${screen.height}x${screen.colorDepth}`;
    const timezone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
    const language = navigator.language || navigator.userLanguage || 'unknown';
    const cores = navigator.hardwareConcurrency || 1;
    const memory = navigator.deviceMemory || 0;

    // 2. 组合原始指纹字符串 (保持原始语义顺序)
    const raw = `${ua}|${resolution}|${timezone}|${language}|${cores}|${memory}`;

    /**
   * 3. 哈希坍缩
   * 四个独立种子分别执行 FNV-1a 风格的异或和 32 位乘法。
   */
    const collapse = (str: string): string =>
    {
    // 四个独立的 32 位哈希种子。
        let h1 = 0x811c9dc5;
        let h2 = 0xdeadbeef;
        let h3 = 0xbadc0fee;
        let h4 = 0x243f6a88;

        for (let i = 0; i < str.length; i++)
        {
            const char = str.charCodeAt(i);
            // Math.imul 提供确定的 32 位整数乘法和溢出截断。
            // 每个字符分别更新四个哈希累积值。
            h1 = Math.imul(h1 ^ char, 16777619);
            h2 = Math.imul(h2 ^ char, 2654435761);
            h3 = Math.imul(h3 ^ char, HASH_PRIME_3);
            h4 = Math.imul(h4 ^ char, 2246822519);
        }

        // 4. 格式化输出
        // 将 4 个 32 位整数转换为 16 进制并拼接，得到 32 位的紧凑指纹
        // 无符号右移 (>>> 0) 将结果规范为 32 位无符号整数。
        const toHex = (num: number) => (num >>> 0).toString(16).padStart(8, '0');

        return `${toHex(h1)}${toHex(h2)}${toHex(h3)}${toHex(h4)}`.slice(0, 32);
    };

    // 执行坍缩
    try
    {
        return collapse(raw);
    }
    catch (e)
    {
    // 安全性保障：极端环境下的回退方案
        console.warn('[Fingerprint] Hash collapse failed, using fallback');
        // 即使回退，也通过简单的位运算确保 UA 后部信息参与计算
        let fallbackHash = 0;
        for (let i = 0; i < ua.length; i++)
        {
            fallbackHash = (fallbackHash << 5) - fallbackHash + ua.charCodeAt(i);
            fallbackHash |= 0;
        }
        return (Math.abs(fallbackHash).toString(16) + '000000000000000000000000').slice(0, 32);
    }
};
