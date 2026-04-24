# Almond Axol VR

WebXR teleoperation interface for the Almond Axol robot. Streams hand/elbow pose data from a Meta Quest headset to the Almond Axol SDK over WebSocket.

## Monorepo structure

```
axol-vr/
├── app/                        # Vite + React app (deployed to Vercel)
└── packages/
    └── axol-vr-client/         # Reusable R3F components and hooks
```

## Packages

### `@almond/axol-vr-client`

React components and hooks for connecting to the Almond Axol SDK WebSocket server from inside an XR session.

**Exports**

| Export | Description |
|---|---|
| `AxolVRClient` | R3F component — reads XR input sources each frame and streams pose data over WebSocket |
| `useAxolVRClient` | Hook — manages WebSocket lifecycle (connect, disconnect, auto-retry) |
| `AxolState` | Enum — `Teleop`, `DataCollection`, `Recording` |
| `AxolConnectionStatus` | Enum — `Idle`, `Connecting`, `Open`, `Error`, `Failed` |
| `AxolPoseData` | Type — shape of each frame sent over the WebSocket |

**`AxolVRClient` props**

| Prop | Type | Description |
|---|---|---|
| `wsRef` | `RefObject<WebSocket \| null>` | WebSocket ref from `useAxolVRClient` |
| `onStateChange` | `(state: AxolState) => void` | Fires when the controller state machine transitions |
| `onPendingRecording` | `(pendingAt: number \| null) => void` | Fires with a timestamp when a 3-second recording countdown begins; `null` when cancelled or resolved |
| `onExit` | `() => void` | Fires when the Y button exits the XR session |

**`useAxolVRClient` params**

```ts
useAxolVRClient(hostname: string, port = 8000, maxRetries = 3, retryMs = 1000)
// returns: { status, connect, disconnect, wsRef }
```

**Frame data (`AxolPoseData`)**

Each frame sends a JSON message over the WebSocket:

```ts
{
  l_ee:    { position: { x, y, z }, quaternion: { x, y, z, w } }  // left controller
  r_ee:    { position: { x, y, z }, quaternion: { x, y, z, w } }  // right controller
  l_elbow: { x, y, z }
  r_elbow: { x, y, z }
  l_lock:  boolean   // left trigger fully pressed
  r_lock:  boolean   // right trigger fully pressed
  l_grip:  number    // left grip (0 = fully gripped, 1 = open)
  r_grip:  number    // right grip
  reset:   boolean   // true on the frame X was pressed
  state:   "teleop" | "data_collection" | "recording"
}
```

## Controller bindings

| Button | Action |
|---|---|
| Left **X** | Reset pose; cancels recording countdown; exits Recording → DataCollection |
| Left **Y** | Exit XR session |
| Right **A** | Start recording (3-second countdown); stop recording immediately if already recording; cancels countdown if pressed during it |
| Right **B** | Toggle between Teleop and DataCollection (disabled while recording or countdown) |

## State machine

```
Teleop ──[B]──► DataCollection ──[A]──► (countdown 3s) ──► Recording
   ▲                 ▲                                          │
   └────────[B]──────┘                                   [A or X]
```

During the 3-second countdown the state sent to the server remains `DataCollection`. Once the countdown completes it transitions to `Recording`.

## App

The `app/` package is a Vite + React app that wraps the client library into a full WebXR UI deployed to Vercel.

**Dev**

```bash
npm install
npm run dev --workspace=app
```

Open the printed localhost URL on your Quest browser, enter the hostname of the machine running the Almond Axol SDK, and press **Connect**. Once connected, press **Start** to enter the AR session.

**Build**

```bash
npm run build --workspace=packages/axol-vr-client
npm run build --workspace=app
# output: app/dist/
```

## Deployment

The app is deployed on Vercel. `vercel.json` builds the client package first so it is available as a local workspace dependency:

```json
{
  "buildCommand": "npm run build --workspace=packages/axol-vr-client && npm run build --workspace=app",
  "outputDirectory": "app/dist",
  "installCommand": "rm -f package-lock.json && npm install"
}
```

The `installCommand` removes any macOS-generated lock file to avoid missing Linux rollup binaries on the Vercel build machine.

## Python SDK

The Almond Axol SDK receives these WebSocket frames. The relevant Pydantic models live in `almond_axol/vr/models.py`:

```python
class VRState(str, Enum):
    TELEOP = "teleop"
    DATA_COLLECTION = "data_collection"
    RECORDING = "recording"

class VRPose(BaseModel):
    position: VRPosition       # { x, y, z }
    quaternion: VRQuaternion   # { x, y, z, w }

class VRFrame(BaseModel):
    l_ee: VRPose
    r_ee: VRPose
    l_elbow: VRPosition
    r_elbow: VRPosition
    l_lock: bool
    r_lock: bool
    l_grip: float
    r_grip: float
    reset: bool
    state: VRState
```
