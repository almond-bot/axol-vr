import { useEffect, useRef, useState } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { createXRStore, XR } from "@react-three/xr"
import * as THREE from "three"

// @pmndrs/xr already requests local-floor by default
const store = createXRStore({ bodyTracking: true })
const MAX_RETRIES = 3
const RETRY_MS = 1000

const wsRef = { current: null as WebSocket | null }

const SHOULDER_NODE = "left-scapula" as XRBodyJoint
const ELBOW_NODE = "left-arm-lower" as XRBodyJoint

const AXIS_LEN = 0.1
const SHAFT_R = 0.004
const TIP_R = 0.009
const TIP_LEN = 0.025
const DOT_RADIUS = 0.014

const AXES: { color: string; rotation: [number, number, number] }[] = [
  { color: "#ff4444", rotation: [0, 0, -Math.PI / 2] },   // X — red
  { color: "#44ff44", rotation: [0, 0, 0] },               // Y — green
  { color: "#4488ff", rotation: [Math.PI / 2, 0, 0] },    // Z — blue
]

function Arrow({ color, rotation }: { color: string; rotation: [number, number, number] }) {
  const shaftLen = AXIS_LEN - TIP_LEN
  return (
    <group rotation={rotation}>
      <mesh position={[0, shaftLen / 2, 0]}>
        <cylinderGeometry args={[SHAFT_R, SHAFT_R, shaftLen, 8]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh position={[0, shaftLen + TIP_LEN / 2, 0]}>
        <coneGeometry args={[TIP_R, TIP_LEN, 8]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  )
}

function AxesMarker({ groupRef, color }: { groupRef: React.RefObject<THREE.Group | null>; color: string }) {
  return (
    <group ref={groupRef} visible={false}>
      {AXES.map((a) => <Arrow key={a.color} color={a.color} rotation={a.rotation} />)}
      <mesh>
        <sphereGeometry args={[DOT_RADIUS, 10, 10]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  )
}

function PoseVisualizer() {
  const { gl } = useThree()
  const shoulderRef = useRef<THREE.Group>(null)
  const elbowRef = useRef<THREE.Group>(null)
  const controllerRef = useRef<THREE.Group>(null)

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

    function applyPose(group: THREE.Group | null, space: XRSpace | null | undefined) {
      if (!group) return
      if (!space) { group.visible = false; return }
      const pose = frame.getPose(space, refSpace!)
      if (!pose) { group.visible = false; return }
      const { position: p, orientation: o } = pose.transform
      group.position.set(p.x, p.y, p.z)
      group.quaternion.set(o.x, o.y, o.z, o.w)
      group.visible = true
    }

    applyPose(shoulderRef.current, body?.get(SHOULDER_NODE) ?? null)
    applyPose(elbowRef.current, body?.get(ELBOW_NODE) ?? null)
    applyPose(controllerRef.current, leftSource?.targetRaySpace ?? null)
  })

  return (
    <>
      <AxesMarker groupRef={shoulderRef} color="#c084fc" />
      <AxesMarker groupRef={elbowRef} color="#34d399" />
      <AxesMarker groupRef={controllerRef} color="#60a5fa" />
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

    // Require shoulder as the anchor for all relative calculations
    const body = (frame as XRFrame & { body?: XRBody }).body
    const shoulderSpace = body?.get(SHOULDER_NODE)
    if (!shoulderSpace) return
    const shoulderPose = frame.getPose(shoulderSpace, refSpace)
    if (!shoulderPose) return

    const shoulderPos = new THREE.Vector3(
      shoulderPose.transform.position.x,
      shoulderPose.transform.position.y,
      shoulderPose.transform.position.z,
    )
    const shoulderQuat = new THREE.Quaternion(
      shoulderPose.transform.orientation.x,
      shoulderPose.transform.orientation.y,
      shoulderPose.transform.orientation.z,
      shoulderPose.transform.orientation.w,
    )
    const shoulderQuatInv = shoulderQuat.clone().invert()

    const payload: Record<string, unknown> = {}

    if (needsCalibrateRef.current) {
      payload.calibrate = true
      needsCalibrateRef.current = false
    }

    // Controller: position and orientation relative to shoulder, then → URDF
    if (leftSource?.targetRaySpace) {
      const pose = frame.getPose(leftSource.targetRaySpace, refSpace)
      if (pose) {
        const worldPos = new THREE.Vector3(
          pose.transform.position.x,
          pose.transform.position.y,
          pose.transform.position.z,
        )
        const worldQuat = new THREE.Quaternion(
          pose.transform.orientation.x,
          pose.transform.orientation.y,
          pose.transform.orientation.z,
          pose.transform.orientation.w,
        )
        const relPos = worldPos.sub(shoulderPos).applyQuaternion(shoulderQuatInv)
        const relQuat = shoulderQuatInv.clone().multiply(worldQuat)
        payload.controller = {
          pos: { x: relPos.x, y: relPos.y, z: relPos.z },
          quat: { x: relQuat.x, y: relQuat.y, z: relQuat.z, w: relQuat.w },
        }
      }
    }

    // Elbow: position only relative to shoulder, then → URDF (quat ignored by IK solver)
    const elbowSpace = body?.get(ELBOW_NODE)
    if (elbowSpace) {
      const pose = frame.getPose(elbowSpace, refSpace)
      if (pose) {
        const worldPos = new THREE.Vector3(
          pose.transform.position.x,
          pose.transform.position.y,
          pose.transform.position.z,
        )
        const relPos = worldPos.sub(shoulderPos).applyQuaternion(shoulderQuatInv)
        payload.elbow = { pos: { x: relPos.x, y: relPos.y, z: relPos.z } }
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
          <PoseVisualizer />
        </XR>
      </Canvas>
    </>
  )
}
