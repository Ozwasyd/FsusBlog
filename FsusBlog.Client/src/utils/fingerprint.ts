/**
 * FsusPow Engine - 指纹采集器
 * 核心职责：生成设备唯一的同步指纹，作为 PoW 校验盐值的一部分
 * 性能要求：纯同步计算，耗时需小于 1ms
 */
export const getBrowserFp = (): string => {
  const navigator = window.navigator as any
  const screen = window.screen

  // 1. 采集特征维度 (硬件+环境)
  const ua = navigator.userAgent || ''
  const resolution = `${screen.width}x${screen.height}x${screen.colorDepth}`
  
  // 2. 环境特征 (时区、语言、硬件规格)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const language = navigator.language || navigator.userLanguage || 'unknown'
  
  // 逻辑自洽：对于不支持的属性，提供稳定的默认值
  const cores = navigator.hardwareConcurrency || 1 
  const memory = navigator.deviceMemory || 0      

  // 3. 组合原始指纹字符串
  // 格式：UA|分辨率|时区|语言|核心数|内存
  const raw = `${ua}|${resolution}|${timezone}|${language}|${cores}|${memory}`
  
  // 4. 编码处理
  // 性能最大化：使用原生 btoa。为防止非 ASCII 字符导致崩溃，配合 encodeURIComponent
  try {
    // 逻辑自洽：Base64 编码后移除非字母数字字符，确保在 QueryString 中传输安全
    // 截取前 32 位以保持长度固定，方便后端数据库存储与哈希拼接
    const base64 = btoa(encodeURIComponent(raw))
    return base64.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)
  } catch (e) {
    // 安全性保障：极端情况下的回退方案（如某些旧版浏览器环境）
    // 仅保留字母数字，确保后续字符串拼接逻辑不破裂
    console.warn('[Fingerprint] Encoding fallback used');
    return ua.replace(/[^a-zA-Z0-9]/g, '').slice(-32)
  }
}