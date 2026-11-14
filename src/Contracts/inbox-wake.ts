import { decodeFrame, decodeSuccess, ProtocolError } from './aeds.ts';
import { FrameType, WireRoutes } from './wire.generated.ts';

export function watchInboxWake(signal: AbortSignal, onWake: () => void, onState: (connected: boolean) => void, onRevoked: () => void) {
  const endpoint = new URL(WireRoutes.InboxStream, location.href);
  endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backoff = 1_000;

  function connect() {
    if (signal.aborted) return;
    const connection = new WebSocket(endpoint, 'fsus-inbox-wake.v2');
    socket = connection;
    connection.binaryType = 'arraybuffer';
    connection.onopen = () => {
      if (socket !== connection || signal.aborted) return;
      backoff = 1_000;
      onState(true);
    };
    connection.onmessage = event => {
      if (socket !== connection || signal.aborted) return;
      try {
        if (!(event.data instanceof ArrayBuffer)) throw new ProtocolError('Invalid inbox wake');
        decodeSuccess(decodeFrame(new Uint8Array(event.data), FrameType.EmptySuccess).payload);
        onWake();
      } catch {
        connection.close(1000);
      }
    };
    connection.onclose = event => {
      if (socket !== connection || signal.aborted) return;
      socket = undefined;
      if (event.code === 1008) {
        onRevoked();
        return;
      }
      onState(false);
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 16_000);
    };
  }

  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.close();
      socket = undefined;
    }
  }, { once: true });
  connect();
}
