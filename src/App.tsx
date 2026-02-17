import { useEffect } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { createXRStore, XR } from "@react-three/xr"

const store = createXRStore()
let ws: WebSocket | null = null

function LeftController() {
  const { gl } = useThree()

  useFrame(() => {
    const session = gl.xr.getSession()
    if (!session) return

    const inputSource = Array.from(session.inputSources).find(
      (source: XRInputSource) => source.handedness === "left"
    )

    if (inputSource?.gripSpace) {
      const pose = gl.xr.getFrame()?.getPose(inputSource.gripSpace, gl.xr.getReferenceSpace()!)
      if (pose && ws?.readyState === WebSocket.OPEN) {
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

export default function App() {
  useEffect(() => {
    ws = new WebSocket("ws://almond-pi5.local:8000")
    return () => ws?.close()
  }, [])

  return (
    <>
      <button onClick={() => store.enterAR()}>Enter AR</button>

      <Canvas>
        <XR store={store}>
          <LeftController />
        </XR>
      </Canvas>
    </>
  )
}
