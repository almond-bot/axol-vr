import { useEffect, useRef, useState } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { createXRStore, XR } from "@react-three/xr"

const store = createXRStore()
const WS_URL = "wss://almond-pi5.local:8000"
const MAX_RETRIES = 3
const RETRY_MS = 1000

const wsRef = { current: null as WebSocket | null }

function LeftController() {
  const { gl } = useThree()

  useFrame(() => {
    const session = gl.xr.getSession()
    if (!session) return

    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const inputSource = Array.from(session.inputSources).find(
      (source: XRInputSource) => source.handedness === "left"
    )

    if (inputSource?.gripSpace) {
      const pose = gl.xr.getFrame()?.getPose(inputSource.gripSpace, gl.xr.getReferenceSpace()!)
      if (pose) {
        const { position, orientation } = pose.transform
        ws.send(JSON.stringify({
          pos: { x: position.x, y: position.y, z: position.z },
          quat: { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w }
        }))
      }
    }
  })

  return null
}

type ConnectionStatus = "connecting" | "open" | "closed" | "error" | "failed"

export default function App() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting")
  const [retryKey, setRetryKey] = useState(0)
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const handleRetry = () => {
    retryCountRef.current = 0
    setStatus("connecting")
    setRetryKey((k) => k + 1)
  }

  useEffect(() => {
    mountedRef.current = true

    const startConnection = () => {
      if (!mountedRef.current) return

      function connect(): WebSocket {
        const ws = new WebSocket(WS_URL)
        wsRef.current = ws

        ws.onopen = () => {
          if (mountedRef.current) {
            retryCountRef.current = 0
            setStatus("open")
          }
        }

        ws.onerror = () => {
          if (mountedRef.current) setStatus("error")
        }

        ws.onclose = () => {
          wsRef.current = null
          if (!mountedRef.current) return

          if (retryCountRef.current < MAX_RETRIES) {
            retryCountRef.current += 1
            setStatus("connecting")
            retryTimeoutRef.current = setTimeout(() => {
              if (mountedRef.current) connect()
            }, RETRY_MS)
          } else {
            setStatus("failed")
          }
        }

        return ws
      }

      return connect()
    }

    const id = requestAnimationFrame(() => {
      if (!mountedRef.current) return
      startConnection()
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
  }, [retryKey])

  return (
    <>
      <div style={{ position: "fixed", top: 8, left: 8, zIndex: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" onClick={() => store.enterAR()}>Enter AR</button>
          <span
            style={{
              fontSize: 12,
              opacity: 0.9,
              color: status === "open" ? "#4ade80" : status === "failed" || status === "error" || status === "closed" ? "#f87171" : "#eab308"
            }}
            title={status === "open" ? "Connected" : status === "connecting" ? "Connecting…" : status === "failed" ? `Connection failed after ${MAX_RETRIES} attempts` : "WebSocket unavailable"}
          >
            {status === "open" ? "● Connected" : status === "connecting" ? "○ Connecting…" : status === "failed" ? `● Failed after ${MAX_RETRIES} tries` : "● Disconnected"}
          </span>
        </div>
        {status === "failed" && (
          <div
            style={{
              fontSize: 12,
              color: "#f87171",
              padding: "6px 10px",
              background: "rgba(248, 113, 113, 0.15)",
              borderRadius: 6,
              maxWidth: 280,
              display: "flex",
              flexDirection: "column",
              gap: 8
            }}
          >
            <span>
              WebSocket could not connect to {WS_URL} after {MAX_RETRIES} attempts. Check that the server is running.
            </span>
            <button
              type="button"
              onClick={handleRetry}
              style={{ alignSelf: "flex-start", padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
            >
              Retry
            </button>
          </div>
        )}
      </div>

      <Canvas>
        <XR store={store}>
          <LeftController />
        </XR>
      </Canvas>
    </>
  )
}
