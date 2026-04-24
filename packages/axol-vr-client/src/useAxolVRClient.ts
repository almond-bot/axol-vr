import { useEffect, useRef, useState } from "react"
import { AxolConnectionStatus } from "./types"

export function useAxolVRClient(hostname: string, port = 8000, maxRetries = 3, retryMs = 1000) {
  const [status, setStatus] = useState<AxolConnectionStatus>(AxolConnectionStatus.Idle)
  const wsRef = useRef<WebSocket | null>(null)
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  function cleanup() {
    const ws = wsRef.current
    if (ws) {
      ws.onopen = null
      ws.onclose = null
      ws.onerror = null
      ws.close()
      wsRef.current = null
    }
  }

  function scheduleRetry() {
    if (!mountedRef.current) return
    if (retryCountRef.current < maxRetries) {
      retryCountRef.current += 1
      setStatus(AxolConnectionStatus.Connecting)
      retryTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current) connectWS()
      }, retryMs)
    } else {
      setStatus(AxolConnectionStatus.Failed)
    }
  }

  function connectWS() {
    if (!mountedRef.current) return
    cleanup()
    setStatus(AxolConnectionStatus.Connecting)

    try {
      const ws = new WebSocket(`wss://${hostname}:${port}/ws`)
      wsRef.current = ws

      ws.onopen = () => {
        if (!mountedRef.current) return
        retryCountRef.current = 0
        setStatus(AxolConnectionStatus.Open)
      }

      ws.onclose = () => {
        if (!mountedRef.current) return
        wsRef.current = null
        scheduleRetry()
      }

      ws.onerror = () => {
        if (!mountedRef.current) return
        setStatus(AxolConnectionStatus.Error)
      }
    } catch {
      if (!mountedRef.current) return
      setStatus(AxolConnectionStatus.Error)
      scheduleRetry()
    }
  }

  const connect = () => {
    retryCountRef.current = 0
    connectWS()
  }

  const disconnect = () => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
    cleanup()
    setStatus(AxolConnectionStatus.Idle)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current)
      cleanup()
    }
  }, [])

  return { status, connect, disconnect, wsRef }
}
