import { useRef, useState, useCallback, useEffect } from "react";

/**
 * WebSocket hook for Claude Cockpit.
 * Manages connection, message sending/receiving, and reconnection.
 */
export function useWebSocket({ onMessage, onConnect, onDisconnect } = {}) {
  const wsRef = useRef(null);
  const callbacksRef = useRef({ onMessage, onConnect, onDisconnect });
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef(null);

  // Keep callbacks fresh without re-creating the hook
  useEffect(() => {
    callbacksRef.current = { onMessage, onConnect, onDisconnect };
  }, [onMessage, onConnect, onDisconnect]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return wsRef.current;
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return wsRef.current;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/session`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      callbacksRef.current.onConnect?.();
    };

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        callbacksRef.current.onMessage?.(data);
      } catch {
        // non-JSON — ignore
      }
    };

    ws.onclose = () => {
      setConnected(false);
      callbacksRef.current.onDisconnect?.();
      // Auto-reconnect after 3s
      reconnectTimer.current = setTimeout(() => {
        if (wsRef.current === ws) connect();
      }, 3000);
    };

    ws.onerror = () => {
      // onclose will fire after this
    };

    return ws;
  }, []);

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
      return true;
    }
    return false;
  }, []);

  const sendPrompt = useCallback((text, { model = "sonnet", files = [], workdir } = {}) => {
    return send({
      type: "prompt",
      text,
      model,
      files,
      ...(workdir ? { workdir } : {}),
    });
  }, [send]);

  const cancel = useCallback(() => {
    return send({ type: "cancel" });
  }, [send]);

  const close = useCallback(() => {
    clearTimeout(reconnectTimer.current);
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  return { connected, connect, send, sendPrompt, cancel, close };
}
