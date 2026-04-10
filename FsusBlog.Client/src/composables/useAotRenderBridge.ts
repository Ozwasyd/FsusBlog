import { onMounted, onUnmounted, ref } from 'vue';
import { createRefreshGuard, isTransportToggleAction, parseAotEvent, type AotEventDetail } from '@/services/aotEventService';

type AotRenderBridgeOptions = {
  frameType: number;
  onRefresh: () => void;
  onPageNext?: () => void;
  onPagePrev?: () => void;
  onAction?: (payload: AotEventDetail) => void;
  cooldownMs?: number;
};

export function useAotRenderBridge(options: AotRenderBridgeOptions) {
  const aotRenderedHtml = ref('');
  const allowRefresh = createRefreshGuard(options.cooldownMs ?? 300);

  const clearAotHtml = () => {
    aotRenderedHtml.value = '';
  };

  const onBinaryRendered = (event: Event) => {
    const payload = (event as CustomEvent).detail as { frameType?: number; html?: string } | undefined;
    if (!payload || payload.frameType !== options.frameType) {
      return;
    }

    if (typeof payload.html === 'string' && payload.html.length > 0) {
      aotRenderedHtml.value = payload.html;
    }
  };

  const onAotEvent = (event: Event) => {
    const payload = parseAotEvent(event);
    if (!payload) {
      return;
    }

    const action = payload.action ?? '';
    if (!action) {
      return;
    }

    options.onAction?.(payload);

    if (isTransportToggleAction(action) && allowRefresh()) {
      options.onRefresh();
      return;
    }

    if (action === 'page-next') {
      options.onPageNext?.();
      return;
    }

    if (action === 'page-prev') {
      options.onPagePrev?.();
    }
  };

  onMounted(() => {
    window.addEventListener('fsus:binary:rendered', onBinaryRendered);
    window.addEventListener('fsus:aot:event', onAotEvent);
  });

  onUnmounted(() => {
    window.removeEventListener('fsus:binary:rendered', onBinaryRendered);
    window.removeEventListener('fsus:aot:event', onAotEvent);
  });

  return {
    aotRenderedHtml,
    clearAotHtml
  };
}
