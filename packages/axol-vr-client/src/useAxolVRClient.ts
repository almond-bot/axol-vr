import { useEffect, useRef, useState } from "react"
import { AxolConnectionStatus } from "./types"

export function useAxolVRClient(hostname: string, port = 8000, maxRetries = 3, retryMs = 1000) {
  const [wsUrl, setWsUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<AxolConnectionStatus>(AxolConnectionStatus.Idle)
  const wsRef = useRef<WebSocket | null>(null)
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const connect = () => {
    retryCountRef.current = 0
    setStatus(AxolConnectionStatus.Connecting)
    setWsUrl(`wss://${hostname}:${port}/ws`)
  }

  const disconnect = () => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
    const current = wsRef.current
    if (current) {
      current.onclose = null
      current.close()
      wsRef.current = null
    }
    setWsUrl(null)
    setStatus(AxolConnectionStatus.Idle)
  }

  useEffect(() => {
    if (!wsUrl) return
    mountedRef.current = true

    function connectWs(): WebSocket {
      const ws = new WebSocket(wsUrl!)
      wsRef.current = ws

      ws.onopen = () => {
        if (mountedRef.current) {
          retryCountRef.current = 0
          setStatus(AxolConnectionStatus.Open)
        }
      }

      ws.onerror = () => {
        if (mountedRef.current) setStatus(AxolConnectionStatus.Error)
      }

      ws.onclose = () => {
        wsRef.current = null
        if (!mountedRef.current) return

        if (retryCountRef.current < maxRetries) {
          retryCountRef.current += 1
          setStatus(AxolConnectionStatus.Connecting)
          retryTimeoutRef.current = setTimeout(() => {
            if (mountedRef.current) connectWs()
          }, retryMs)
        } else {
          setStatus(AxolConnectionStatus.Failed)
        }
      }

      return ws
    }

    const id = requestAnimationFrame(() => {
      if (mountedRef.current) connectWs()
    })

    return () => {
      mountedRef.current = false
      cancelAnimationFrame(id)
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
      const current = wsRef.current
      if (current) {
        current.close()
        wsRef.current = null
      }
    }
  }, [wsUrl])

  return { status, wsUrl, connect, disconnect, wsRef }
}
