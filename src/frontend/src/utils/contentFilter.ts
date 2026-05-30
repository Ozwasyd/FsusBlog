// 文件路径: src/utils/contentFilter.ts
// 创建日期: 2026-02-22 (追加零宽字符抽干防御与核心繁简字兼容)
// 修复日期: 2026-02-24 (补充 validateUsername，实现系统级保留字与零宽字符硬拦截)
// 职责: 在前端进行极速拦截，防止违规内容消耗本地 WASM 算力及服务器带宽

// 1. 结构化引流特征正则
const adRegex = /(加[vV微薇威嶶信]{1,2}|[vV][xX]|微信\s*[:：=]|威信\s*[:：=]|薇信\s*[:：=]|[\+＋]\s*[vV]|[qQ]{2}\s*[:：=]|扣扣|企鹅|[qQ]群|加群|代开|代写|代刷|刷单|兼职|日入\s*\d+|网赚|博彩|棋牌|菠菜|澳门金沙|新葡京|威尼斯人|裸聊|同城约|上门服务|富婆包养|t\.cn\/|dwz\.cn\/|suo\.im\/|url\.cn\/)/i;

// 2. 合法高频词汇“白名单豁免”正则
const whiteListRegex = /(学习|复习|练习|预习|实习|演习|习惯|习俗|习题|恶习|陋习|最近|接近|附近|靠近|亲近|近期|近日|远近|近似|和平|平安|公平|水平|平常|平静|平稳|平等|平台|生平|平局)/g;

// 3. 对抗性插桩红线正则 (核心修复：增加 [习習], [泽澤], [东東] 应对低级繁体绕过)
const topRedLineRegex = /([习習].{0,6}近.{0,6}平|毛.{0,6}[泽澤].{0,6}[东東]|六.{0,6}四.{0,6}事.{0,6}件)/i;

// 4. 零宽隐形字符正则 (匹配各种不可见的排版控制符)
const zeroWidthRegex = /[\u200B-\u200F\uFEFF\u202A-\u202E]/g;

// [新增 2026-02-24] 5. 系统级保留字正则 (防社会工程学/管理员仿冒)
const reservedWordsRegex = /^(admin|administrator|system|root|moderator|fsusblog|fsu)$/i;

// [新增 2026-02-24] 6. 用户名安全字符集正则 (带环境降级探针)
let usernameRegex: RegExp;
try {
    usernameRegex = new RegExp('^[\\p{Script=Han}\\p{L}\\p{N}_-]+$', 'u');
} catch {
    usernameRegex = /^[\u4e00-\u9fa5A-Za-z0-9_-]+$/;
}

export interface ValidationResult {
    isValid: boolean;
    message: string;
}

/**
 * 极速校验评论内容是否合规
 * 性能: O(1) 纯内存正则比对，耗时 < 1ms
 */
export function validateCommentContent(text: string): ValidationResult {
    if (!text || text.trim() === '') {
        return { isValid: false, message: '评论内容不能为空' };
    }

    // 核心防御：抽干所有试图干扰正则长度的“零宽隐形字符”
    const cleanText = text.replace(zeroWidthRegex, '');

    // 第一级：广告引流极速拦截
    if (adRegex.test(cleanText)) {
        return { isValid: false, message: '输入内容包含涉嫌引流的违规业务或恶意链接，已被拦截。' };
    }

    // 第二级：防误杀白名单清洗与红线拦截
    // 将合法词汇替换为安全符号，防止正常造句被红线正则误杀
    const safeText = cleanText.replace(whiteListRegex, '○');
    if (topRedLineRegex.test(safeText)) {
        return { isValid: false, message: '严重违规：检测到对抗性涉政词汇。' };
    }

    return { isValid: true, message: '' };
}

/**
 * [新增 2026-02-24]
 * 极速校验用户名是否合规
 * 逻辑自洽：用户名不仅需要防涉政与广告，还需严格防仿冒与隐形排版字符
 */
export function validateUsername(username: string): ValidationResult {
    if (!username || username.trim() === '') {
        return { isValid: false, message: '用户名不能为空' };
    }

    // 1. 物理级硬拦截：用户名决不允许包含零宽字符 (防止视觉欺骗/重名仿冒)
    if (zeroWidthRegex.test(username)) {
        return { isValid: false, message: '用户名包含非法的隐形排版字符' };
    }

    const cleanName = username.trim();

    // 2. 基础字符集与长度校验
    if (cleanName.length < 3 || cleanName.length > 20) {
        return { isValid: false, message: '用户名长度必须在 3 到 20 个字符之间' };
    }

    if (!usernameRegex.test(cleanName)) {
        return { isValid: false, message: '用户名仅允许中英文字符、数字及连字符' };
    }

    // 3. 系统保留字隔离
    if (reservedWordsRegex.test(cleanName)) {
        return { isValid: false, message: '该用户名已被系统保留，请更换' };
    }

    // 4. 继承基础的违规内容校验 (广告与红线)
    if (adRegex.test(cleanName)) {
        return { isValid: false, message: '用户名包含违规引流特征' };
    }

    const safeName = cleanName.replace(whiteListRegex, '○');
    if (topRedLineRegex.test(safeName)) {
        return { isValid: false, message: '严重违规：用户名包含对抗性涉政词汇' };
    }

    return { isValid: true, message: '' };
}