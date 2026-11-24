# Verified Even Hub SDK 0.0.16 Notes (`@evenrealities/even_hub_sdk@0.0.16`)

> Extracted directly from `node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`.

---

## 1. Bridge Initialization (`waitForEvenAppBridge` & `EvenAppBridge`)

```ts
import { waitForEvenAppBridge, EvenAppBridge } from '@evenrealities/even_hub_sdk';

const bridge: EvenAppBridge = await waitForEvenAppBridge();
```

- **Signature:** `declare function waitForEvenAppBridge(): Promise<EvenAppBridge>;`
- **Behavior:** Returns the singleton `EvenAppBridge` once `bridge.ready === true` (listens for `BridgeEvent.BridgeReady = "evenAppBridgeReady"` with a 100 ms fallback check).
- **Critical Rule:** Never call SDK methods before `await waitForEvenAppBridge()` resolves.

---

## 2. Startup Page Layout (`CreateStartUpPageContainer` & `StartUpPageCreateResult`)

```ts
import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  StartUpPageCreateResult,
} from '@evenrealities/even_hub_sdk';
```

- **Method:** `bridge.createStartUpPageContainer(container: CreateStartUpPageContainer): Promise<StartUpPageCreateResult>`
- **`CreateStartUpPageContainer` fields:**
  - `containerTotalNum?: number` (`1..12`, must equal the total count of containers on the page)
  - `listObject?: ListContainerProperty[]`
  - `textObject?: TextContainerProperty[]` (max `8` items)
  - `imageObject?: ImageContainerProperty[]` (max `4` items)
  - `menuObject?: MenuContainerProperty` (optional top-level contextual menu, max 10 items)
  - `widgetId?: number` (auto-injected by bridge)
- **`StartUpPageCreateResult` enum:**
  - `success = 0`
  - `invalid = 1`
  - `oversize = 2`
  - `outOfMemory = 3`

---

## 3. Text Containers & Brightness (`TextContainerProperty` & `textColor`)

```ts
declare class TextContainerProperty {
  xPosition?: number;
  yPosition?: number;
  width?: number;
  height?: number;
  borderWidth?: number;
  borderColor?: number;
  borderRadius?: number;
  paddingLength?: number;
  containerID?: number;
  containerName?: string;
  isEventCapture?: number; // 0 or 1 — EXACTLY ONE container on the page must set 1
  zOrderIndex?: number;
  content?: string;
  textColor?: number;      // 0..4 text brightness; omitted defaults to 4 (full brightness)
  constructor(data?: Partial<TextContainerProperty>);
}
```

- **Verified Brightness Constants & Validator:**
  - `MIN_TEXT_BRIGHTNESS = 0` (fully dim)
  - `MAX_TEXT_BRIGHTNESS = 4` (full brightness, default when omitted)
  - `isValidTextBrightness(value: unknown): value is number`
  - Passing a `textColor` outside `0..4` triggers `EvenHubPageContainerValidationErrorCode.InvalidTextBrightness`.
  - For `DARK_IDLE`, use a dim brightness level (`textColor: 1`), and for active alerts (`CONFLICT`, `PACT_DRAFT`, `SENT_PENDING`, `LOCKED_PULSE`), use full brightness (`textColor: 4`).

---

## 4. Flicker-Free In-Place Updates (`TextContainerUpgrade`)

```ts
declare class TextContainerUpgrade {
  containerID?: number;
  containerName?: string;
  contentOffset?: number;
  contentLength?: number;
  content?: string;
  textColor?: number; // 0..4; omitting preserves current container brightness
  constructor(data?: Partial<TextContainerUpgrade>);
}
```

- **Method:** `bridge.textContainerUpgrade(container: TextContainerUpgrade): Promise<boolean>`
- **Critical Rule:** `containerID` and `containerName` passed to `new TextContainerUpgrade(...)` **MUST match** the startup `TextContainerProperty` (`containerID` and `containerName`) verbatim.

---

## 5. Input Events & Single-Tap Normalization (`OsEventTypeList` & `onEvenHubEvent`)

```ts
declare enum OsEventTypeList {
  CLICK_EVENT = 0,
  SCROLL_TOP_EVENT = 1,
  SCROLL_BOTTOM_EVENT = 2,
  DOUBLE_CLICK_EVENT = 3,
  FOREGROUND_ENTER_EVENT = 4,
  FOREGROUND_EXIT_EVENT = 5,
  ABNORMAL_EXIT_EVENT = 6,
  SYSTEM_EXIT_EVENT = 7,
  IMU_DATA_REPORT = 8,
  LONG_PRESS_EVENT = 9,
  LONG_PRESS_RELEASE_EVENT = 10,
}
```

- **Listener:** `bridge.onEvenHubEvent((event: EvenHubEvent) => void): () => void`
- **`EvenHubEvent` shape:**
  - `listEvent?: List_ItemEvent` (`eventType?: OsEventTypeList`, `containerID?`, `containerName?`, `currentSelectItemName?`, `currentSelectItemIndex?`)
  - `textEvent?: Text_ItemEvent` (`eventType?: OsEventTypeList`, `containerID?`, `containerName?`)
  - `sysEvent?: Sys_ItemEvent` (`eventType?: OsEventTypeList`, `eventSource?: EventSourceType`, `imuData?: IMU_Report_Data`, `systemExitReasonCode?: number`)
  - `audioEvent?: AudioEvent`
  - `menuItemClickEvent?: MenuItemClickEvent`
  - `jsonData?: Record<string, any>`
- **Click Normalization Gotcha:**
  Because `OsEventTypeList.CLICK_EVENT === 0`, protobuf/JSON deserialization in some host/SDK paths normalizes `0` (default proto3 enum value) to `undefined`. Therefore, when `event.textEvent` or `event.sysEvent` is received (without `imuData`), treat **BOTH** `eventType === OsEventTypeList.CLICK_EVENT` **AND** `eventType === undefined` as a single tap (`onSingleTap()`), and `eventType === OsEventTypeList.DOUBLE_CLICK_EVENT` as a double tap (`onDoubleTap()`).

---

## 6. Audio Control & Speaker Role (`audioControl`, `AudioEvent`, `AudioSpeakerRole`, `AudioInputSource`)

```ts
declare enum AudioInputSource {
  Glasses = "glasses",
  Phone = "phone",
}

declare enum AudioSpeakerRole {
  Self = "self",
  Other = "other",
  Unknown = "unknown",
}

declare class AudioEvent {
  audioPcm: Uint8Array;
  source: AudioInputSource;
  direction: number | null;
  speakerRole: AudioSpeakerRole;
}
```

- **Method:** `bridge.audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean>`
- **Stream Payload:** `event.audioEvent` inside `bridge.onEvenHubEvent` delivers:
  - `audioPcm: Uint8Array` — 16,000 Hz, signed 16-bit little-endian mono PCM (`3,200` bytes per 100 ms frame).
  - `speakerRole: AudioSpeakerRole` — `"self" | "other" | "unknown"`.
  - `direction: number | null` — glasses beam direction tag (`null` on phone mic or simulator).
  - `source: AudioInputSource` — `"glasses" | "phone"`.
