import { useEffect, useRef, RefObject } from "react";

// ---------- Tunables ----------
const NODE_HIT_RADIUS_PX = 36;       // Slop around node center for touch hit-testing
const RADIAL_DRAG_MIN_PX = 80;       // Drag must travel this far radially outward to create child
const LONG_PRESS_DURATION_MS = 600;  // How long the user must hold before long-press fires
const LONG_PRESS_MAX_TRAVEL_PX = 12; // Allow tiny finger jitter without cancelling the long-press

export type ScreenPoint = { x: number; y: number };

export type TouchedTarget =
  | { kind: "node"; id: string; label: string; center: ScreenPoint }
  | { kind: "widget"; id: string; nodeLabel: string; center: ScreenPoint }
  | { kind: "empty" };

export type GestureCallbacks = {
  /**
   * Resolve what (if anything) is under a given screen point at the time of the touch.
   * Coordinates are in client (viewport) pixels.
   */
  hitTest: (point: ScreenPoint) => TouchedTarget;
  /** Whether the consumer is in edit mode (controls which gestures are armed). */
  editMode: boolean;

  /** Long-press on a node (edit mode) — typically opens a delete confirmation. */
  onLongPressNode?: (nodeLabel: string) => void;
  /** Long-press on a widget (edit mode, 3D only) — typically opens a delete confirmation. */
  onLongPressWidget?: (widgetId: string, nodeLabel: string) => void;
  /** Radial drag outward from a node creates a child. */
  onRadialDragFromNode?: (
    nodeLabel: string,
    startCenter: ScreenPoint,
    endPoint: ScreenPoint
  ) => void;
};

type TouchSession = {
  startPoint: ScreenPoint;
  startTarget: TouchedTarget;
  // Radial-drag tracking
  radialAnchor?: ScreenPoint;
  // Long-press timer
  longPressTimer?: number;
  // Did this touch already trigger a destructive/creative gesture?
  consumed: boolean;
};

function dist(a: ScreenPoint, b: ScreenPoint) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/**
 * Attach touch-gesture detection to a DOM element. Pass a stable ref to the surface
 * (or a getter for a surface that may not exist on first render, e.g. R3F canvas).
 */
export function useTouchGestures(
  surface: RefObject<HTMLElement | null> | (() => HTMLElement | null),
  callbacks: GestureCallbacks,
  _opts: { hitRadiusPx?: number } = {}
) {
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  useEffect(() => {
    const el =
      typeof surface === "function" ? surface() : surface.current;
    if (!el) return;

    const sessions = new Map<number, TouchSession>();

    const clearLongPress = (sess: TouchSession) => {
      if (sess.longPressTimer !== undefined) {
        window.clearTimeout(sess.longPressTimer);
        sess.longPressTimer = undefined;
      }
    };

    const ptOf = (e: PointerEvent): ScreenPoint => ({ x: e.clientX, y: e.clientY });

    const onPointerDown = (ev: PointerEvent) => {
      const cb = cbRef.current;
      // Only react to primary mouse button (left). Touch & pen always have button=0.
      if (ev.pointerType === "mouse" && ev.button !== 0) return;

      const point = ptOf(ev);
      const target = cb.hitTest(point);
      const sess: TouchSession = {
        startPoint: point,
        startTarget: target,
        radialAnchor: target.kind === "node" ? target.center : undefined,
        consumed: false,
      };

      // Arm long-press only in edit mode and only on a node/widget.
      if (cb.editMode && (target.kind === "node" || target.kind === "widget")) {
        sess.longPressTimer = window.setTimeout(() => {
          if (sessions.size !== 1) return;
          if (sess.consumed) return;
          sess.consumed = true;
          if (target.kind === "node") {
            cb.onLongPressNode?.(target.label);
          } else if (target.kind === "widget") {
            cb.onLongPressWidget?.(target.id, target.nodeLabel);
          }
        }, LONG_PRESS_DURATION_MS);
      }

      sessions.set(ev.pointerId, sess);

      // If a second pointer arrived, cancel any pending long-presses.
      if (sessions.size > 1) {
        for (const s of sessions.values()) clearLongPress(s);
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      const cb = cbRef.current;
      if (sessions.size !== 1) return;
      const sess = sessions.get(ev.pointerId);
      if (!sess || sess.consumed) return;
      const point = ptOf(ev);

      // Cancel pending long-press if the pointer moves too far.
      if (
        sess.longPressTimer !== undefined &&
        dist(sess.startPoint, point) > LONG_PRESS_MAX_TRAVEL_PX
      ) {
        clearLongPress(sess);
      }

      // Radial drag from a node (edit mode -> create child)
      if (
        cb.editMode &&
        sess.startTarget.kind === "node" &&
        sess.radialAnchor &&
        cb.onRadialDragFromNode
      ) {
        const traveled = dist(sess.radialAnchor, point);
        if (traveled >= RADIAL_DRAG_MIN_PX) {
          const here = cb.hitTest(point);
          if (here.kind !== "node" || here.label === sess.startTarget.label) {
            cb.onRadialDragFromNode(
              sess.startTarget.label,
              sess.radialAnchor,
              point
            );
            sess.consumed = true;
          }
        }
      }
    };

    const onPointerUp = (ev: PointerEvent) => {
      const sess = sessions.get(ev.pointerId);
      if (!sess) return;
      clearLongPress(sess);
      sessions.delete(ev.pointerId);
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("pointerleave", onPointerUp);

    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("pointerleave", onPointerUp);
      for (const s of sessions.values()) clearLongPress(s);
      sessions.clear();
    };
    // We rebind only when the surface ref changes, not on every callback change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface]);
}

export const TouchTunables = {
  NODE_HIT_RADIUS_PX,
  RADIAL_DRAG_MIN_PX,
  LONG_PRESS_DURATION_MS,
};
