import { useEffect, useRef } from "react";
import { useTheme } from "../hooks/useTheme";

const HEX_RADIUS = 28;
const GLOW_RADIUS = 150;
const BASE_ALPHA = 0.06;
const LERP_SPEED = 0.08;
const PULSE_AMP = 0.015;
const PULSE_SPEED = 0.0008;
const HEX_W = Math.sqrt(3) * HEX_RADIUS;
const HEX_H = 2 * HEX_RADIUS;

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export default function HexGrid() {
  const canvasRef = useRef(null);
  const { theme } = useTheme();
  const stateRef = useRef({
    mouseX: -9999, mouseY: -9999,
    hexes: [],
    baseRgb: [0, 0, 0],
    glowRgb: [0, 0, 0],
    glowIntensity: 0.6,
    scanlines: false,
  });

  useEffect(() => {
    const s = stateRef.current;
    s.baseRgb = hexToRgb(theme.hexBase);
    s.glowRgb = hexToRgb(theme.hexGlow);
    s.glowIntensity = theme.hexGlowIntensity;
    s.scanlines = theme.scanlines;
  }, [theme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const s = stateRef.current;
    let animId;

    function buildGrid(w, h) {
      s.hexes = [];
      const cols = Math.ceil(w / HEX_W) + 2;
      const rows = Math.ceil(h / (HEX_H * 0.75)) + 2;
      for (let row = -1; row < rows; row++) {
        for (let col = -1; col < cols; col++) {
          const offset = (row & 1) ? HEX_W / 2 : 0;
          s.hexes.push({
            cx: col * HEX_W + offset,
            cy: row * HEX_H * 0.75,
            alpha: BASE_ALPHA,
            targetAlpha: BASE_ALPHA,
          });
        }
      }
    }

    function resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildGrid(w, h);
    }

    function drawHex(cx, cy) {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 180) * (60 * i - 30);
        const x = cx + HEX_RADIUS * Math.cos(angle);
        const y = cy + HEX_RADIUS * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
    }

    function drawSquare(cx, cy) {
      const half = HEX_RADIUS * 0.7;
      ctx.beginPath();
      ctx.rect(cx - half, cy - half, half * 2, half * 2);
    }

    function frame(ts) {
      const w = canvas.width / (window.devicePixelRatio || 1);
      const h = canvas.height / (window.devicePixelRatio || 1);
      ctx.clearRect(0, 0, w, h);

      const pulse = Math.sin(ts * PULSE_SPEED) * PULSE_AMP;
      const draw = s.scanlines ? drawSquare : drawHex;

      for (const hex of s.hexes) {
        const dx = hex.cx - s.mouseX;
        const dy = hex.cy - s.mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        hex.targetAlpha = dist < GLOW_RADIUS
          ? BASE_ALPHA + (1 - dist / GLOW_RADIUS) * s.glowIntensity
          : BASE_ALPHA;

        hex.alpha += (hex.targetAlpha - hex.alpha) * LERP_SPEED;
        const a = Math.max(0, Math.min(1, hex.alpha + pulse));
        if (a < 0.005) continue;

        const blend = Math.min(1, (a - BASE_ALPHA) / Math.max(0.01, s.glowIntensity));
        const r = Math.round(s.baseRgb[0] + (s.glowRgb[0] - s.baseRgb[0]) * blend);
        const g = Math.round(s.baseRgb[1] + (s.glowRgb[1] - s.baseRgb[1]) * blend);
        const b = Math.round(s.baseRgb[2] + (s.glowRgb[2] - s.baseRgb[2]) * blend);

        draw(hex.cx, hex.cy);
        ctx.strokeStyle = `rgba(${r},${g},${b},${a})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      animId = requestAnimationFrame(frame);
    }

    function onMove(e) { s.mouseX = e.clientX; s.mouseY = e.clientY; }
    function onLeave() { s.mouseX = -9999; s.mouseY = -9999; }

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMove);
    document.addEventListener("mouseleave", onLeave);
    animId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
    />
  );
}
