import type { RefObject } from "react"
import { useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { AxolState } from "./types"

const L_ELBOW_JOINT = "left-arm-lower" as XRBodyJoint
const R_ELBOW_JOINT = "right-arm-lower" as XRBodyJoint

export function AxolVRClient({
  wsRef,
  onStateChange,
}: {
  wsRef: RefObject<WebSocket | null>
  onStateChange?: (state: AxolState) => void
}) {
  const { gl } = useThree()

  const stateRef = useRef<AxolState>(AxolState.Teleop)
  const prevXRef = useRef(false)
  const prevYRef = useRef(false)
  const prevARef = useRef(false)
  const recordingPendingAtRef = useRef<number | null>(null)

  useFrame(() => {
    const session = gl.xr.getSession()
    if (!session) return

    const frame = gl.xr.getFrame()
    const refSpace = gl.xr.getReferenceSpace()
    if (!frame || !refSpace) return

    const leftSource = Array.from(session.inputSources).find(
      (s: XRInputSource) => s.handedness === "left"
    )
    const rightSource = Array.from(session.inputSources).find(
      (s: XRInputSource) => s.handedness === "right"
    )

    const xPressed = leftSource?.gamepad?.buttons[4]?.pressed ?? false
    const yPressed = leftSource?.gamepad?.buttons[5]?.pressed ?? false
    const aPressed = rightSource?.gamepad?.buttons[4]?.pressed ?? false

    const xEdge = xPressed && !prevXRef.current
    const yEdge = yPressed && !prevYRef.current
    const aEdge = aPressed && !prevARef.current

    prevXRef.current = xPressed
    prevYRef.current = yPressed
    prevARef.current = aPressed

    const state = stateRef.current

    function setState(next: AxolState) {
      stateRef.current = next
      onStateChange?.(next)
    }

    // X — reset; also cancels recording
    let reset = false
    if (xEdge) {
      reset = true
      if (state === AxolState.Recording) {
        setState(AxolState.DataCollection)
        recordingPendingAtRef.current = null
      }
    }

    // Y — swap teleop ↔ data_collection (disabled when recording)
    if (yEdge && state !== AxolState.Recording) {
      setState(state === AxolState.Teleop ? AxolState.DataCollection : AxolState.Teleop)
    }

    // A — start episode (3s delay) or stop recording immediately
    if (aEdge) {
      if (state === AxolState.Recording) {
        setState(AxolState.DataCollection)
        recordingPendingAtRef.current = null
      } else if (state === AxolState.DataCollection && recordingPendingAtRef.current === null) {
        recordingPendingAtRef.current = Date.now()
      }
    }

    // Promote pending → recording after 3s
    if (
      recordingPendingAtRef.current !== null &&
      Date.now() - recordingPendingAtRef.current >= 3000
    ) {
      setState(AxolState.Recording)
      recordingPendingAtRef.current = null
    }

    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    function getPose(space: XRSpace | null | undefined) {
      if (!space) return null
      const pose = frame.getPose(space, refSpace!)
      if (!pose) return null
      const { position: p, orientation: o } = pose.transform
      return {
        position: { x: p.x, y: p.y, z: p.z },
        quaternion: { x: o.x, y: o.y, z: o.z, w: o.w },
      }
    }

    function getPosition(space: XRSpace | null | undefined) {
      if (!space) return null
      const pose = frame.getPose(space, refSpace!)
      if (!pose) return null
      const { position: p } = pose.transform
      return { x: p.x, y: p.y, z: p.z }
    }

    const l_ee = getPose(leftSource?.targetRaySpace)
    const r_ee = getPose(rightSource?.targetRaySpace)

    if (!l_ee || !r_ee) return

    const body = (frame as XRFrame & { body?: XRBody }).body
    const l_elbow = getPosition(body?.get(L_ELBOW_JOINT))
    const r_elbow = getPosition(body?.get(R_ELBOW_JOINT))

    if (!l_elbow || !r_elbow) return

    const l_grip = 1 - (leftSource?.gamepad?.buttons[0]?.value ?? 0)
    const r_grip = 1 - (rightSource?.gamepad?.buttons[0]?.value ?? 0)
    const l_lock = (leftSource?.gamepad?.buttons[1]?.value ?? 0) >= 1.0
    const r_lock = (rightSource?.gamepad?.buttons[1]?.value ?? 0) >= 1.0

    ws.send(
      JSON.stringify({
        l_ee,
        r_ee,
        l_elbow,
        r_elbow,
        l_lock,
        r_lock,
        l_grip,
        r_grip,
        reset,
        state: stateRef.current,
      })
    )
  })

  return null
}
