import { useEffect, useRef, useState } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { Html } from "@react-three/drei"
import { createXRStore, XR } from "@react-three/xr"
import * as THREE from "three"

const store = createXRStore({ bodyTracking: true })
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

type PoseInfo = {
  pos: { x: number; y: number; z: number }
  euler: { x: number; y: number; z: number }
} | null

const RAD = 180 / Math.PI
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()

function quatToEuler(q: { x: number; y: number; z: number; w: number }) {
  _q.set(q.x, q.y, q.z, q.w)
  _e.setFromQuaternion(_q, "XYZ")
  return { x: _e.x * RAD, y: _e.y * RAD, z: _e.z * RAD }
}

function PosePanel({ label, info, position }: { label: string; info: PoseInfo; position: [number, number, number] }) {
  return (
    <Html position={position} transform occlude={false} style={{ pointerEvents: "none" }}>
      <div style={{
        background: "rgba(0,0,0,0.75)",
        color: "#fff",
        fontFamily: "monospace",
        fontSize: 11,
        padding: "6px 10px",
        borderRadius: 6,
        border: "1px solid rgba(255,255,255,0.2)",
        minWidth: 180,
        whiteSpace: "nowrap",
      }}>
        <div style={{ fontWeight: "bold", marginBottom: 4, color: "#a5f3fc" }}>{label}</div>
        {info ? (
          <>
            <div style={{ color: "#86efac" }}>pos</div>
            <div>x {info.pos.x.toFixed(3)}</div>
            <div>y {info.pos.y.toFixed(3)}</div>
            <div>z {info.pos.z.toFixed(3)}</div>
            <div style={{ color: "#fde68a", marginTop: 4 }}>rot (deg)</div>
            <div>x {info.euler.x.toFixed(1)}</div>
            <div>y {info.euler.y.toFixed(1)}</div>
            <div>z {info.euler.z.toFixed(1)}</div>
          </>
        ) : (
          <div style={{ opacity: 0.5 }}>no data</div>
        )}
      </div>
    </Html>
  )
}

function PoseDisplay() {
  const { gl } = useThree()
  const [upper, setUpper] = useState<PoseInfo>(null)
  const [lower, setLower] = useState<PoseInfo>(null)
  const [controller, setController] = useState<PoseInfo>(null)
  const tickRef = useRef(0)

  useFrame(() => {
    const session = gl.xr.getSession()
    if (!session) return
    const frame = gl.xr.getFrame()
    const refSpace = gl.xr.getReferenceSpace()
    if (!frame || !refSpace) return

    const leftSource = Array.from(session.inputSources).find(
      (s: XRInputSource) => s.handedness === "left"
    )

    const body = (frame as XRFrame & { body?: XRBody }).body

    function readPose(space: XRSpace): PoseInfo {
      const pose = frame.getPose(space, refSpace!)
      if (!pose) return null
      const { position: p, orientation: o } = pose.transform
      return { pos: { x: p.x, y: p.y, z: p.z }, euler: quatToEuler(o) }
    }

    tickRef.current += 1
    if (tickRef.current % 6 !== 0) return

    setUpper(body?.get("left-arm-upper" as XRBodyJoint) ? readPose(body!.get("left-arm-upper" as XRBodyJoint)!) : null)
    setLower(body?.get("left-arm-lower" as XRBodyJoint) ? readPose(body!.get("left-arm-lower" as XRBodyJoint)!) : null)
    setController(leftSource?.gripSpace ? readPose(leftSource.gripSpace) : null)
  })

  return (
    <>
      <PosePanel label="left-arm-upper" info={upper} position={[-0.6, 1.4, -1]} />
      <PosePanel label="left-arm-lower" info={lower} position={[-0.6, 1.1, -1]} />
      <PosePanel label="controller (L)" info={controller} position={[-0.6, 0.8, -1]} />
    </>
  )
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

type ConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error" | "failed"

export default function App() {
  const [hostname, setHostname] = useState(() => localStorage.getItem("wsHostname") ?? "")
  const [wsUrl, setWsUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>("idle")
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const handleConnect = () => {
    localStorage.setItem("wsHostname", hostname)
    const url = `wss://${hostname}:8000/ws`
    retryCountRef.current = 0
    setStatus("connecting")
    setWsUrl(url)
  }

  const handleDisconnect = () => {
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
    setStatus("idle")
  }

  useEffect(() => {
    if (!wsUrl) return
    mountedRef.current = true

    const startConnection = () => {
      if (!mountedRef.current) return

      function connect(): WebSocket {
        const ws = new WebSocket(wsUrl!)
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
  }, [wsUrl])

  const isActive = status === "connecting" || status === "open"

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 10, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, pointerEvents: "none" }}>
        <div style={{ pointerEvents: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          {status === "open" && (
            <button type="button" onClick={() => store.enterAR()}>Start</button>
          )}
          {isActive && (
            <span
              style={{
                fontSize: 12,
                opacity: 0.9,
                color: status === "open" ? "#4ade80" : "#eab308"
              }}
            >
              {status === "open" ? "● Connected" : "○ Connecting…"}
            </span>
          )}
          {!isActive && (
            <form
              onSubmit={(e) => { e.preventDefault(); handleConnect() }}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <input
                type="text"
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                placeholder="rpi.local"
                style={{ fontSize: 12, padding: "4px 8px", borderRadius: 4, border: "1px solid #555", background: "#1a1a1a", color: "#eee", width: 160 }}
              />
              <button type="submit" style={{ padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>
                Connect
              </button>
            </form>
          )}
          {isActive && (
            <button
              type="button"
              onClick={handleDisconnect}
              style={{ padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
            >
              Disconnect
            </button>
          )}
          {status === "failed" && (
            <div
              style={{
                fontSize: 12,
                color: "#f87171",
                padding: "6px 10px",
                background: "rgba(248, 113, 113, 0.15)",
                borderRadius: 6,
                maxWidth: 280,
                textAlign: "center",
              }}
            >
              Could not connect to {wsUrl} after {MAX_RETRIES} attempts. Check that the server is running.
            </div>
          )}
        </div>
      </div>

      <Canvas>
        <XR store={store}>
          <PoseSender />
          <PoseDisplay />
        </XR>
      </Canvas>
    </>
  )
}
