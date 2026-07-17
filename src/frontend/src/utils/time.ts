import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import 'dayjs/locale/zh-cn';

// 插件初始化与全局配置
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

export type TimeRenderOptions = Readonly<{
    now?: string | Date | number | null;
    timeZone?: string | null;
    locale?: string | null;
}>;

function resolveDisplayTimeZone(options?: TimeRenderOptions): string | null {
    const value = options?.timeZone?.trim();
    return value && value.length > 0 ? value : null;
}

function applyDisplayTimeZone(value: dayjs.Dayjs, options?: TimeRenderOptions): dayjs.Dayjs {
    const timeZone = resolveDisplayTimeZone(options);
    const localized = timeZone ? value.tz(timeZone) : value.local();
    const locale = options?.locale?.trim().toLowerCase();
    if (!locale) return localized;
    if (locale === 'zh-cn' || locale === 'zh-hans' || locale.startsWith('zh-cn-')) return localized.locale('zh-cn');
    if (locale === 'en' || locale.startsWith('en-')) return localized.locale('en');
    return localized.locale(locale);
}

/**
 * 时间处理工具类
 * 修复日期: 2026-02-23
 *
 * 核心变更说明：
 * 1. 中心化解析：所有输入经过 _parse 统一收敛，处理秒/毫秒歧义与时区偏移。
 * 2. 精度纠偏：智能格式化采用分钟级 diff，消除小时级截断带来的跳变。
 * 3. 性能优化：通过单次解析与逻辑短路，优化长列表渲染性能。
 * 4. 边界防御：定义未来时间与非法输入的 UI 回退策略。
 */
export const TimeUtils = {

    /**
     * 内部解析引擎 (中心化入口)
     * 解决：UTC 假设不安全、解析逻辑重复、类型约束收敛
     */
    _parse(input: string | Date | number | null | undefined): dayjs.Dayjs | null {
        if (!input) return null;

        let instance: dayjs.Dayjs;

        if (typeof input === 'number') {
            // 逻辑自洽：后端契约统一为秒 (UnixTimeSeconds)，前端需自动纠正为毫秒进行解析
            // 物理真相：10位数为秒，13位数为毫秒。此处强制适配后端 10 位秒级戳。
            instance = input < 10000000000 ? dayjs.unix(input) : dayjs(input);
        } else if (typeof input === 'string') {
            //[修改日期 2026-03-01]
            // 修改理由：物理真相击穿。ASP.NET Core 返回的 ISO 字符串带有 'T' 但默认缺失 'Z' (UTC标识)。
            // 废弃 `includes('T')` 判断，防止带有 'T' 的纯字符串被 V8 错误地解析为本地时间。
            // 极简修复：强制将所有字符串作为 UTC 解析，即使源字符串自带时区偏移，底层的 dayjs.utc 也能完美兼容。
            instance = dayjs.utc(input);
        } else {
            instance = dayjs(input);
        }

        return instance.isValid() ? instance : null;
    },

    /**
     * 将 UTC 时间转换为相对时间（如：3分钟前）
     */
    toRelative(utcTime: string | Date | number, options?: TimeRenderOptions): string {
        const d = this._parse(utcTime);
        if (!d) return '时间未知'; // 可观测性：区分解析失败
        const now = options?.now == null ? null : this._parse(options.now);
        const displayTime = applyDisplayTimeZone(d, options);
        return now ? displayTime.from(applyDisplayTimeZone(now, options)) : displayTime.fromNow();
    },

    /**
     * 将 UTC 时间转换为本地标准格式
     */
    toFullLocalString(utcTime: string | Date | number, options?: TimeRenderOptions): string {
        const d = this._parse(utcTime);
        if (!d) return '时间格式错误';
        return applyDisplayTimeZone(d, options).format('YYYY-MM-DD HH:mm:ss');
    },

    /**
     * 智能格式化：全生命周期感知
     * 解决：diff 精度问题、未来时间处理、长列表性能
     */
    toSmartTime(utcTime: string | Date | number, options?: TimeRenderOptions): string {
        const target = this._parse(utcTime);
        if (!target) return '-';

        const localTarget = applyDisplayTimeZone(target, options);
        const parsedNow = options?.now == null ? null : this._parse(options.now);
        const now = applyDisplayTimeZone(parsedNow ?? dayjs(), options);

        // 算法最优：使用分钟级 diff 提升感官精度
        const diffInMinutes = now.diff(localTarget, 'minute');

        // 1. 未来时间防御 (例如客户端时钟快于服务器)
        if (diffInMinutes < -1) {
            return localTarget.format('YYYY-MM-DD HH:mm');
        }

        // 2. 极短时间内 (1分钟内)
        if (diffInMinutes <= 0) {
            return '刚刚';
        }

        // 3. 24小时内 (使用相对时间)
        if (diffInMinutes < 1440) {
            return localTarget.from(now);
        }

        // 4. 跨年处理
        const formatStr = now.year() === localTarget.year() ? 'MM-DD HH:mm' : 'YYYY-MM-DD HH:mm';
        return localTarget.format(formatStr);
    }
};
