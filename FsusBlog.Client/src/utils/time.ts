import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import 'dayjs/locale/zh-cn'; // 引入中文语言包

// 插件初始化
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
dayjs.locale('zh-cn'); // 设置全局语言为中文

/**
 * 时间处理工具类
 */
export const TimeUtils = {
    /**
     * 将 UTC 时间转换为相对时间（如：3分钟前）
     * @param utcTime 后端返回的 UTC 字符串
     */
    toRelative(utcTime: string | Date): string {
        if (!utcTime) return '';
        
        // 🌟 安全性保障：先转为 UTC 模式，再转为本地时间，最后计算相对差
        // .utc(utcTime) 会正确解析 ISO 格式（带Z）
        return dayjs.utc(utcTime).local().fromNow();
    },
    
    /**
     * 获取完整的本地化 ISO 字符串，用于 HTML title 属性
     */
    toFullLocalString(utcTime: string | Date): string {
        if (!utcTime) return '';
        return dayjs.utc(utcTime).local().format('YYYY-MM-DD HH:mm:ss');
    },

    /**
     * 智能格式化：1小时内显示相对时间，超过1小时显示绝对时间
     */
    toSmartTime(utcTime: string | Date): string {
        if (!utcTime) return '';
        const now = dayjs();
        const target = dayjs.utc(utcTime).local();
        
        const diffInHours = now.diff(target, 'hour');
        
        // 如果超过 24 小时，显示具体日期；否则显示相对时间
        if (diffInHours >= 24) {
            return target.format('YYYY-MM-DD HH:mm');
        }
        return target.fromNow();
    }
};