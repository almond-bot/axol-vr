import { useEffect, useRef, useState } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { createXRStore, XR } from "@react-three/xr"

const store = createXRStore({ bodyTracking: true })
const WS_URL = "wss://almond-pi.local:8000/ws"
const MAX_RETRIES = 3
const RETRY_MS = 1000

const wsRef = { current: null as WebSocket | null }

const ARM_JOINTS = ["left-arm-upper", "left-arm-lower"] as const

function poseToPayload(pose: XRPose) {
  const { position, orientation } = pose.transform
  return {
    pos: { x: position.x, y: position.y, z: position.z },
    quat: { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w },
  }
}

function PoseSender() {
  const { gl } = useThree()
  const sendingEnabledRef = useRef(false)
  const xButtonPrevRef = useRef(false)
  const needsCalibrateRef = useRef(false)

  useFrame(() => {
    const session = gl.xr.getSession()
    if (!session) return

    const frame = gl.xr.getFrame()
    const refSpace = gl.xr.getReferenceSpace()
    if (!frame || !refSpace) return

    const leftSource = Array.from(session.inputSources).find(
      (source: XRInputSource) => source.handedness === "left"
    )

    // Detect X button press (button index 4 on left controller)
    const xPressed = leftSource?.gamepad?.buttons[4]?.pressed ?? false
    if (xPressed && !xButtonPrevRef.current) {
      sendingEnabledRef.current = !sendingEnabledRef.current
      if (sendingEnabledRef.current) needsCalibrateRef.current = true
    }
    xButtonPrevRef.current = xPressed

    if (!sendingEnabledRef.current) return

    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const payload: Record<string, unknown> = {}

    if (needsCalibrateRef.current) {
      payload.calibrate = true
      needsCalibrateRef.current = false
    }

    // Controller (left grip) pose
    if (leftSource?.gripSpace) {
      const pose = frame.getPose(leftSource.gripSpace, refSpace)
      if (pose) payload.controller = poseToPayload(pose)
    }

    // Body tracking: left-arm-upper, left-arm-lower
    const body = (frame as XRFrame & { body?: XRBody }).body
    if (body) {
      for (const jointName of ARM_JOINTS) {
        const space = body.get(jointName as XRBodyJoint)
        if (space) {
          const pose = frame.getPose(space, refSpace)
          if (pose) payload[jointName] = poseToPayload(pose)
        }
      }
    }

    if (Object.keys(payload).length > 0) {
      ws.send(JSON.stringify(payload))
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
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
          <PoseSender />
        </XR>
      </Canvas>
    </>
  )
}
