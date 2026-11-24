import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  OsEventTypeList,
  StartUpPageCreateResult,
  AudioEvent,
  AudioInputSource,
  AudioSpeakerRole,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import {
  formatHudFrame,
  type HudPayload,
  type FormattedHudFrame,
} from '@pact/shared';

export const G2_CANVAS_WIDTH = 576;
export const G2_CANVAS_HEIGHT = 288;
export const HUD_CONTAINER_ID = 1;
export const HUD_CONTAINER_NAME = 'pact_hud_main';

export const HUD_BRIGHTNESS_DIM = 1;
export const HUD_BRIGHTNESS_FULL = 4;

export interface EvenBridgeCallbacks {
  onSingleTap?: (source: string) => void;
  onDoubleTap?: (source: string) => void;
  onScrollUp?: (source: string) => void;
  onScrollDown?: (source: string) => void;
  onLongPress?: (source: string) => void;
  onLongPressRelease?: (source: string) => void;
  onAudioFrame?: (audioEvent: AudioEvent) => void;
  onFrameRendered?: (frame: FormattedHudFrame) => void;
  onLog?: (message: string) => void;
}

export class PactEvenBridge {
  private bridge: EvenAppBridge | null = null;
  private initialized = false;
  private currentFrame: FormattedHudFrame = formatHudFrame({ state: 'DARK_IDLE' });
  private callbacks: EvenBridgeCallbacks;
  private unsubscribeEvent: (() => void) | null = null;

  constructor(callbacks: EvenBridgeCallbacks = {}) {
    this.callbacks = callbacks;
  }

  private log(msg: string): void {
    console.log(`[PactEvenBridge] ${msg}`);
    this.callbacks.onLog?.(msg);
  }

