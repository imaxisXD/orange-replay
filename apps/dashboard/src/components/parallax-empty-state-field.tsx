import {
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

export interface ParallaxEmptyStateLayer {
  src: string;
  left: string;
  top: string;
  width: string;
  movement: number;
  opacity: number;
  rotation?: number;
}

interface ParallaxEmptyStateFieldProps {
  children: ReactNode;
  className?: string;
  layers: readonly ParallaxEmptyStateLayer[];
}

type LayerStyle = CSSProperties & {
  "--layer-opacity": number;
  "--layer-rotation": string;
  "--parallax-x": string;
  "--parallax-y": string;
};

const POINTER_LIMIT = 1;
const FOLLOW_SPEED = 13;
const STOP_DISTANCE = 0.001;

export function ParallaxEmptyStateField({
  children,
  className,
  layers,
}: ParallaxEmptyStateFieldProps) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const targetPointerRef = useRef({ x: 0, y: 0 });
  const currentPointerRef = useRef({ x: 0, y: 0 });
  const animationFrameRef = useRef<number | null>(null);
  const previousFrameTimeRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    },
    [],
  );

  function paintLayerPositions(x: number, y: number): void {
    const field = fieldRef.current;
    if (field === null) return;

    field.querySelectorAll<HTMLElement>("[data-parallax-movement]").forEach((layer) => {
      const movement = Number(layer.dataset.parallaxMovement ?? 0);
      layer.style.setProperty("--parallax-x", `${x * movement}px`);
      layer.style.setProperty("--parallax-y", `${y * movement * 0.62}px`);
    });
  }

  function followPointer(frameTime: number): void {
    const previousFrameTime = previousFrameTimeRef.current ?? frameTime;
    const elapsedSeconds = Math.min((frameTime - previousFrameTime) / 1_000, 0.05);
    const followAmount = 1 - Math.exp(-FOLLOW_SPEED * elapsedSeconds);
    const currentPointer = currentPointerRef.current;
    const targetPointer = targetPointerRef.current;
    const nextPointer = {
      x: currentPointer.x + (targetPointer.x - currentPointer.x) * followAmount,
      y: currentPointer.y + (targetPointer.y - currentPointer.y) * followAmount,
    };

    currentPointerRef.current = nextPointer;
    previousFrameTimeRef.current = frameTime;
    paintLayerPositions(nextPointer.x, nextPointer.y);

    const remainingDistance =
      Math.abs(targetPointer.x - nextPointer.x) + Math.abs(targetPointer.y - nextPointer.y);
    if (remainingDistance <= STOP_DISTANCE) {
      currentPointerRef.current = targetPointer;
      paintLayerPositions(targetPointer.x, targetPointer.y);
      animationFrameRef.current = null;
      previousFrameTimeRef.current = null;
      fieldRef.current?.removeAttribute("data-moving");
      return;
    }

    animationFrameRef.current = window.requestAnimationFrame(followPointer);
  }

  function startFollowingPointer(): void {
    if (animationFrameRef.current !== null) return;
    fieldRef.current?.setAttribute("data-moving", "true");
    animationFrameRef.current = window.requestAnimationFrame(followPointer);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.pointerType !== "mouse") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;

    targetPointerRef.current = {
      x: clamp(((event.clientX - bounds.left) / bounds.width - 0.5) * 2),
      y: clamp(((event.clientY - bounds.top) / bounds.height - 0.5) * 2),
    };
    startFollowingPointer();
  }

  function handlePointerLeave(): void {
    targetPointerRef.current = { x: 0, y: 0 };
    startFollowingPointer();
  }

  return (
    <div
      className={cn("parallax-empty-state", className)}
      onPointerLeave={handlePointerLeave}
      onPointerMove={handlePointerMove}
      ref={fieldRef}
    >
      <div aria-hidden="true" className="parallax-empty-state__backdrop" />
      <div aria-hidden="true" className="parallax-empty-state__layers">
        {layers.map((layer, index) => {
          const style: LayerStyle = {
            "--layer-opacity": layer.opacity,
            "--layer-rotation": `${layer.rotation ?? 0}deg`,
            "--parallax-x": "0px",
            "--parallax-y": "0px",
            left: layer.left,
            top: layer.top,
            width: layer.width,
          };

          return (
            <img
              alt=""
              className="parallax-empty-state__layer"
              data-parallax-movement={layer.movement}
              decoding="async"
              draggable={false}
              key={`${layer.src}-${index}`}
              src={layer.src}
              style={style}
            />
          );
        })}
      </div>
      <div className="parallax-empty-state__content">{children}</div>
    </div>
  );
}

function clamp(value: number): number {
  return Math.min(POINTER_LIMIT, Math.max(-POINTER_LIMIT, value));
}
