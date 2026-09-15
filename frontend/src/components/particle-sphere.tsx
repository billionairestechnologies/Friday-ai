import { useEffect, useRef } from "react";
import type { LiveAnalyser } from "@/lib/audio/analyser";

// Evenly spread N points across a sphere — a Fibonacci sphere gives a natural, non-clumped
// particle field without the pole-crowding a naive lat/long grid produces.
function fibonacciSphere(count: number): { x: number; y: number; z: number }[] {
  const points: { x: number; y: number; z: number }[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = golden * i;
    points.push({ x: Math.cos(theta) * radius, y, z: Math.sin(theta) * radius });
  }
  return points;
}

/**
 * A small, self-contained audio-reactive particle sphere, colored per `hue`. Always rotates and
 * stays colorful at rest (not just while `active`) so a row of these reads as distinct little
 * voice identities, not a plain list — jitter and radius growth only kick in with real audio.
 */
export function ParticleSphere({
  analyser,
  active,
  hue = 205,
  pointCount = 900,
}: {
  analyser: LiveAnalyser | null;
  active: boolean;
  /** Color theme (0-360) — distinct per voice so each one visually feels different. */
  hue?: number;
  /** Lower for small/inline spheres (e.g. a voice-picker row) to keep them cheap to animate. */
  pointCount?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef(fibonacciSphere(pointCount));
  const rotationRef = useRef(Math.random() * Math.PI * 2);
  const smoothedLevelRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      if (!canvas) return;
      const size = Math.min(canvas.parentElement?.clientWidth ?? 320, canvas.parentElement?.clientHeight ?? 320);
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
    }
    resize();
    window.addEventListener("resize", resize);

    function frame() {
      if (!canvas || !ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const rawLevel = analyser ? analyser.getLevel() : 0;
      smoothedLevelRef.current += (rawLevel - smoothedLevelRef.current) * 0.25;
      const level = smoothedLevelRef.current;

      const cx = w / 2;
      const cy = h / 2;
      const baseRadius = w * 0.28;
      const radius = baseRadius * (1 + level * 0.55);

      rotationRef.current += 0.0028 + level * 0.01;
      const rot = rotationRef.current;
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);

      const freq = analyser?.getFrequencyData();

      for (let i = 0; i < pointsRef.current.length; i++) {
        const p = pointsRef.current[i]!;
        // rotate around Y axis
        const x = p.x * cosR - p.z * sinR;
        const z = p.x * sinR + p.z * cosR;
        const y = p.y;

        const jitter = freq ? (freq[i % freq.length]! / 255) * 0.18 : 0;
        const r = radius * (1 + jitter);

        const perspective = 1 / (1.7 - z * 0.5);
        const px = cx + x * r * perspective;
        const py = cy + y * r * perspective;
        const size = Math.max(0.6, 1.6 * perspective * dpr) * (1 + level * 0.6);

        const depth = (z + 1) / 2;
        const alpha = 0.22 + depth * 0.55 + level * 0.2;
        const sat = active ? 80 : 45;
        const light = active ? 52 + depth * 15 : 52 + depth * 20;
        ctx.fillStyle = `hsla(${hue}, ${sat}%, ${light}%, ${Math.min(1, alpha)})`;
        ctx.beginPath();
        ctx.arc(px, py, size, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [analyser, active, hue]);

  return (
    <div className="flex size-full items-center justify-center">
      <canvas ref={canvasRef} />
    </div>
  );
}
