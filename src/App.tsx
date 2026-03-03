import { useEffect, useRef, useState } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { createXRStore, XR } from "@react-three/xr"
import * as THREE from "three"

const store = createXRStore({ bodyTracking: true })
const MAX_RETRIES = 3
const RETRY_MS = 1000

const wsRef = { current: null as WebSocket | null }

const L_SHOULDER_JOINT = "left-scapula" as XRBodyJoint
const R_SHOULDER_JOINT = "right-scapula" as XRBodyJoint
const L_ELBOW_JOINT = "left-arm-lower" as XRBodyJoint
const R_ELBOW_JOINT = "right-arm-lower" as XRBodyJoint

// Right scapula frame has Y and Z flipped vs left — correct with Rx(180°)
// q = (sin(π/2), 0, 0, cos(π/2)) = (x:1, y:0, z:0, w:0)
const R_SCAPULA_CORRECTION = new THREE.Quaternion(1, 0, 0, 0)

const AXIS_LEN = 0.1
const SHAFT_R = 0.004
const TIP_R = 0.009
const TIP_LEN = 0.025
const DOT_RADIUS = 0.014

const AXES: { color: string; rotation: [number, number, number] }[] = [
  { color: "#FF0000", rotation: [0, 0, -Math.PI / 2] },   // X — red
  { color: "#00FF00", rotation: [0, 0, 0] },               // Y — green
  { color: "#0000FF", rotation: [Math.PI / 2, 0, 0] },    // Z — blue
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

function AxesMarker({ groupRef, color, showAxes = true }: { groupRef: React.RefObject<THREE.Group | null>; color: string; showAxes?: boolean }) {
  return (
    <group ref={groupRef} visible={false}>
      {showAxes && AXES.map((a) => <Arrow key={a.color} color={a.color} rotation={a.rotation} />)}
      <mesh>
        <sphereGeometry args={[DOT_RADIUS, 10, 10]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  )
}

function PoseVisualizer() {
  const { gl } = useThree()
  const leftRef = useRef<THREE.Group>(null)
  const rightRef = useRef<THREE.Group>(null)
  const lShoulderRef = useRef<THREE.Group>(null)
  const rShoulderRef = useRef<THREE.Group>(null)
  const lElbowRef = useRef<THREE.Group>(null)
  const rElbowRef = useRef<THREE.Group>(null)

  useFrame(() => {
    const session = gl.xr.getSession()
    if (!session) return
    const frame = gl.xr.getFrame()
    const refSpace = gl.xr.getReferenceSpace()
    if (!frame || !refSpace) return

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

    function applyPositionOnly(group: THREE.Group | null, space: XRSpace | null | undefined) {
      if (!group) return
      if (!space) { group.visible = false; return }
      const pose = frame.getPose(space, refSpace!)
      if (!pose) { group.visible = false; return }
      const { position: p } = pose.transform
      group.position.set(p.x, p.y, p.z)
      group.visible = true
    }

    const leftSource = Array.from(session.inputSources).find((s: XRInputSource) => s.handedness === "left")
    const rightSource = Array.from(session.inputSources).find((s: XRInputSource) => s.handedness === "right")

    applyPose(leftRef.current, leftSource?.targetRaySpace ?? null)
    applyPose(rightRef.current, rightSource?.targetRaySpace ?? null)

    const body = (frame as XRFrame & { body?: XRBody }).body
    applyPose(lShoulderRef.current, body?.get(L_SHOULDER_JOINT))
    applyPose(rShoulderRef.current, body?.get(R_SHOULDER_JOINT))
    if (rShoulderRef.current?.visible) {
      rShoulderRef.current.quaternion.multiply(R_SCAPULA_CORRECTION)
    }
    applyPositionOnly(lElbowRef.current, body?.get(L_ELBOW_JOINT))
    applyPositionOnly(rElbowRef.current, body?.get(R_ELBOW_JOINT))
  })

  return (
    <>
      <AxesMarker groupRef={leftRef} color="#FF0000" />
      <AxesMarker groupRef={rightRef} color="#FF0000" />
      <AxesMarker groupRef={lShoulderRef} color="#0000FF" />
      <AxesMarker groupRef={rShoulderRef} color="#0000FF" />
      <AxesMarker groupRef={lElbowRef} color="#00FF00" showAxes={false} />
      <AxesMarker groupRef={rElbowRef} color="#00FF00" showAxes={false} />
    </>
  )
}

function PoseSender() {
  const { gl } = useThree()
  const modeRef = useRef<"absolute" | "relative">("relative")
  const prevARef = useRef(false)

  useFrame(() => {
    const session = gl.xr.getSession()
    if (!session) return

    const frame = gl.xr.getFrame()
    const refSpace = gl.xr.getReferenceSpace()
    if (!frame || !refSpace) return

    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const leftSource = Array.from(session.inputSources).find((s: XRInputSource) => s.handedness === "left")
    const rightSource = Array.from(session.inputSources).find((s: XRInputSource) => s.handedness === "right")

    // A button = buttons[4] on right controller; toggle mode on press edge
    const aDown = rightSource?.gamepad?.buttons[4]?.pressed ?? false
    if (aDown && !prevARef.current) {
      modeRef.current = modeRef.current === "absolute" ? "relative" : "absolute"
    }
    prevARef.current = aDown

    function getRawPose(space: XRSpace | null | undefined) {
      if (!space) return null
      const pose = frame.getPose(space, refSpace!)
      if (!pose) return null
      const { position: p, orientation: o } = pose.transform
      return { x: p.x, y: p.y, z: p.z, qx: o.x, qy: o.y, qz: o.z, qw: o.w }
    }

    function getPositionOnly(space: XRSpace | null | undefined): { x: number; y: number; z: number } | null {
      if (!space) return null
      const pose = frame.getPose(space, refSpace!)
      if (!pose) return null
      const { position: p } = pose.transform
      return { x: p.x, y: p.y, z: p.z }
    }

    const leftPose = getRawPose(leftSource?.targetRaySpace)
    const rightPose = getRawPose(rightSource?.targetRaySpace)

    // Head pose from viewer (HMD)
    const viewerPose = frame.getViewerPose(refSpace)
    const headPose = viewerPose
      ? (() => {
          const { position: p, orientation: o } = viewerPose.transform
          return { x: p.x, y: p.y, z: p.z, qx: o.x, qy: o.y, qz: o.z, qw: o.w }
        })()
      : null

    // Shoulder joints from WebXR body tracking (Quest body-tracking API)
    const body = (frame as XRFrame & { body?: XRBody }).body
    const lShoulderPose = getRawPose(body?.get(L_SHOULDER_JOINT))
    const rShoulderRaw = getRawPose(body?.get(R_SHOULDER_JOINT))
    // Apply Rx(180°) correction so right scapula frame matches left
    const rShoulderPose = rShoulderRaw && (() => {
      const q = new THREE.Quaternion(rShoulderRaw.qx, rShoulderRaw.qy, rShoulderRaw.qz, rShoulderRaw.qw)
      q.multiply(R_SCAPULA_CORRECTION)
      return { ...rShoulderRaw, qx: q.x, qy: q.y, qz: q.z, qw: q.w }
    })()

    const lElbowPos = getPositionOnly(body?.get(L_ELBOW_JOINT))
    const rElbowPos = getPositionOnly(body?.get(R_ELBOW_JOINT))

    if (!leftPose || !rightPose || !lShoulderPose || !rShoulderPose) return

    // Rear trigger (index finger) = button 0; side squeeze = button 1 (Quest Touch)
    const lRearTrigger = leftSource?.gamepad?.buttons[0]?.value ?? 0
    const rRearTrigger = rightSource?.gamepad?.buttons[0]?.value ?? 0
    const lSqueeze = leftSource?.gamepad?.buttons[1]?.value ?? 0
    const rSqueeze = rightSource?.gamepad?.buttons[1]?.value ?? 0
    const lLock = lSqueeze >= 1.0
    const rLock = rSqueeze >= 1.0
    // Grip from rear trigger: 1 when not pressed, 0 when fully pressed, linear in between
    const lGrip = 1 - lRearTrigger
    const rGrip = 1 - rRearTrigger

    ws.send(JSON.stringify({
      head: headPose,
      left: leftPose,
      right: rightPose,
      l_shoulder: lShoulderPose,
      r_shoulder: rShoulderPose,
      l_elbow: lElbowPos,
      r_elbow: rElbowPos,
      l_lock: lLock,
      r_lock: rLock,
      l_grip: lGrip,
      r_grip: rGrip,
      mode: modeRef.current,
    }))
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
    const url = `wss://${hostname}:8001/ws`
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
