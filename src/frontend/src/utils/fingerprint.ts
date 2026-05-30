/**
 * FsusPow Engine - 指纹采集器
 * 核心职责：生成设备唯一的同步指纹，作为 PoW 校验盐值的一部分
 * 性能要求：纯同步计算，耗时需小于 1ms
 * 优化逻辑：[修复 2026-02-23] 引入哈希坍缩算法，消除线性截断导致的熵黑洞
 */
export const getBrowserFp = (): string => {
  const navigator = window.navigator as any
  const screen = window.screen

  // 1. 采集特征维度 (保持高熵原始数据)
  const ua = navigator.userAgent || ''
  const resolution = `${screen.width}x${screen.height}x${screen.colorDepth}`
  const timezone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'
  const language = navigator.language || navigator.userLanguage || 'unknown'
  const cores = navigator.hardwareConcurrency || 1
  const memory = navigator.deviceMemory || 0

  // 2. 组合原始指纹字符串 (保持原始语义顺序)
  const raw = `${ua}|${resolution}|${timezone}|${language}|${cores}|${memory}`

  /**
   * 3. 核心算法：哈希坍缩 (Entropy Collapse)
   * 逻辑自洽：使用四个不同的偏移初值与质数，进行并行的 FNV-1a 位运算
   * 算法最优：通过 Math.imul (32位整数乘法) 强制执行物理层面的溢出截断，模拟 128 位哈希
   */
  const collapse = (str: string): string => {
    // 四个不同的 32 位哈希种子 (种子选自逻辑质数)
    let h1 = 0x811c9dc5, h2 = 0xdeadbeef, h3 = 0xbadc0fee, h4 = 0x243f6a88;

    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      // 利用 Math.imul 实现极速的 32 位乘法坍缩
      // 每一个字符的变动都会通过异或和乘法运算，呈雪崩式扩散到四个哈希池中
      h1 = Math.imul(h1 ^ char, 16777619);
      h2 = Math.imul(h2 ^ char, 2654435761);
      h3 = Math.imul(h3 ^ char, 1597334677);
      h4 = Math.imul(h4 ^ char, 2246822519);
    }

    // 4. 格式化输出
    // 将 4 个 32 位整数转换为 16 进制并拼接，得到 32 位的紧凑指纹
    // 逻辑自洽：使用无符号右移 (>>> 0) 确保结果为正整数
    const toHex = (num: number) => (num >>> 0).toString(16).padStart(8, '0');

    return `${toHex(h1)}${toHex(h2)}${toHex(h3)}${toHex(h4)}`.slice(0, 32);
  }

  // 执行坍缩
  try {
    return collapse(raw);
  } catch (e) {
    // 安全性保障：极端环境下的回退方案
    console.warn('[Fingerprint] Hash collapse failed, using fallback');
    // 即使回退，也通过简单的位运算确保 UA 后部信息参与计算
    let fallbackHash = 0;
    for (let i = 0; i < ua.length; i++) {
        fallbackHash = (fallbackHash << 5) - fallbackHash + ua.charCodeAt(i);
        fallbackHash |= 0;
    }
    return (Math.abs(fallbackHash).toString(16) + '000000000000000000000000').slice(0, 32);
  }
}