  public getCurrentFrame(): FormattedHudFrame {
    return this.currentFrame;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Waits for EvenAppBridge readiness, creates the 576x288 startup page container
   * with isEventCapture: 1 on the single primary HUD text container, and subscribes
   * to EvenHub events.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;

    this.log('Waiting for EvenAppBridge...');
    this.bridge = await waitForEvenAppBridge();
    this.log('EvenAppBridge ready.');

    const initialFrame = formatHudFrame({ state: 'DARK_IDLE' });
    this.currentFrame = initialFrame;

    const hudTextContainer = new TextContainerProperty({
      containerID: HUD_CONTAINER_ID,
      containerName: HUD_CONTAINER_NAME,
      xPosition: 16,
      yPosition: 24,
      width: G2_CANVAS_WIDTH - 32,
      height: G2_CANVAS_HEIGHT - 48,
      borderWidth: 0,
      borderColor: 0,
      borderRadius: 0,
      paddingLength: 8,
      isEventCapture: 1,
      zOrderIndex: 1,
      content: initialFrame.text,
      textColor: initialFrame.isDim ? HUD_BRIGHTNESS_DIM : HUD_BRIGHTNESS_FULL,
    });

    const startUpContainer = new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [hudTextContainer],
    });

    try {
      const result = await this.bridge.createStartUpPageContainer(startUpContainer);
      this.log(`createStartUpPageContainer result: ${StartUpPageCreateResult[result] ?? result} (${result})`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`createStartUpPageContainer host note (normal outside simulator): ${errMsg}`);
    }

    this.unsubscribeEvent = this.bridge.onEvenHubEvent((event: EvenHubEvent) => {
      this.handleEvenHubEvent(event);
    });

    this.initialized = true;
    this.callbacks.onFrameRendered?.(this.currentFrame);
  }

  /**
   * Updates the G2 HUD text container in-place without flicker via textContainerUpgrade.
   */
  public async renderHudState(payload: HudPayload): Promise<FormattedHudFrame> {
    const frame = formatHudFrame(payload);
    this.currentFrame = frame;
    this.callbacks.onFrameRendered?.(frame);

    if (!this.bridge) {
      this.log(`HUD state updated locally (${frame.state}) — bridge not yet initialized.`);
      return frame;
    }

    const upgrade = new TextContainerUpgrade({
      containerID: HUD_CONTAINER_ID,
      containerName: HUD_CONTAINER_NAME,
      content: frame.text,
      textColor: frame.isDim ? HUD_BRIGHTNESS_DIM : HUD_BRIGHTNESS_FULL,
    });

    try {
      const ok = await this.bridge.textContainerUpgrade(upgrade);
      this.log(
        `HUD -> ${frame.state} (textContainerUpgrade=${ok}) | Lines: ${JSON.stringify(frame.lines)}`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`HUD -> ${frame.state} (local preview; bridge error: ${errMsg}) | Lines: ${JSON.stringify(frame.lines)}`);
    }

    return frame;
  }

  /**
   * Handles incoming EvenHubEvent payloads from G2 glasses / evenhub-simulator.
   * Crucially normalizes both OsEventTypeList.CLICK_EVENT (0) and undefined to onSingleTap().
   */
  private handleEvenHubEvent(event: EvenHubEvent): void {
    if (event.audioEvent) {
      this.callbacks.onAudioFrame?.(event.audioEvent);
      return;
    }

    if (event.textEvent) {
      const eventType = event.textEvent.eventType;
      this.routeOsEventType(eventType, `textEvent(${event.textEvent.containerName ?? HUD_CONTAINER_NAME})`);
      return;
    }

    if (event.sysEvent) {
      // Ignore continuous IMU report packets when checking tap events
      if (event.sysEvent.imuData || event.sysEvent.eventType === OsEventTypeList.IMU_DATA_REPORT) {
        return;
      }
      this.routeOsEventType(event.sysEvent.eventType, 'sysEvent');
      return;
    }

    if (event.listEvent) {
      this.routeOsEventType(event.listEvent.eventType, 'listEvent');
      return;
    }
  }

  private routeOsEventType(eventType: OsEventTypeList | undefined, source: string): void {
    if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
      this.log(`INPUT: SINGLE_TAP detected via ${source} (eventType=${eventType ?? 'undefined->0'})`);
      this.callbacks.onSingleTap?.(source);
    } else if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      this.log(`INPUT: DOUBLE_TAP detected via ${source} (eventType=${eventType})`);
      this.callbacks.onDoubleTap?.(source);
    } else if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      this.log(`INPUT: SCROLL_UP detected via ${source} (eventType=${eventType})`);
      this.callbacks.onScrollUp?.(source);
    } else if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      this.log(`INPUT: SCROLL_DOWN detected via ${source} (eventType=${eventType})`);
      this.callbacks.onScrollDown?.(source);
    } else if (eventType === OsEventTypeList.LONG_PRESS_EVENT) {
      this.log(`INPUT: LONG_PRESS detected via ${source} (eventType=${eventType})`);
      this.callbacks.onLongPress?.(source);
    } else if (eventType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) {
      this.log(`INPUT: LONG_PRESS_RELEASE detected via ${source} (eventType=${eventType})`);
      this.callbacks.onLongPressRelease?.(source);
    } else {
      this.log(`EVENT: OsEventTypeList=${OsEventTypeList[eventType] ?? eventType} via ${source}`);
    }
  }

  public dispose(): void {
    this.unsubscribeEvent?.();
    this.unsubscribeEvent = null;
  }

  /**
   * Enables or disables microphone capture on G2 glasses / evenhub-simulator (--aid).
   */
  public async setAudioCapture(
    isOpen: boolean,
    source: AudioInputSource = AudioInputSource.Glasses
  ): Promise<boolean> {
    if (!this.bridge) {
      this.log(`audioControl(${isOpen}) skipped — bridge not initialized`);
      return false;
    }
    try {
      const ok = await this.bridge.audioControl(isOpen, source);
      this.log(`audioControl(isOpen=${isOpen}, source=${source}) -> ${ok}`);
      return Boolean(ok);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`audioControl(isOpen=${isOpen}) host notice: ${errMsg}`);
      return false;
    }
  }

  /**
   * Dispatches a verified SDK AudioEvent through the active bridge audio pipeline
   * (used by simulator automation tests when no physical mic hardware is attached).
   */
  public emitAudioEvent(
    pcm: Uint8Array,
    speakerRole: AudioSpeakerRole = AudioSpeakerRole.Self,
    direction: number | null = null,
    source: AudioInputSource = AudioInputSource.Glasses
  ): void {
    const audioEvent = new AudioEvent({
      audioPcm: pcm,
      source,
      direction,
      speakerRole,
    });
    this.handleEvenHubEvent({ audioEvent });
  }
}
