/**
 * Claude Cockpit — Animated Hexagonal Grid Background
 * Reactive hex/pixel grid canvas that responds to mouse movement.
 */

(function () {
    /* ── Constants ────────────────────────────────────────────────── */
    const HEX_RADIUS   = 28;
    const GLOW_RADIUS  = 150;           // px around cursor
    const BASE_ALPHA   = 0.06;          // resting hex visibility
    const LERP_SPEED   = 0.08;          // per-frame alpha interpolation
    const PULSE_AMP    = 0.015;         // ambient breathing amplitude
    const PULSE_SPEED  = 0.0008;        // breathing cycle speed (ms)

    /* ── State ───────────────────────────────────────────────────── */
    let canvas, ctx;
    let animId = null;
    let width = 0, height = 0;
    let mouseX = -9999, mouseY = -9999;
    let hexes = [];                     // {cx, cy, alpha, targetAlpha}
    let hexBase  = "#292e42";
    let hexGlow  = "#7aa2f7";
    let glowIntensity = 0.6;
    let destroyed = false;

    /* ── Hex math ────────────────────────────────────────────────── */
    const HEX_W = Math.sqrt(3) * HEX_RADIUS;
    const HEX_H = 2 * HEX_RADIUS;

    function buildGrid() {
        hexes = [];
        const cols = Math.ceil(width / HEX_W) + 2;
        const rows = Math.ceil(height / (HEX_H * 0.75)) + 2;
        for (let row = -1; row < rows; row++) {
            for (let col = -1; col < cols; col++) {
                const offset = (row & 1) ? HEX_W / 2 : 0;
                const cx = col * HEX_W + offset;
                const cy = row * HEX_H * 0.75;
                hexes.push({ cx, cy, alpha: BASE_ALPHA, targetAlpha: BASE_ALPHA });
            }
        }
    }

    /* ── Color helpers ───────────────────────────────────────────── */
    function hexToRgb(hex) {
        const n = parseInt(hex.replace("#", ""), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    let baseRgb = hexToRgb(hexBase);
    let glowRgb = hexToRgb(hexGlow);

    /* ── Drawing ─────────────────────────────────────────────────── */
    function drawHexPath(cx, cy) {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const angle = Math.PI / 180 * (60 * i - 30);
            const x = cx + HEX_RADIUS * Math.cos(angle);
            const y = cy + HEX_RADIUS * Math.sin(angle);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.closePath();
    }

    function drawSquarePath(cx, cy) {
        const half = HEX_RADIUS * 0.7;
        ctx.beginPath();
        ctx.rect(cx - half, cy - half, half * 2, half * 2);
    }

    function isScanlines() {
        return document.body.classList.contains("scanlines");
    }

    /* ── Animation loop ──────────────────────────────────────────── */
    function frame(timestamp) {
        if (destroyed) return;

        ctx.clearRect(0, 0, width, height);

        const pulseOffset = Math.sin(timestamp * PULSE_SPEED) * PULSE_AMP;
        const useSquares = isScanlines();
        const drawShape = useSquares ? drawSquarePath : drawHexPath;

        for (let i = 0; i < hexes.length; i++) {
            const h = hexes[i];

            // Distance from mouse
            const dx = h.cx - mouseX;
            const dy = h.cy - mouseY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < GLOW_RADIUS) {
                const factor = 1 - dist / GLOW_RADIUS;
                h.targetAlpha = BASE_ALPHA + factor * glowIntensity;
            } else {
                h.targetAlpha = BASE_ALPHA;
            }

            // Lerp toward target
            h.alpha += (h.targetAlpha - h.alpha) * LERP_SPEED;

            // Add ambient pulse
            const a = Math.max(0, Math.min(1, h.alpha + pulseOffset));
            if (a < 0.005) continue; // skip invisible hexes

            // Choose color: blend from base to glow based on how bright
            const blend = Math.min(1, (a - BASE_ALPHA) / Math.max(0.01, glowIntensity));
            const r = Math.round(baseRgb[0] + (glowRgb[0] - baseRgb[0]) * blend);
            const g = Math.round(baseRgb[1] + (glowRgb[1] - baseRgb[1]) * blend);
            const b = Math.round(baseRgb[2] + (glowRgb[2] - baseRgb[2]) * blend);

            drawShape(h.cx, h.cy);
            ctx.strokeStyle = `rgba(${r},${g},${b},${a})`;
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        animId = requestAnimationFrame(frame);
    }

    /* ── Event handlers ──────────────────────────────────────────── */
    function onMouseMove(e) {
        mouseX = e.clientX;
        mouseY = e.clientY;
    }

    function onMouseLeave() {
        mouseX = -9999;
        mouseY = -9999;
    }

    function onResize() {
        width = window.innerWidth;
        height = window.innerHeight;
        canvas.width = width * devicePixelRatio;
        canvas.height = height * devicePixelRatio;
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        buildGrid();
    }

    /* ── Public API ──────────────────────────────────────────────── */
    function init(canvasId) {
        canvas = document.getElementById(canvasId);
        if (!canvas) {
            console.warn(`[hexgrid] Canvas #${canvasId} not found`);
            return;
        }
        ctx = canvas.getContext("2d");
        destroyed = false;

        onResize();

        window.addEventListener("resize", onResize);
        window.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseleave", onMouseLeave);

        animId = requestAnimationFrame(frame);
    }

    function updateColors(newBase, newGlow, intensity) {
        hexBase = newBase;
        hexGlow = newGlow;
        glowIntensity = intensity;
        baseRgb = hexToRgb(hexBase);
        glowRgb = hexToRgb(hexGlow);
    }

    function destroy() {
        destroyed = true;
        if (animId != null) {
            cancelAnimationFrame(animId);
            animId = null;
        }
        window.removeEventListener("resize", onResize);
        window.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseleave", onMouseLeave);
    }

    window.HexGrid = { init, updateColors, destroy };
})();
