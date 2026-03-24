import { useRef, useState } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { createXRStore, XR } from "@react-three/xr"
import * as THREE from "three"
import { AxolConnectionStatus, AxolVRClient, useAxolVRClient } from "@almond/axol-vr-client"

const store = createXRStore({ handTracking: false, bodyTracking: true })

const L_ELBOW_JOINT = "left-arm-lower" as XRBodyJoint
const R_ELBOW_JOINT = "right-arm-lower" as XRBodyJoint

const AXIS_LEN = 0.1
const SHAFT_R = 0.004
const TIP_R = 0.009
const TIP_LEN = 0.025
const DOT_RADIUS = 0.014

const AXES: { color: string; rotation: [number, number, number] }[] = [
  { color: "#FF0000", rotation: [0, 0, -Math.PI / 2] }, // X — red
  { color: "#00FF00", rotation: [0, 0, 0] }, // Y — green
  { color: "#0000FF", rotation: [Math.PI / 2, 0, 0] }, // Z — blue
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

function AxesMarker({ groupRef }: { groupRef: React.RefObject<THREE.Group | null> }) {
  return (
    <group ref={groupRef} visible={false}>
      {AXES.map((a) => (
        <Arrow key={a.color} color={a.color} rotation={a.rotation} />
      ))}
      <mesh>
        <sphereGeometry args={[DOT_RADIUS, 10, 10]} />
        <meshBasicMaterial color="#FF0000" />
      </mesh>
    </group>
  )
}

function PoseVisualizer() {
  const { gl } = useThree()
  const leftRef = useRef<THREE.Group>(null)
  const rightRef = useRef<THREE.Group>(null)
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
      if (!space) {
        group.visible = false
        return
      }
      const pose = frame.getPose(space, refSpace!)
      if (!pose) {
        group.visible = false
        return
      }
      const { position: p, orientation: o } = pose.transform
      group.position.set(p.x, p.y, p.z)
      group.quaternion.set(o.x, o.y, o.z, o.w)
      group.visible = true
    }

    function applyPositionOnly(group: THREE.Group | null, space: XRSpace | null | undefined) {
      if (!group) return
      if (!space) {
        group.visible = false
        return
      }
      const pose = frame.getPose(space, refSpace!)
      if (!pose) {
        group.visible = false
        return
      }
      const { position: p } = pose.transform
      group.position.set(p.x, p.y, p.z)
      group.visible = true
    }

    const leftSource = Array.from(session.inputSources).find(
      (s: XRInputSource) => s.handedness === "left"
    )
    const rightSource = Array.from(session.inputSources).find(
      (s: XRInputSource) => s.handedness === "right"
    )

    applyPose(leftRef.current, leftSource?.targetRaySpace ?? null)
    applyPose(rightRef.current, rightSource?.targetRaySpace ?? null)

    const body = (frame as XRFrame & { body?: XRBody }).body
    applyPositionOnly(lElbowRef.current, body?.get(L_ELBOW_JOINT))
    applyPositionOnly(rElbowRef.current, body?.get(R_ELBOW_JOINT))
  })

  return (
    <>
      <AxesMarker groupRef={leftRef} />
      <AxesMarker groupRef={rightRef} />
      <group ref={lElbowRef} visible={false}>
        <mesh>
          <sphereGeometry args={[DOT_RADIUS, 10, 10]} />
          <meshBasicMaterial color="#00FF00" />
        </mesh>
      </group>
      <group ref={rElbowRef} visible={false}>
        <mesh>
          <sphereGeometry args={[DOT_RADIUS, 10, 10]} />
          <meshBasicMaterial color="#00FF00" />
        </mesh>
      </group>
    </>
  )
}

export default function App() {
  const [hostname, setHostname] = useState(() => localStorage.getItem("wsHostname") ?? "")
  const { status, wsUrl, connect, disconnect, wsRef } = useAxolVRClient(hostname)

  const handleConnect = () => {
    localStorage.setItem("wsHostname", hostname)
    connect()
  }

  const isActive =
    status === AxolConnectionStatus.Connecting || status === AxolConnectionStatus.Open

  return (
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 10,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            pointerEvents: "auto",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
          }}
        >
          {status === AxolConnectionStatus.Open && (
            <button type="button" onClick={() => store.enterAR()}>
              Start
            </button>
          )}
          {isActive && (
            <span
              style={{
                fontSize: 12,
                opacity: 0.9,
                color: status === AxolConnectionStatus.Open ? "#4ade80" : "#eab308",
              }}
            >
              {status === AxolConnectionStatus.Open ? "● Connected" : "○ Connecting…"}
            </span>
          )}
          {!isActive && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                handleConnect()
              }}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <input
                type="text"
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                placeholder="workstation.local"
                style={{
                  fontSize: 12,
                  padding: "4px 8px",
                  borderRadius: 4,
                  border: "1px solid #555",
                  background: "#1a1a1a",
                  color: "#eee",
                  width: 160,
                }}
              />
              <button
                type="submit"
                style={{ padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
              >
                Connect
              </button>
            </form>
          )}
          {isActive && (
            <button
              type="button"
              onClick={disconnect}
              style={{ padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
            >
              Disconnect
            </button>
          )}
          {status === AxolConnectionStatus.Failed && (
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
              Could not connect to {wsUrl}. Check that the server is running.
            </div>
          )}
        </div>
      </div>

      <Canvas>
        <XR store={store}>
          <AxolVRClient wsRef={wsRef} />
          <PoseVisualizer />
        </XR>
      </Canvas>
    </>
  )
}
