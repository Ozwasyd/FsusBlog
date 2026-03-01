<script setup lang="ts">
    import { onMounted, computed, watch, onUnmounted, ref } from 'vue'
    import { RouterView } from 'vue-router'
    import { ElConfigProvider } from 'element-plus'
    import zhCn from 'element-plus/es/locale/lang/zh-cn'
    import { useHead } from '@vueuse/head'

    import { useUserStore } from '@/store/user'
    import { useSiteStore } from '@/store/site'
    import { useNotification } from '@/composables/useNotification'
    import { notificationService } from '@/services/notificationService'

    const userStore = useUserStore()
    const siteStore = useSiteStore()
    const { initNotification } = useNotification()

    // 核心修正 (2026-02-22)：全局意图状态锁
    const hasTriggeredIntent = ref(false)
    let intentTimer: ReturnType<typeof setTimeout> | null = null

    // [修复 2026-02-23] 解决 SEO 元数据响应式隐患：
    // 使用统一的 computed 对象包裹整个 head 配置，确保 vueuse/head 能够精准追踪依赖变化
    const headConfig = computed(() => ({
        titleTemplate: (titleChunk: string | undefined) => {
            const siteTitle = siteStore.siteInfo.title
            return titleChunk ? `${titleChunk} - ${siteTitle}` : siteTitle
        },
        meta: [
            { name: 'description', content: siteStore.siteInfo.description },
            { name: 'keywords', content: siteStore.siteInfo.keywords },
            { name: 'viewport', content: 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no' },
        ],
        bodyAttrs: {
            class: 'bg-white text-zinc-950 overflow-x-hidden selection:bg-zinc-950 selection:text-white'
        }
    }))
    
    useHead(headConfig)

    // [修复 2026-02-23] 解决 watch 监听源与重复初始化问题：
    // 使用解构后的计算属性，并增加 isInitializing 状态保护逻辑（initNotification 内部已包含）
    // 逻辑自洽：仅在 isAuthChecked 完成后才响应登录态变化，防止初始加载时的冗余连接
    watch(
        () => userStore.isLoggedIn,
        async (loggedIn) => {
            if (!userStore.isAuthChecked) return;
            console.log(`[App] 身份状态变更: ${loggedIn ? '登录' : '登出'}，重调通知系统`);
            await initNotification(loggedIn);
        }
    );

    /**
     * 全局游客意图触发器 
     * [修复 2026-02-23] 解决竞态：同步检查与设置锁，物理隔离并发触发
     */
    const triggerGlobalIntent = async () => {
        // 同步锁检查：必须在 await 之前执行，防止微任务切换导致的并发执行
        if (hasTriggeredIntent.value || userStore.isLoggedIn) {
            removeIntentListeners();
            return;
        }
        
        hasTriggeredIntent.value = true;
        removeIntentListeners();

        console.log('[Global Intent] 捕获到真实访客行为，开始预热全局实时通讯...');
        try {
            // [修复 2026-02-23] 性能最大化：此处不使用 await 阻塞主线程
            initNotification(false).catch(e => console.warn('[Global Intent] 游客连接建立受限', e));
        } catch (e) {
            /* ignore */
        }
    }

    const removeIntentListeners = () => {
        if (intentTimer) {
            clearTimeout(intentTimer);
            intentTimer = null;
        }
        // 显式清理，无论 once 是否已触发，确保物理层面引用释放
        window.removeEventListener('scroll', triggerGlobalIntent);
        window.removeEventListener('mousemove', triggerGlobalIntent);
        window.removeEventListener('touchstart', triggerGlobalIntent);
    }

    onMounted(async () => {
        // [修复 2026-02-23] 状态信任修正：核心元数据加载
        const tasks: Promise<any>[] = [
            siteStore.fetchSiteInfo(),
            userStore.fetchUserInfo()
        ]

        // 逻辑自洽：等待核心鉴权握手完成
        await Promise.allSettled(tasks)

        if (userStore.isLoggedIn) {
            // 登录用户：握手完成且已登录，直接启动
            initNotification(true).catch(e => console.warn('[App] 用户连接失败', e));
        } else {
            // 未登录游客：挂载监听。如果用户在 5s 内已经触发过 intent，则不再挂载
            if (!hasTriggeredIntent.value) {
                window.addEventListener('scroll', triggerGlobalIntent, { once: true, passive: true });
                window.addEventListener('mousemove', triggerGlobalIntent, { once: true, passive: true });
                window.addEventListener('touchstart', triggerGlobalIntent, { once: true, passive: true });
                
                intentTimer = setTimeout(triggerGlobalIntent, 5000);
            }
        }

        // [修复 2026-02-23] 解决 Loader 布局抖动：
        // 使用 transitionend 事件精准监听动画结束，而非硬编码 setTimeout
        const loader = document.getElementById('global-loader')
        if (loader) {
            const handleTransitionEnd = () => {
                loader.remove();
                loader.removeEventListener('transitionend', handleTransitionEnd);
            };
            loader.addEventListener('transitionend', handleTransitionEnd);
            loader.style.opacity = '0';
            // 兜底清理
            setTimeout(() => loader?.remove(), 1000);
        }
    })

    onUnmounted(() => {
        removeIntentListeners();
        // [修复 2026-02-23] 逻辑自洽：SPA 根组件虽不常卸载，但在 HMR 场景下必须释放物理连接
        notificationService.stop();
    })
</script>

<template>
    <el-config-provider :locale="zhCn">
        <div class="app-wrapper w-full min-h-screen flex flex-col overflow-x-hidden">
            <!-- [修复 2026-02-23] 解决权限 UI 闪烁：增加 isAuthChecked 判定，确保握手后再渲染 -->
            <transition name="banner-slide">
                <div v-if="userStore.isAuthChecked && userStore.isLoggedIn && userStore.isBanned"
                     class="w-full bg-zinc-950 text-white py-2 px-6 flex items-center justify-center gap-4 z-200 relative">
                    <span class="text-[10px] font-bold tracking-[0.2em] uppercase">
                        当前账号处于管控状态：{{ userStore.userInfo?.banReason || '仅限阅读模式' }}
                    </span>
                    <router-link to="/user/messagebox" class="text-[9px] underline underline-offset-4 opacity-70 hover:opacity-100 transition-opacity uppercase font-bold tracking-widest">
                        查看详情
                    </router-link>
                </div>
            </transition>

            <router-view v-slot="{ Component }">
                <transition name="page-fade" mode="out-in">
                    <component :is="Component" />
                </transition>
            </router-view>
        </div>
    </el-config-provider>
</template>

<style>
    @reference "@/assets/main.css";

    html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        scroll-behavior: smooth;
        -webkit-tap-highlight-color: transparent;
    }

    * {
        box-sizing: border-box;
    }

    .page-fade-enter-active,
    .page-fade-leave-active {
        transition: opacity 0.25s ease;
    }

    .page-fade-enter-from,
    .page-fade-leave-to {
        opacity: 0;
    }

    .banner-slide-enter-active, .banner-slide-leave-active {
        transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .banner-slide-enter-from, .banner-slide-leave-to {
        transform: translateY(-100%);
    }
</style>