import * as THREE from 'three';
import { SOLUTIONS, WORLD_CLUES } from '../shared/puzzles.js';
import type { CipherSymbol, HarpColor } from '../shared/types.js';

// ============================================================
// Procedural canvas textures for Solstice Manor.
// Tiling textures assume geometry UVs are expressed in METERS;
// `texture.repeat` converts metres into tiles.
// ============================================================

type Ctx = CanvasRenderingContext2D;

const SERIF = 'Georgia, "Times New Roman", serif';

export const HARP_HEX: Record<HarpColor, string> = {
  azure: '#2fa8ff',
  amber: '#ffb52e',
  violet: '#a75bff',
  emerald: '#2fd67a',
};

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w: number, h: number): { c: HTMLCanvasElement; g: Ctx } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas is unavailable');
  return { c, g };
}

function toTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Tiling texture: `meters` is the world size of one tile. */
function tiled(c: HTMLCanvasElement, meters: number, srgb = true, mirrored = false): THREE.CanvasTexture {
  const t = toTexture(c, srgb);
  t.wrapS = t.wrapT = mirrored ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
  t.repeat.set(1 / meters, 1 / meters);
  return t;
}

function hsl(h: number, s: number, l: number, a = 1): string {
  return `hsla(${h}, ${s}%, ${l}%, ${a})`;
}

function rounded(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Draws `fn` with wrap-around so strokes crossing tile edges stay seamless. */
function wrapped(g: Ctx, size: number, x: number, y: number, pad: number, fn: (x: number, y: number) => void): void {
  for (const ox of [-size, 0, size]) {
    for (const oy of [-size, 0, size]) {
      const px = x + ox;
      const py = y + oy;
      if (px > -pad && px < size + pad && py > -pad && py < size + pad) fn(px, py);
    }
  }
  g.globalAlpha = 1;
}

function wrapText(g: Ctx, text: string, maxW: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (g.measureText(test).width > maxW && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  return lines;
}

function parchment(g: Ctx, w: number, h: number, seed: number, base = '#f3e4c1'): void {
  const r = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 500; i++) {
    g.fillStyle = `rgba(${150 + r() * 60}, ${110 + r() * 50}, ${50 + r() * 40}, ${0.02 + r() * 0.04})`;
    g.beginPath();
    g.ellipse(r() * w, r() * h, 3 + r() * 34, 2 + r() * 20, r() * 3, 0, 7);
    g.fill();
  }
  const v = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.72);
  v.addColorStop(0, 'rgba(120,72,20,0)');
  v.addColorStop(1, 'rgba(120,72,20,0.32)');
  g.fillStyle = v;
  g.fillRect(0, 0, w, h);
}

function ornateBorder(g: Ctx, w: number, h: number, color: string, inset = 22): void {
  g.strokeStyle = color;
  g.lineWidth = 5;
  g.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
  g.lineWidth = 2;
  g.strokeRect(inset + 10, inset + 10, w - inset * 2 - 20, h - inset * 2 - 20);
  for (const [x, y] of [
    [inset + 5, inset + 5],
    [w - inset - 5, inset + 5],
    [inset + 5, h - inset - 5],
    [w - inset - 5, h - inset - 5],
  ]) {
    g.beginPath();
    g.fillStyle = color;
    g.arc(x, y, 12, 0, 7);
    g.fill();
  }
}

// ------------------------------------------------------------
// Vector emblems (never depends on the OS emoji font)
// ------------------------------------------------------------
export function drawSymbol(g: Ctx, s: CipherSymbol, x: number, y: number, r: number, color?: string): void {
  g.save();
  g.translate(x, y);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const tint = (d: string): string => color ?? d;
  switch (s) {
    case 'sun': {
      g.fillStyle = tint('#e79a12');
      for (let i = 0; i < 12; i++) {
        g.save();
        g.rotate((i / 12) * Math.PI * 2);
        g.beginPath();
        g.moveTo(-r * 0.13, -r * 0.6);
        g.lineTo(0, -r);
        g.lineTo(r * 0.13, -r * 0.6);
        g.fill();
        g.restore();
      }
      g.beginPath();
      g.arc(0, 0, r * 0.52, 0, 7);
      g.fill();
      break;
    }
    case 'leaf': {
      g.fillStyle = tint('#3f8f3a');
      g.rotate(0.6);
      g.beginPath();
      g.moveTo(0, -r);
      g.bezierCurveTo(r * 0.85, -r * 0.5, r * 0.6, r * 0.45, 0, r * 0.7);
      g.bezierCurveTo(-r * 0.6, r * 0.45, -r * 0.85, -r * 0.5, 0, -r);
      g.fill();
      g.strokeStyle = tint('#24612a');
      g.lineWidth = r * 0.08;
      g.beginPath();
      g.moveTo(0, r);
      g.lineTo(0, r * 0.7);
      g.stroke();
      g.strokeStyle = 'rgba(255,255,240,0.75)';
      g.beginPath();
      g.moveTo(0, r * 0.6);
      g.lineTo(0, -r * 0.7);
      for (let i = -1; i < 2; i++) {
        g.moveTo(0, r * (0.3 + i * 0.32));
        g.lineTo(r * 0.3, r * (0.08 + i * 0.32));
        g.moveTo(0, r * (0.3 + i * 0.32));
        g.lineTo(-r * 0.3, r * (0.08 + i * 0.32));
      }
      g.stroke();
      break;
    }
    case 'gear': {
      g.fillStyle = tint('#8a6a3c');
      g.beginPath();
      const n = 10;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const w = Math.PI / n;
        for (const [da, rr] of [
          [-w * 0.95, 0.72],
          [-w * 0.5, 0.98],
          [w * 0.5, 0.98],
          [w * 0.95, 0.72],
        ]) {
          g.lineTo(Math.cos(a + da) * r * rr, Math.sin(a + da) * r * rr);
        }
      }
      g.closePath();
      g.moveTo(r * 0.32, 0);
      g.arc(0, 0, r * 0.32, 0, Math.PI * 2, true);
      g.fill('evenodd');
      break;
    }
    case 'moon': {
      g.fillStyle = tint('#5a6fb0');
      g.beginPath();
      g.arc(0, 0, r * 0.92, Math.PI * 0.3, Math.PI * 1.7, false);
      g.bezierCurveTo(-r * 0.25, -r * 0.55, -r * 0.25, r * 0.55, r * 0.54, r * 0.744);
      g.fill();
      break;
    }
    case 'bell': {
      g.fillStyle = tint('#c98a18');
      g.beginPath();
      g.moveTo(-r * 0.85, r * 0.55);
      g.bezierCurveTo(-r * 0.5, r * 0.25, -r * 0.6, -r * 0.8, 0, -r * 0.8);
      g.bezierCurveTo(r * 0.6, -r * 0.8, r * 0.5, r * 0.25, r * 0.85, r * 0.55);
      g.closePath();
      g.fill();
      g.beginPath();
      g.arc(0, r * 0.72, r * 0.2, 0, 7);
      g.arc(0, -r * 0.86, r * 0.13, 0, 7);
      g.fill();
      break;
    }
    case 'drop': {
      g.fillStyle = tint('#2d8fc4');
      g.beginPath();
      g.moveTo(0, -r);
      g.bezierCurveTo(r * 0.3, -r * 0.4, r * 0.7, 0, r * 0.62, r * 0.4);
      g.arc(0, r * 0.36, r * 0.62, 0.06, Math.PI - 0.06);
      g.bezierCurveTo(-r * 0.7, 0, -r * 0.3, -r * 0.4, 0, -r);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.lineWidth = r * 0.09;
      g.beginPath();
      g.arc(0, r * 0.36, r * 0.38, Math.PI * 0.6, Math.PI * 0.95);
      g.stroke();
      break;
    }
    case 'star': {
      g.fillStyle = tint('#c4406a');
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 ? r * 0.42 : r;
        g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
      break;
    }
    case 'key': {
      g.strokeStyle = g.fillStyle = tint('#8c5a1e');
      g.lineWidth = r * 0.2;
      g.rotate(-0.6);
      g.beginPath();
      g.arc(-r * 0.55, 0, r * 0.32, 0, 7);
      g.moveTo(-r * 0.22, 0);
      g.lineTo(r * 0.95, 0);
      g.moveTo(r * 0.85, 0);
      g.lineTo(r * 0.85, r * 0.4);
      g.moveTo(r * 0.5, 0);
      g.lineTo(r * 0.5, r * 0.32);
      g.stroke();
      break;
    }
    case 'feather': {
      g.rotate(0.7);
      g.fillStyle = tint('#4f9aa0');
      g.beginPath();
      g.moveTo(0, -r);
      g.bezierCurveTo(r * 0.6, -r * 0.6, r * 0.45, r * 0.3, 0, r * 0.6);
      g.bezierCurveTo(-r * 0.45, r * 0.3, -r * 0.6, -r * 0.6, 0, -r);
      g.fill();
      g.strokeStyle = tint('#2a5f66');
      g.lineWidth = r * 0.07;
      g.beginPath();
      g.moveTo(0, r);
      g.lineTo(0, -r * 0.75);
      g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.6)';
      g.lineWidth = r * 0.05;
      for (let i = 0; i < 5; i++) {
        g.beginPath();
        g.moveTo(0, r * (0.4 - i * 0.24));
        g.lineTo(r * 0.36, r * (0.12 - i * 0.24));
        g.moveTo(0, r * (0.4 - i * 0.24));
        g.lineTo(-r * 0.36, r * (0.12 - i * 0.24));
        g.stroke();
      }
      break;
    }
  }
  g.restore();
}

// ------------------------------------------------------------
// Tiling surface textures
// ------------------------------------------------------------
function parquet(): HTMLCanvasElement {
  const { c, g } = canvas(1024, 1024);
  const r = rng(11);
  const cell = 256;
  for (let cy = 0; cy < 4; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      const horiz = (cx + cy) % 2 === 0;
      for (let i = 0; i < 4; i++) {
        const w = cell / 4;
        const x = cx * cell + (horiz ? 0 : i * w);
        const y = cy * cell + (horiz ? i * w : 0);
        const pw = horiz ? cell : w;
        const ph = horiz ? w : cell;
        const l = 44 + r() * 11;
        g.fillStyle = hsl(27 + r() * 7, 50 + r() * 10, l);
        g.fillRect(x, y, pw, ph);
        for (let k = 0; k < 16; k++) {
          g.strokeStyle = hsl(22, 50, l - 8 - r() * 12, 0.12 + r() * 0.2);
          g.lineWidth = 0.6 + r() * 1.6;
          g.beginPath();
          if (horiz) {
            const yy = y + r() * ph;
            g.moveTo(x, yy);
            g.bezierCurveTo(x + pw * 0.3, yy + r() * 5 - 2, x + pw * 0.6, yy + r() * 5 - 2, x + pw, yy);
          } else {
            const xx = x + r() * pw;
            g.moveTo(xx, y);
            g.bezierCurveTo(xx + r() * 5 - 2, y + ph * 0.3, xx + r() * 5 - 2, y + ph * 0.6, xx, y + ph);
          }
          g.stroke();
        }
        g.strokeStyle = 'rgba(62,30,10,0.6)';
        g.lineWidth = 2;
        g.strokeRect(x, y, pw, ph);
        g.fillStyle = 'rgba(255,220,160,0.16)';
        g.fillRect(x + 1, y + 1, pw - 2, 2);
      }
    }
  }
  return c;
}

function flagstone(): { color: HTMLCanvasElement; bump: HTMLCanvasElement } {
  const { c, g } = canvas(1024, 1024);
  const { c: b, g: bg } = canvas(512, 512);
  const r = rng(23);
  g.fillStyle = '#a08f6c';
  g.fillRect(0, 0, 1024, 1024);
  bg.fillStyle = '#333';
  bg.fillRect(0, 0, 512, 512);
  const rows = [160, 210, 140, 190, 170, 154];
  let y = 0;
  for (const h of rows) {
    const n = 4 + Math.floor(r() * 2);
    const cuts = Array.from({ length: n }, () => 0.65 + r() * 0.7);
    const sum = cuts.reduce((a, v) => a + v, 0);
    let x = Math.floor(r() * 200);
    for (const k of cuts) {
      const w = (k / sum) * 1024;
      const l = 64 + r() * 12;
      const hue = 32 + r() * 10;
      const sat = 30 + r() * 16;
      for (const ox of [0, -1024]) {
        g.fillStyle = hsl(hue, sat, l);
        rounded(g, x + ox + 5, y + 5, w - 10, h - 10, 12);
        g.fill();
        g.strokeStyle = hsl(hue, sat, l + 9, 0.7);
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(x + ox + 14, y + 7);
        g.lineTo(x + ox + w - 14, y + 7);
        g.stroke();
        g.strokeStyle = hsl(hue, sat, l - 22, 0.5);
        g.beginPath();
        g.moveTo(x + ox + 14, y + h - 7);
        g.lineTo(x + ox + w - 14, y + h - 7);
        g.stroke();
        const v = Math.floor(170 + (l - 69) * 6);
        bg.fillStyle = `rgb(${v},${v},${v})`;
        rounded(bg, (x + ox + 6) / 2, (y + 6) / 2, (w - 12) / 2, (h - 12) / 2, 7);
        bg.fill();
      }
      x += w;
    }
    y += h;
  }
  for (let i = 0; i < 2600; i++) {
    const a = r();
    g.fillStyle = a > 0.5 ? `rgba(255,248,225,${r() * 0.12})` : `rgba(80,62,36,${r() * 0.12})`;
    g.beginPath();
    g.ellipse(r() * 1024, r() * 1024, 1 + r() * 5, 1 + r() * 3, r() * 3, 0, 7);
    g.fill();
  }
  // Moss creeping between a few joints
  for (let i = 0; i < 240; i++) {
    g.fillStyle = `rgba(106,140,62,${0.08 + r() * 0.16})`;
    g.beginPath();
    g.arc(r() * 1024, (Math.floor(r() * 6) + 0.02) * 171 + r() * 8, 2 + r() * 7, 0, 7);
    g.fill();
  }
  return { color: c, bump: b };
}

function grass(): HTMLCanvasElement {
  const { c, g } = canvas(512, 512);
  const r = rng(31);
  g.fillStyle = '#5f9a3c';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 90; i++) {
    const x = r() * 512;
    const y = r() * 512;
    const rad = 20 + r() * 50;
    const col = r() > 0.5 ? '130,180,70' : '50,120,52';
    wrapped(g, 512, x, y, rad, (px, py) => {
      const q = g.createRadialGradient(px, py, 0, px, py, rad);
      q.addColorStop(0, `rgba(${col},0.22)`);
      q.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = q;
      g.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    });
  }
  for (let i = 0; i < 4600; i++) {
    const x = r() * 512;
    const y = r() * 512;
    const len = 5 + r() * 11;
    const a = -Math.PI / 2 + (r() - 0.5) * 1.6;
    g.strokeStyle = hsl(80 + r() * 45, 42 + r() * 22, 28 + r() * 28, 0.5);
    g.lineWidth = 0.8 + r();
    wrapped(g, 512, x, y, 18, (px, py) => {
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len);
      g.stroke();
    });
  }
  for (let i = 0; i < 46; i++) {
    g.fillStyle = ['#fff6d8', '#ffe07a', '#f4b7cf'][Math.floor(r() * 3)];
    g.beginPath();
    g.arc(6 + r() * 500, 6 + r() * 500, 1.5 + r() * 1.6, 0, 7);
    g.fill();
  }
  return c;
}

function damask(): HTMLCanvasElement {
  const S = 512;
  const { c, g } = canvas(S, S);
  g.fillStyle = '#f5e8cb';
  g.fillRect(0, 0, S, S);
  for (let x = 0; x < S; x += 4) {
    g.fillStyle = x % 8 ? 'rgba(255,255,255,0.10)' : 'rgba(190,150,80,0.07)';
    g.fillRect(x, 0, 2, S);
  }
  const gold = 'rgba(199,151,62,0.62)';
  const motif = (mx: number, my: number, s: number): void => {
    g.save();
    g.translate(mx, my);
    g.scale(s, s);
    g.fillStyle = gold;
    g.strokeStyle = gold;
    g.lineWidth = 4;
    for (const f of [1, -1]) {
      g.save();
      g.scale(f, 1);
      g.beginPath();
      g.moveTo(0, -100);
      g.bezierCurveTo(34, -70, 40, -38, 10, -8);
      g.bezierCurveTo(60, -52, 86, -14, 60, 18);
      g.bezierCurveTo(90, 8, 92, 60, 48, 56);
      g.bezierCurveTo(30, 52, 22, 36, 14, 20);
      g.bezierCurveTo(20, 60, 22, 84, 0, 108);
      g.closePath();
      g.fill();
      g.beginPath();
      g.arc(74, -66, 18, Math.PI * 0.9, Math.PI * 2.5);
      g.stroke();
      g.beginPath();
      g.arc(52, 92, 20, Math.PI * 1.1, Math.PI * 2.6);
      g.stroke();
      g.restore();
    }
    g.fillStyle = 'rgba(245,232,203,0.95)';
    g.beginPath();
    g.ellipse(0, -22, 8, 30, 0, 0, 7);
    g.fill();
    g.beginPath();
    g.ellipse(0, 56, 5, 22, 0, 0, 7);
    g.fill();
    g.restore();
  };
  for (const [x, y] of [
    [128, 128],
    [384, 384],
    [128, 640],
    [128, -384],
    [384, -128],
    [640, 384],
    [-128, 384],
  ]) {
    motif(x, y, 1.05);
  }
  g.fillStyle = 'rgba(199,151,62,0.5)';
  for (const [x, y] of [
    [384, 128],
    [128, 384],
  ]) {
    g.beginPath();
    g.moveTo(x, y - 22);
    g.lineTo(x + 14, y);
    g.lineTo(x, y + 22);
    g.lineTo(x - 14, y);
    g.fill();
  }
  return c;
}

function brick(): { color: HTMLCanvasElement; bump: HTMLCanvasElement } {
  const { c, g } = canvas(1024, 1024);
  const { c: b, g: bg } = canvas(512, 512);
  const r = rng(41);
  g.fillStyle = '#cdb694';
  g.fillRect(0, 0, 1024, 1024);
  bg.fillStyle = '#222';
  bg.fillRect(0, 0, 512, 512);
  const rows = 14;
  const cols = 5;
  const bh = 1024 / rows;
  const bw = 1024 / cols;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const px = x * bw + (y % 2 ? bw / 2 : 0);
      const l = 44 + r() * 14;
      const h = 13 + r() * 10;
      for (const ox of [0, -1024]) {
        g.fillStyle = hsl(h, 44 + r() * 8, l);
        rounded(g, px + ox + 4, y * bh + 4, bw - 8, bh - 8, 5);
        g.fill();
        g.fillStyle = 'rgba(255,220,180,0.17)';
        g.fillRect(px + ox + 8, y * bh + 5, bw - 16, 4);
        g.fillStyle = 'rgba(60,20,8,0.22)';
        g.fillRect(px + ox + 8, y * bh + bh - 10, bw - 16, 5);
        const v = 160 + Math.floor((l - 44) * 5);
        bg.fillStyle = `rgb(${v},${v},${v})`;
        bg.fillRect((px + ox + 5) / 2, (y * bh + 5) / 2, (bw - 10) / 2, (bh - 10) / 2);
      }
    }
  }
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = r() > 0.5 ? `rgba(255,230,200,${r() * 0.14})` : `rgba(70,25,10,${r() * 0.16})`;
    g.fillRect(r() * 1024, r() * 1024, 1 + r() * 4, 1 + r() * 3);
  }
  return { color: c, bump: b };
}

function ashlar(): HTMLCanvasElement {
  // Honey limestone block wall used on all exterior faces
  const { c, g } = canvas(512, 512);
  const r = rng(47);
  g.fillStyle = '#c9b68f';
  g.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 2; x++) {
      const px = x * 256 + (y % 2 ? 128 : 0);
      const l = 73 + r() * 8;
      const hue = 36 + r() * 5;
      for (const ox of [0, -512]) {
        g.fillStyle = hsl(hue, 48, l);
        rounded(g, px + ox + 2, y * 128 + 2, 252, 124, 5);
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.25)';
        g.fillRect(px + ox + 6, y * 128 + 3, 244, 3);
        g.fillStyle = 'rgba(110,84,40,0.2)';
        g.fillRect(px + ox + 6, y * 128 + 122, 244, 4);
      }
    }
  }
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = r() > 0.5 ? `rgba(255,250,230,${r() * 0.14})` : `rgba(120,90,45,${r() * 0.1})`;
    g.beginPath();
    g.arc(r() * 512, r() * 512, 0.6 + r() * 2.6, 0, 7);
    g.fill();
  }
  return c;
}

function brushedBrass(): HTMLCanvasElement {
  const { c, g } = canvas(256, 256);
  const r = rng(53);
  g.fillStyle = '#e0b055';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = r() > 0.5 ? `rgba(255,236,175,${r() * 0.07})` : `rgba(130,84,26,${r() * 0.06})`;
    g.fillRect(0, r() * 256, 256, 0.5 + r() * 1.4);
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(90,110,70,${r() * 0.06})`;
    g.beginPath();
    g.arc(r() * 256, r() * 256, r() * 14, 0, 7);
    g.fill();
  }
  return c;
}

function walnut(): HTMLCanvasElement {
  const { c, g } = canvas(512, 512);
  const r = rng(61);
  g.fillStyle = '#6d4226';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 260; i++) {
    const x = r() * 512;
    const f = 1 + Math.floor(r() * 2);
    const amp = 2 + r() * 8;
    const ph = r() * 6.28;
    g.strokeStyle = r() > 0.45 ? `rgba(48,24,10,${0.06 + r() * 0.2})` : `rgba(160,100,58,${0.05 + r() * 0.16})`;
    g.lineWidth = 0.7 + r() * 3;
    g.beginPath();
    for (let y = 0; y <= 512; y += 16) {
      const xx = x + Math.sin((y / 512) * Math.PI * 2 * f + ph) * amp;
      if (y === 0) g.moveTo(xx, y);
      else g.lineTo(xx, y);
    }
    g.stroke();
  }
  return c;
}

function marble(): HTMLCanvasElement {
  const { c, g } = canvas(512, 512);
  const r = rng(67);
  g.fillStyle = '#f3ede2';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 70; i++) {
    const x = r() * 512;
    const y = r() * 512;
    const rad = 40 + r() * 90;
    const q = g.createRadialGradient(x, y, 0, x, y, rad);
    q.addColorStop(0, `rgba(206,196,182,${0.06 + r() * 0.1})`);
    q.addColorStop(1, 'rgba(206,196,182,0)');
    g.fillStyle = q;
    g.fillRect(0, 0, 512, 512);
  }
  for (let i = 0; i < 26; i++) {
    let x = r() * 512;
    let y = r() * 512;
    let a = r() * 6.28;
    g.strokeStyle = r() > 0.6 ? `rgba(196,152,84,${0.16 + r() * 0.24})` : `rgba(140,132,124,${0.12 + r() * 0.24})`;
    g.lineWidth = 0.5 + r() * 1.8;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 26; k++) {
      a += (r() - 0.5) * 0.7;
      x += Math.cos(a) * 16;
      y += Math.sin(a) * 16;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  return c;
}

function glassIron(): HTMLCanvasElement {
  const { c, g } = canvas(512, 512);
  g.clearRect(0, 0, 512, 512);
  g.fillStyle = 'rgba(200,236,226,0.13)';
  g.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 4; x++) {
      const px = x * 128;
      const py = y * 256;
      const q = g.createLinearGradient(px, py, px + 128, py + 256);
      q.addColorStop(0, 'rgba(255,250,230,0.16)');
      q.addColorStop(0.45, 'rgba(255,255,255,0.03)');
      q.addColorStop(0.55, 'rgba(255,255,255,0.14)');
      q.addColorStop(0.62, 'rgba(255,255,255,0.02)');
      q.addColorStop(1, 'rgba(190,240,215,0.11)');
      g.fillStyle = q;
      g.fillRect(px, py, 128, 256);
    }
  }
  g.fillStyle = '#3d5a4e';
  for (let x = 0; x < 4; x++) {
    g.fillRect(x * 128 - 4, 0, 8, 512);
    if (x === 0) g.fillRect(508, 0, 4, 512);
  }
  for (let y = 0; y < 2; y++) {
    g.fillRect(0, y * 256 - 5, 512, 10);
    if (y === 0) g.fillRect(0, 507, 512, 5);
  }
  g.fillStyle = '#c79a45';
  for (let y = 0; y <= 2; y++) {
    for (let x = 0; x <= 4; x++) {
      g.beginPath();
      g.arc(x * 128, y * 256, 8, 0, 7);
      g.fill();
    }
  }
  return c;
}

function starDome(): HTMLCanvasElement {
  const { c, g } = canvas(1024, 512);
  const r = rng(71);
  const q = g.createLinearGradient(0, 0, 0, 512);
  q.addColorStop(0, '#1a2f7c');
  q.addColorStop(0.6, '#274aa6');
  q.addColorStop(1, '#3f74c8');
  g.fillStyle = q;
  g.fillRect(0, 0, 1024, 512);
  for (let i = 0; i < 60; i++) {
    const x = r() * 1024;
    const y = 180 + Math.sin(x / 163) * 60 + (r() - 0.5) * 120;
    const rad = 30 + r() * 70;
    const n = g.createRadialGradient(x, y, 0, x, y, rad);
    n.addColorStop(0, 'rgba(150,170,255,0.14)');
    n.addColorStop(1, 'rgba(150,170,255,0)');
    g.fillStyle = n;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  const pts: [number, number][] = [];
  for (let i = 0; i < 520; i++) {
    const x = r() * 1024;
    const y = r() * 512;
    const s = r() < 0.08 ? 2.5 + r() * 2 : 0.6 + r() * 1.2;
    if (s > 2.5) pts.push([x, y]);
    g.fillStyle = r() > 0.3 ? '#fff3cf' : '#bcd6ff';
    g.beginPath();
    g.arc(x, y, s, 0, 7);
    g.fill();
  }
  g.strokeStyle = 'rgba(255,214,120,0.55)';
  g.lineWidth = 1.6;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const near = pts
      .filter((p) => p !== pts[i])
      .sort((p, o) => Math.hypot(p[0] - ax, p[1] - ay) - Math.hypot(o[0] - ax, o[1] - ay))[0];
    if (near && Math.hypot(near[0] - ax, near[1] - ay) < 170) {
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(near[0], near[1]);
      g.stroke();
    }
  }
  g.strokeStyle = 'rgba(255,205,105,0.8)';
  g.lineWidth = 4;
  for (let i = 0; i <= 8; i++) {
    g.beginPath();
    g.moveTo((i * 1024) / 8, 0);
    g.lineTo((i * 1024) / 8, 512);
    g.stroke();
  }
  return c;
}

function hedgeLeaves(): HTMLCanvasElement {
  const { c, g } = canvas(512, 512);
  const r = rng(79);
  g.fillStyle = '#2f5f2c';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 1900; i++) {
    const x = r() * 512;
    const y = r() * 512;
    const a = r() * 6.28;
    const s = 5 + r() * 10;
    const col = hsl(85 + r() * 40, 38 + r() * 22, 24 + (i / 1900) * 22 + r() * 10);
    wrapped(g, 512, x, y, 18, (px, py) => {
      g.save();
      g.translate(px, py);
      g.rotate(a);
      g.fillStyle = col;
      g.beginPath();
      g.ellipse(0, 0, s, s * 0.45, 0, 0, 7);
      g.fill();
      g.strokeStyle = 'rgba(255,255,200,0.13)';
      g.beginPath();
      g.moveTo(-s, 0);
      g.lineTo(s, 0);
      g.stroke();
      g.restore();
    });
  }
  return c;
}

function roofTiles(): HTMLCanvasElement {
  const { c, g } = canvas(512, 512);
  const r = rng(83);
  g.fillStyle = '#3d7d74';
  g.fillRect(0, 0, 512, 512);
  for (let y = 7; y >= 0; y--) {
    for (let x = -1; x < 9; x++) {
      const px = x * 64 + (y % 2 ? 32 : 0);
      const key = (x + 8) % 8;
      const l = 40 + (((key * 37 + y * 53) % 17) / 17) * 14;
      g.fillStyle = hsl(168 + (key % 3) * 4, 34, l);
      g.beginPath();
      g.moveTo(px, y * 64);
      g.lineTo(px + 64, y * 64);
      g.lineTo(px + 64, y * 64 + 40);
      g.arc(px + 32, y * 64 + 40, 31, 0, Math.PI);
      g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(16,44,40,0.5)';
      g.lineWidth = 3;
      g.stroke();
    }
  }
  for (let i = 0; i < 200; i++) {
    g.fillStyle = `rgba(230,190,120,${r() * 0.1})`;
    g.fillRect(r() * 512, r() * 512, 3 + r() * 12, 2);
  }
  return c;
}

function plaster(): HTMLCanvasElement {
  const { c, g } = canvas(256, 256);
  const r = rng(89);
  g.fillStyle = '#fbf2de';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = r() > 0.5 ? 'rgba(255,255,255,0.12)' : 'rgba(180,150,100,0.05)';
    g.beginPath();
    g.arc(r() * 256, r() * 256, 1 + r() * 6, 0, 7);
    g.fill();
  }
  return c;
}

function books(): HTMLCanvasElement {
  const { c, g } = canvas(1024, 512);
  const r = rng(97);
  g.fillStyle = '#2a170c';
  g.fillRect(0, 0, 1024, 512);
  for (let row = 0; row < 2; row++) {
    const base = row * 256 + 250;
    let x = 4;
    while (x < 1016) {
      const w = 16 + r() * 26;
      const h = 160 + r() * 70;
      if (r() < 0.06) {
        x += 18;
        continue;
      }
      const hue = [8, 28, 44, 150, 200, 340, 18][Math.floor(r() * 7)];
      const l = 28 + r() * 20;
      const q = g.createLinearGradient(x, 0, x + w, 0);
      q.addColorStop(0, hsl(hue, 46, l - 9));
      q.addColorStop(0.4, hsl(hue, 46, l + 7));
      q.addColorStop(1, hsl(hue, 46, l - 12));
      g.fillStyle = q;
      g.fillRect(x, base - h, w - 1.5, h);
      g.fillStyle = 'rgba(236,196,100,0.85)';
      g.fillRect(x + 1, base - h + 18, w - 4, 3);
      g.fillRect(x + 1, base - 28, w - 4, 3);
      if (r() > 0.4) g.fillRect(x + w * 0.3, base - h * 0.66, w * 0.4, h * 0.26);
      x += w;
    }
  }
  return c;
}

function rug(): HTMLCanvasElement {
  const S = 1024;
  const { c, g } = canvas(S, S);
  g.clearRect(0, 0, S, S);
  g.translate(S / 2, S / 2);
  const ring = (rad: number, col: string): void => {
    g.fillStyle = col;
    g.beginPath();
    g.arc(0, 0, rad, 0, 7);
    g.fill();
  };
  ring(508, '#c99b45');
  ring(492, '#8c2f2a');
  ring(400, '#e9cf95');
  ring(388, '#1f5d5a');
  ring(302, '#e9cf95');
  ring(292, '#5c1719');
  for (let i = 0; i < 32; i++) {
    g.save();
    g.rotate((i / 32) * Math.PI * 2);
    // Border stays cream & teal: gold is reserved for the nine countable sun rays
    g.fillStyle = i % 2 ? '#f1e6cc' : '#2f6d68';
    g.beginPath();
    g.moveTo(0, -478);
    g.lineTo(22, -446);
    g.lineTo(0, -414);
    g.lineTo(-22, -446);
    g.fill();
    g.restore();
  }
  for (let i = 0; i < 16; i++) {
    g.save();
    g.rotate((i / 16) * Math.PI * 2);
    g.fillStyle = '#cfe0cc';
    g.beginPath();
    g.ellipse(0, -344, 16, 34, 0, 0, 7);
    g.fill();
    g.fillStyle = '#3f8377';
    g.beginPath();
    g.ellipse(0, -344, 7, 20, 0, 0, 7);
    g.fill();
    g.restore();
  }
  for (let i = 0; i < 9000; i++) {
    const a = Math.random() * 6.28;
    const d = Math.sqrt(Math.random()) * 500;
    g.fillStyle = `rgba(${Math.random() > 0.5 ? '255,240,210' : '30,10,5'},0.07)`;
    g.fillRect(Math.cos(a) * d, Math.sin(a) * d, 3, 2);
  }
  // Central sun medallion: EXACTLY nine triangular golden rays (the clock's hour, 09).
  const RAYS = 9;
  g.lineJoin = 'miter';
  for (let i = 0; i < RAYS; i++) {
    g.save();
    g.rotate((i / RAYS) * Math.PI * 2);
    g.beginPath();
    g.moveTo(0, -276);
    g.lineTo(33, -122);
    g.lineTo(-33, -122);
    g.closePath();
    g.fillStyle = '#ffc935';
    g.fill();
    g.strokeStyle = '#2b0809';
    g.lineWidth = 6;
    g.stroke();
    g.restore();
  }
  ring(104, '#2b0809');
  ring(97, '#ffc935');
  ring(74, '#7d2420');
  ring(66, '#f6dc94');
  return c;
}

function rosette(): HTMLCanvasElement {
  const S = 1024;
  const { c, g } = canvas(S, S);
  g.clearRect(0, 0, S, S);
  g.translate(S / 2, S / 2);
  g.fillStyle = '#b7a077';
  g.beginPath();
  g.arc(0, 0, 508, 0, 7);
  g.fill();
  g.fillStyle = '#e9dcbb';
  g.beginPath();
  g.arc(0, 0, 486, 0, 7);
  g.fill();
  for (let i = 0; i < 48; i++) {
    g.save();
    g.rotate((i / 48) * Math.PI * 2);
    g.fillStyle = i % 2 ? '#cf9a52' : '#f2e7cb';
    g.fillRect(-32, -480, 63, 56);
    g.restore();
  }
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < 8; i++) {
      g.save();
      g.rotate(((i + (k ? 0 : 0.5)) / 8) * Math.PI * 2);
      const len = k ? 410 : 320;
      g.fillStyle = k ? '#b86f35' : '#6f8f7a';
      g.beginPath();
      g.moveTo(0, -len);
      g.lineTo(58, -110);
      g.lineTo(0, 0);
      g.fill();
      g.fillStyle = k ? '#e0a552' : '#95b39b';
      g.beginPath();
      g.moveTo(0, -len);
      g.lineTo(-58, -110);
      g.lineTo(0, 0);
      g.fill();
      g.restore();
    }
  }
  g.strokeStyle = 'rgba(80,56,24,0.4)';
  g.lineWidth = 4;
  for (const rr of [424, 486, 250]) {
    g.beginPath();
    g.arc(0, 0, rr, 0, 7);
    g.stroke();
  }
  return c;
}

// ------------------------------------------------------------
// Readable painted textures
// ------------------------------------------------------------
function botanicalMural(): HTMLCanvasElement {
  const W = 1536;
  const H = 1024;
  const { c, g } = canvas(W, H);
  parchment(g, W, H, 101, '#f6e9c8');
  const r = rng(103);
  // Painted vine frame
  for (let i = 0; i < 420; i++) {
    const side = Math.floor(r() * 4);
    const t = r();
    const d = r() * 52;
    const x = side === 0 ? d : side === 1 ? W - d : t * W;
    const y = side === 2 ? d : side === 3 ? H - d : t * H;
    g.save();
    g.translate(x, y);
    g.rotate(r() * 6.28);
    g.fillStyle = hsl(95 + r() * 40, 36, 32 + r() * 18, 0.9);
    g.beginPath();
    g.ellipse(0, 0, 10 + r() * 16, 5 + r() * 6, 0, 0, 7);
    g.fill();
    g.restore();
  }
  for (let i = 0; i < 54; i++) {
    const side = Math.floor(r() * 4);
    const t = r();
    const x = side === 0 ? 24 : side === 1 ? W - 24 : t * W;
    const y = side === 2 ? 24 : side === 3 ? H - 24 : t * H;
    g.fillStyle = ['#e58aa5', '#f3c04e', '#d9643c', '#b48ad8'][i % 4];
    for (let p = 0; p < 5; p++) {
      g.beginPath();
      g.arc(x + Math.cos((p / 5) * 6.28) * 10, y + Math.sin((p / 5) * 6.28) * 10, 8, 0, 7);
      g.fill();
    }
    g.fillStyle = '#fff3c4';
    g.beginPath();
    g.arc(x, y, 5, 0, 7);
    g.fill();
  }
  g.textAlign = 'center';
  g.fillStyle = '#57351a';
  g.font = `bold 58px ${SERIF}`;
  g.fillText('BOTANICAL GRID', 520, 122);
  g.font = `italic 30px ${SERIF}`;
  g.fillText('North is up', 520, 162);

  const grid: CipherSymbol[][] = [
    ['sun', 'leaf', 'gear'],
    ['moon', 'bell', 'drop'],
    ['star', 'key', 'feather'],
  ];
  const names = [
    ['Sun', 'Leaf', 'Gear'],
    ['Moon', 'Bell', 'Drop'],
    ['Star', 'Key', 'Feather'],
  ];
  const x0 = 190;
  const y0 = 196;
  const s = 226;
  g.fillStyle = 'rgba(255,250,232,0.85)';
  g.fillRect(x0, y0, s * 3, s * 3);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const x = x0 + col * s;
      const y = y0 + row * s;
      g.fillStyle = (row + col) % 2 ? 'rgba(214,190,132,0.32)' : 'rgba(255,255,255,0.35)';
      g.fillRect(x, y, s, s);
      g.strokeStyle = '#7a5426';
      g.lineWidth = 5;
      g.strokeRect(x, y, s, s);
      drawSymbol(g, grid[row][col], x + s / 2, y + s / 2 - 2, 66);
      g.fillStyle = '#4a2c12';
      g.font = `bold 40px ${SERIF}`;
      g.textAlign = 'left';
      g.fillText(`${'ABC'[row]}${col + 1}`, x + 14, y + 46);
      g.font = `bold 30px ${SERIF}`;
      g.textAlign = 'center';
      g.fillText(names[row][col], x + s / 2, y + s - 18);
    }
  }
  // Compass letters
  g.font = `bold 46px ${SERIF}`;
  g.fillStyle = '#a0521e';
  g.fillText('W', x0 - 46, y0 + s * 1.5 + 16);
  g.fillText('E', x0 + s * 3 + 40, y0 + s * 1.5 + 16);
  g.fillText('S', x0 + s * 1.5, y0 + s * 3 + 50);

  g.textAlign = 'left';
  g.fillStyle = '#57351a';
  g.font = `bold 38px ${SERIF}`;
  g.fillText('CALL THESE FOUR', 976, 190);
  g.fillText('DIALS THROUGH', 976, 236);
  g.fillText('THE GLASS', 976, 282);
  // Four clean icon clues (mirrors WORLD_CLUES.clue_tea_north_mural): no prose to misread.
  const arrow = (x: number, y: number, angle: number, r = 46): void => {
    g.save();
    g.translate(x, y);
    g.rotate(angle); // 0 = east, +PI/2 = south (canvas y points down)
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#8a2f14';
    g.lineWidth = r * 0.26;
    g.beginPath();
    g.moveTo(-r * 0.85, 0);
    g.lineTo(r * 0.75, 0);
    g.moveTo(r * 0.2, -r * 0.55);
    g.lineTo(r * 0.8, 0);
    g.lineTo(r * 0.2, r * 0.55);
    g.stroke();
    g.restore();
  };
  const centerMark = (x: number, y: number, r = 48): void => {
    g.strokeStyle = '#8a2f14';
    g.lineWidth = 11;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.moveTo(x - r, y);
    g.lineTo(x + r, y);
    g.moveTo(x, y - r);
    g.lineTo(x, y + r);
    g.stroke();
  };
  const E = 0;
  const N = -Math.PI / 2;
  const SO = Math.PI / 2;
  const SW = Math.PI * 0.75;
  const rows: { symbol: CipherSymbol | null; arrows: number[] }[] = [
    { symbol: 'sun', arrows: [SO] },
    { symbol: null, arrows: [] },
    { symbol: 'key', arrows: [E, N, N] },
    { symbol: 'gear', arrows: [SW] },
  ];
  rows.forEach(({ symbol, arrows }, i) => {
    const y = 382 + i * 148;
    g.fillStyle = 'rgba(255,250,232,0.8)';
    rounded(g, 958, y - 64, 500, 128, 26);
    g.fill();
    g.strokeStyle = '#b5762a';
    g.lineWidth = 4;
    g.stroke();
    g.fillStyle = '#b5762a';
    g.beginPath();
    g.arc(1012, y, 37, 0, 7);
    g.fill();
    g.fillStyle = '#fff6dd';
    g.font = `bold 44px ${SERIF}`;
    g.textAlign = 'center';
    g.fillText(`${i + 1}`, 1012, y + 15);
    if (symbol) drawSymbol(g, symbol, 1114, y, 48);
    else centerMark(1114, y);
    arrows.forEach((a, k) => arrow(1222 + k * 92, y, a, 40));
  });
  return c;
}

function uvQuote(i: number): string {
  const body = WORLD_CLUES[`clue_uv_frame_${i}`]?.body ?? '';
  const m = body.match(/"([^"]+)"/);
  return m ? m[1] : body;
}

function uvCanvasPair(i: number, w: number, h: number): { blank: HTMLCanvasElement; uv: HTMLCanvasElement } {
  const { c: blank, g: bg } = canvas(w, h);
  parchment(bg, w, h, 200 + i, '#f7edd3');
  bg.strokeStyle = 'rgba(160,120,60,0.22)';
  bg.lineWidth = 3;
  bg.strokeRect(w * 0.06, h * 0.06, w * 0.88, h * 0.88);

  const { c: uv, g } = canvas(w, h);
  const bgGrad = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.75);
  bgGrad.addColorStop(0, '#3a1c86');
  bgGrad.addColorStop(1, '#160a3c');
  g.fillStyle = bgGrad;
  g.fillRect(0, 0, w, h);
  const r = rng(300 + i);
  for (let k = 0; k < 90; k++) {
    g.fillStyle = `rgba(${r() > 0.5 ? '120,255,255' : '210,130,255'},${0.15 + r() * 0.4})`;
    g.beginPath();
    g.arc(r() * w, r() * h, 0.8 + r() * 2.2, 0, 7);
    g.fill();
  }
  g.shadowColor = '#c77bff';
  g.shadowBlur = 24;
  g.strokeStyle = '#c58bff';
  g.lineWidth = w * 0.009;
  g.strokeRect(w * 0.055, h * 0.055, w * 0.89, h * 0.89);
  g.textAlign = 'center';
  g.fillStyle = '#e0b3ff';
  g.font = `bold ${Math.round(w * 0.065)}px ${SERIF}`;
  g.fillText(['I  ·  TINY', 'II  ·  SMALL', 'III  ·  MEDIUM', 'IV  ·  LARGE'][i], w / 2, h * 0.19);
  g.shadowColor = '#37f6ff';
  g.fillStyle = '#b9fdff';
  const fs = Math.round(w * 0.072);
  g.font = `${fs}px ${SERIF}`;
  const lines = wrapText(g, uvQuote(i), w * 0.82);
  lines.forEach((line, k) => {
    const y = h * 0.56 + (k - (lines.length - 1) / 2) * fs * 1.28 + fs * 0.3;
    g.fillText(line, w / 2, y);
    g.fillText(line, w / 2, y);
  });
  return { blank, uv };
}

function archRelief(): HTMLCanvasElement {
  const W = 1536;
  const H = 512;
  const { c, g } = canvas(W, H);
  const r = rng(401);
  g.fillStyle = '#e6d8b6';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = r() > 0.5 ? `rgba(255,250,230,${r() * 0.2})` : `rgba(120,92,50,${r() * 0.14})`;
    g.beginPath();
    g.arc(r() * W, r() * H, 0.6 + r() * 3, 0, 7);
    g.fill();
  }
  ornateBorder(g, W, H, '#9a7432', 16);
  g.textAlign = 'center';
  g.font = `bold 46px ${SERIF}`;
  g.fillStyle = '#fff8e2';
  g.fillText('RESONANCE SEQUENCE', W / 2 + 2, 86);
  g.fillStyle = '#573a14';
  g.fillText('RESONANCE SEQUENCE', W / 2, 84);
  SOLUTIONS.p12_sequence.forEach((col, i) => {
    const x = 220 + i * 366;
    const y = 250;
    g.fillStyle = 'rgba(90,62,24,0.35)';
    g.beginPath();
    g.arc(x + 5, y + 7, 106, 0, 7);
    g.fill();
    g.fillStyle = '#b68a3c';
    g.beginPath();
    g.arc(x, y, 106, 0, 7);
    g.fill();
    const q = g.createRadialGradient(x - 26, y - 34, 8, x, y, 96);
    q.addColorStop(0, '#ffffff');
    q.addColorStop(0.25, HARP_HEX[col]);
    q.addColorStop(1, HARP_HEX[col]);
    g.fillStyle = q;
    g.beginPath();
    g.arc(x, y, 92, 0, 7);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.strokeStyle = 'rgba(30,20,10,0.75)';
    g.lineWidth = 8;
    g.font = `bold 92px ${SERIF}`;
    g.strokeText(String(i + 1), x, y + 32);
    g.fillText(String(i + 1), x, y + 32);
    g.fillStyle = '#43290d';
    g.font = `bold 54px ${SERIF}`;
    g.fillText(col.toUpperCase(), x, 430);
    if (i < 3) {
      g.fillStyle = '#8a5f22';
      g.beginPath();
      g.moveTo(x + 132, y - 18);
      g.lineTo(x + 196, y - 18);
      g.lineTo(x + 196, y - 44);
      g.lineTo(x + 240, y);
      g.lineTo(x + 196, y + 44);
      g.lineTo(x + 196, y + 18);
      g.lineTo(x + 132, y + 18);
      g.fill();
    }
  });
  return c;
}

function estateBlueprint(): HTMLCanvasElement {
  const W = 1024;
  const H = 1024;
  const { c, g } = canvas(W, H);
  g.fillStyle = '#1f4f7d';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,0.09)';
  g.lineWidth = 1;
  for (let i = 0; i < W; i += 32) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, H);
    g.moveTo(0, i);
    g.lineTo(W, i);
    g.stroke();
  }
  ornateBorder(g, W, H, '#e8d9a0', 18);
  g.textAlign = 'center';
  g.fillStyle = '#fff3cd';
  g.font = `bold 46px ${SERIF}`;
  g.fillText('SOLSTICE MANOR', W / 2, 92);
  g.font = `italic 25px ${SERIF}`;
  g.fillText('Estate plan', W / 2, 126);
  const sc = 15.6;
  const px = (x: number): number => W / 2 + x * sc;
  const pz = (z: number): number => 635 + z * sc;
  const room = (x0: number, x1: number, z0: number, z1: number, label: string[], fill: string): void => {
    g.fillStyle = fill;
    g.fillRect(px(x0), pz(z0), (x1 - x0) * sc, (z1 - z0) * sc);
    g.strokeStyle = '#eaf4ff';
    g.lineWidth = 4;
    g.strokeRect(px(x0), pz(z0), (x1 - x0) * sc, (z1 - z0) * sc);
    g.fillStyle = '#ffffff';
    g.font = `bold 22px ${SERIF}`;
    label.forEach((l, i) => g.fillText(l, px((x0 + x1) / 2), pz((z0 + z1) / 2) + (i - (label.length - 1) / 2) * 26 + 8));
  };
  room(-12, 12, -29, -14, [], 'rgba(90,190,110,0.28)');
  room(-12, 12, -14, 6, [], 'rgba(240,210,130,0.24)');
  room(-8, 8, 6, 18, ['GRAND', 'FOYER'], 'rgba(255,190,110,0.28)');
  room(-20, -8, 5, 18, ["ALCHEMIST'S", 'STUDY'], 'rgba(190,130,230,0.24)');
  room(8, 20, 5, 11, ['TEA · NORTH'], 'rgba(120,220,180,0.22)');
  room(8, 20, 11, 18, ['TEA · SOUTH'], 'rgba(120,220,180,0.3)');
  room(-26, -12, -14, 2, ['BOTANICAL', 'CONSERVATORY'], 'rgba(90,220,140,0.3)');
  room(12, 26, -14, 2, ['CLOCKWORK', 'WORKSHOP'], 'rgba(230,120,80,0.3)');
  room(-9.8, 8.8, -20.5, -13.2, ['OBSERVATORY', '(upper deck)'], 'rgba(60,90,200,0.7)');
  room(8.8, 11.9, -19.5, -10.5, [], 'rgba(220,180,90,0.5)');
  g.fillStyle = '#fff';
  g.font = `bold 22px ${SERIF}`;
  g.fillText('SKY-GARDEN', px(0), pz(-22.6));
  g.fillText('FOUNTAIN COURTYARD', px(0), pz(1.4));
  g.font = `18px ${SERIF}`;
  g.fillText('ramp', px(10.35), pz(-14.8));
  g.fillText('Solstice Gate', px(0), pz(-27.9));
  g.strokeStyle = '#ffd877';
  g.lineWidth = 5;
  g.beginPath();
  g.arc(px(0), pz(-4), 34, 0, 7);
  g.stroke();
  g.beginPath();
  g.arc(px(0), pz(-29), 18, Math.PI, 0);
  g.stroke();
  // Compass
  g.save();
  g.translate(W - 112, 156);
  g.fillStyle = '#ffe19a';
  g.beginPath();
  g.moveTo(0, -48);
  g.lineTo(14, 0);
  g.lineTo(0, 48);
  g.lineTo(-14, 0);
  g.fill();
  g.font = `bold 26px ${SERIF}`;
  g.fillText('N', 0, -56);
  g.restore();
  g.font = `italic 22px ${SERIF}`;
  g.fillStyle = '#fff3cd';
  g.fillText('You begin here', px(0), pz(15.6) + 10);
  drawSymbol(g, 'star', px(0), pz(13.9), 11, '#ffd877');
  return c;
}

/** Small readable plaque. Body is wrapped & auto-fitted. */
export function makePlaqueTexture(
  title: string,
  body: string,
  opts: { w?: number; h?: number; style?: 'brass' | 'stone' | 'paper' | 'blueprint' } = {},
): THREE.CanvasTexture {
  const w = opts.w ?? 768;
  const h = opts.h ?? 512;
  const style = opts.style ?? 'paper';
  const { c, g } = canvas(w, h);
  let ink = '#3c2310';
  if (style === 'brass') {
    const q = g.createLinearGradient(0, 0, w, h);
    q.addColorStop(0, '#e9c774');
    q.addColorStop(0.5, '#c99b45');
    q.addColorStop(1, '#e3bd66');
    g.fillStyle = q;
    g.fillRect(0, 0, w, h);
  } else if (style === 'stone') {
    parchment(g, w, h, 7, '#e2d7bd');
  } else if (style === 'blueprint') {
    g.fillStyle = '#23588a';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.1)';
    for (let i = 0; i < w; i += 28) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, h);
      g.moveTo(0, i);
      g.lineTo(w, i);
      g.stroke();
    }
    ink = '#fff5d6';
  } else {
    parchment(g, w, h, 9);
  }
  if (body.length < 24) {
    // Compact nameplate: one or two big centred lines
    g.strokeStyle = '#7d5522';
    g.lineWidth = Math.max(3, h * 0.03);
    g.strokeRect(h * 0.07, h * 0.07, w - h * 0.14, h - h * 0.14);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = ink;
    const size = body ? h * 0.36 : h * 0.62;
    g.font = `bold ${Math.round(size)}px ${SERIF}`;
    g.fillText(title, w / 2, body ? h * 0.35 : h * 0.53, w - h * 0.3);
    if (body) {
      g.font = `${Math.round(h * 0.28)}px ${SERIF}`;
      g.fillText(body, w / 2, h * 0.7, w - h * 0.3);
    }
    return toTexture(c);
  }
  ornateBorder(g, w, h, style === 'blueprint' ? '#f1e2ae' : '#7d5522', 16);
  g.textAlign = 'center';
  g.fillStyle = ink;
  let tf = Math.round(h * 0.085);
  g.font = `bold ${tf}px ${SERIF}`;
  while (g.measureText(title).width > w - 90 && tf > 14) {
    tf -= 2;
    g.font = `bold ${tf}px ${SERIF}`;
  }
  g.fillText(title, w / 2, 48 + tf);
  const top = 66 + tf;
  let fs = Math.round(h * 0.07);
  let lines: string[] = [];
  for (; fs > 11; fs--) {
    g.font = `${fs}px ${SERIF}`;
    lines = wrapText(g, body, w - 110);
    if (lines.length * fs * 1.26 < h - top - 44) break;
  }
  g.textAlign = 'left';
  lines.forEach((l, i) => g.fillText(l, 55, top + fs + i * fs * 1.26));
  return toTexture(c);
}

export function makeNameTexture(name: string, accent: string): THREE.CanvasTexture {
  const { c, g } = canvas(512, 128);
  g.font = `bold 52px ${SERIF}`;
  const w = Math.min(500, g.measureText(name).width + 70);
  g.fillStyle = 'rgba(52,30,12,0.78)';
  rounded(g, 256 - w / 2, 20, w, 88, 40);
  g.fill();
  g.strokeStyle = accent;
  g.lineWidth = 5;
  g.stroke();
  g.fillStyle = '#fff3d0';
  g.textAlign = 'center';
  g.fillText(name, 256, 82, 450);
  return toTexture(c);
}

export function makeSymbolTexture(s: CipherSymbol): THREE.CanvasTexture {
  const { c, g } = canvas(256, 256);
  g.fillStyle = '#f8edd0';
  g.beginPath();
  g.arc(128, 128, 126, 0, 7);
  g.fill();
  g.strokeStyle = '#8b6427';
  g.lineWidth = 10;
  g.stroke();
  drawSymbol(g, s, 128, 128, 84);
  return toTexture(c);
}

/** Stopped pocket watch: snapped hour hand, blued minute hand jammed at :35. */
export function makePocketWatchTexture(): THREE.CanvasTexture {
  const { c, g } = canvas(256, 256);
  g.fillStyle = '#fbf3dc';
  g.beginPath();
  g.arc(128, 128, 127, 0, 7);
  g.fill();
  g.translate(128, 128);
  g.fillStyle = '#3a220e';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold 24px ${SERIF}`;
  for (let i = 0; i < 60; i++) {
    g.save();
    g.rotate((i / 60) * Math.PI * 2);
    g.fillRect(i % 5 ? -1 : -2.5, -120, i % 5 ? 2 : 5, i % 5 ? 8 : 14);
    g.restore();
  }
  ['12', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'].forEach((n, i) => {
    const a = (i / 12) * Math.PI * 2;
    g.fillText(n, Math.sin(a) * 88, -Math.cos(a) * 88);
  });
  g.save();
  g.rotate((35 / 60) * Math.PI * 2);
  g.fillStyle = '#23408f';
  g.beginPath();
  g.moveTo(-6, 20);
  g.lineTo(-4, -70);
  g.lineTo(0, -110);
  g.lineTo(4, -70);
  g.lineTo(6, 20);
  g.fill();
  g.restore();
  g.fillStyle = '#8a5f28';
  g.beginPath();
  g.arc(0, 0, 11, 0, 7);
  g.fill();
  return toTexture(c);
}

function clockFace(): HTMLCanvasElement {
  const { c, g } = canvas(512, 512);
  g.translate(256, 256);
  g.fillStyle = '#b98d3f';
  g.beginPath();
  g.arc(0, 0, 254, 0, 7);
  g.fill();
  g.fillStyle = '#fdf4dc';
  g.beginPath();
  g.arc(0, 0, 232, 0, 7);
  g.fill();
  drawSymbol(g, 'sun', 0, 0, 96, 'rgba(225,165,60,0.35)');
  g.fillStyle = '#3b2410';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold 44px ${SERIF}`;
  ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'].forEach((n, i) => {
    const a = (i / 12) * Math.PI * 2;
    g.save();
    g.translate(Math.sin(a) * 178, -Math.cos(a) * 178);
    g.rotate(a);
    g.fillText(n, 0, 0);
    g.restore();
  });
  for (let i = 0; i < 60; i++) {
    g.save();
    g.rotate((i / 60) * Math.PI * 2);
    g.fillRect(-2, -224, 4, i % 5 ? 10 : 18);
    g.restore();
  }
  return c;
}

/** Numbered dial ring (1..n clockwise from the top). `readFromRim` turns digits to face a viewer standing outside. */
export function makeNumberRing(n: number, label: string, face: string, ink: string, readFromRim = false): THREE.CanvasTexture {
  const { c, g } = canvas(512, 512);
  g.translate(256, 256);
  g.fillStyle = face;
  g.beginPath();
  g.arc(0, 0, 255, 0, 7);
  g.fill();
  g.strokeStyle = ink;
  g.lineWidth = 4;
  g.beginPath();
  g.arc(0, 0, 246, 0, 7);
  g.stroke();
  g.fillStyle = ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold 44px ${SERIF}`;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    g.save();
    g.rotate(a);
    g.translate(0, -210);
    if (readFromRim) g.rotate(Math.PI);
    g.fillText(String(i + 1), 0, 0);
    g.restore();
  }
  if (label) {
    g.font = `bold 30px ${SERIF}`;
    g.fillText(label, 0, 150);
  }
  return toTexture(c);
}

/** Gauge face 0..80 PSI over 270°, with green target band. */
export function makeGaugeTexture(target: number, label: string): THREE.CanvasTexture {
  const { c, g } = canvas(256, 256);
  g.translate(128, 128);
  g.fillStyle = '#b98d3f';
  g.beginPath();
  g.arc(0, 0, 127, 0, 7);
  g.fill();
  g.fillStyle = '#fff8e6';
  g.beginPath();
  g.arc(0, 0, 112, 0, 7);
  g.fill();
  const ang = (v: number): number => ((v / 80) * 270 - 225) * (Math.PI / 180);
  g.strokeStyle = '#2fae55';
  g.lineWidth = 18;
  g.beginPath();
  g.arc(0, 0, 94, ang(target - 3), ang(target + 3));
  g.stroke();
  g.fillStyle = '#3b2410';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold 20px ${SERIF}`;
  for (let v = 0; v <= 80; v += 10) {
    const a = ang(v);
    g.fillText(String(v), Math.cos(a) * 72, Math.sin(a) * 72);
    g.save();
    g.rotate(a);
    g.fillRect(88, -2, 20, 4);
    g.restore();
  }
  g.font = `bold 30px ${SERIF}`;
  g.fillText(label, 0, 46);
  return toTexture(c);
}

function oracleSign(): HTMLCanvasElement {
  const { c, g } = canvas(768, 192);
  const q = g.createLinearGradient(0, 0, 0, 192);
  q.addColorStop(0, '#5b2560');
  q.addColorStop(1, '#321244');
  g.fillStyle = q;
  g.fillRect(0, 0, 768, 192);
  g.strokeStyle = '#e8bd5c';
  g.lineWidth = 10;
  g.strokeRect(8, 8, 752, 176);
  g.textAlign = 'center';
  g.shadowColor = '#ffcf6a';
  g.shadowBlur = 22;
  g.fillStyle = '#ffe6a3';
  g.font = `bold 60px ${SERIF}`;
  g.fillText('CLOCKWORK ORACLE', 384, 92);
  g.font = `italic 38px ${SERIF}`;
  g.fillText('hints foretold', 384, 148);
  return c;
}

/** Directional dial (N/E/S/W around the rim) for the core pedestals. */
function compassDial(): HTMLCanvasElement {
  const { c, g } = canvas(512, 512);
  g.translate(256, 256);
  g.fillStyle = '#f5e7c3';
  g.beginPath();
  g.arc(0, 0, 254, 0, 7);
  g.fill();
  g.strokeStyle = '#8b6427';
  g.lineWidth = 12;
  g.beginPath();
  g.arc(0, 0, 246, 0, 7);
  g.stroke();
  for (let i = 0; i < 32; i++) {
    g.save();
    g.rotate((i / 32) * Math.PI * 2);
    g.fillStyle = '#8b6427';
    g.fillRect(-2, -236, 4, i % 8 ? 16 : 34);
    g.restore();
  }
  g.fillStyle = '#43290d';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold 72px ${SERIF}`;
  g.fillText('N', 0, -164);
  g.fillText('E', 168, 4);
  g.fillText('S', 0, 170);
  g.fillText('W', -168, 4);
  return c;
}

function softDisc(inner: string, outer: string, size = 128): HTMLCanvasElement {
  const { c, g } = canvas(size, size);
  const q = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  q.addColorStop(0, inner);
  q.addColorStop(0.35, inner.replace(/[\d.]+\)$/, '0.42)'));
  q.addColorStop(1, outer);
  g.fillStyle = q;
  g.fillRect(0, 0, size, size);
  return c;
}

function portal(): HTMLCanvasElement {
  const S = 512;
  const { c, g } = canvas(S, S);
  g.translate(S / 2, S / 2);
  const q = g.createRadialGradient(0, 0, 0, 0, 0, S / 2);
  q.addColorStop(0, 'rgba(255,255,240,1)');
  q.addColorStop(0.4, 'rgba(255,224,140,0.75)');
  q.addColorStop(0.8, 'rgba(255,170,80,0.35)');
  q.addColorStop(1, 'rgba(255,150,60,0)');
  g.fillStyle = q;
  g.fillRect(-S / 2, -S / 2, S, S);
  for (let i = 0; i < 24; i++) {
    g.save();
    g.rotate((i / 24) * Math.PI * 2);
    g.strokeStyle = 'rgba(255,245,200,0.4)';
    g.lineWidth = i % 2 ? 3 : 7;
    g.beginPath();
    g.moveTo(30, 0);
    g.bezierCurveTo(90, 40, 150, 40, 226, -10);
    g.stroke();
    g.restore();
  }
  return c;
}

function envEquirect(): THREE.CanvasTexture {
  const { c, g } = canvas(512, 256);
  const q = g.createLinearGradient(0, 0, 0, 256);
  q.addColorStop(0, '#5f9fd8');
  q.addColorStop(0.36, '#bcd8ea');
  q.addColorStop(0.49, '#ffe2b4');
  q.addColorStop(0.52, '#c9b37c');
  q.addColorStop(0.7, '#8d8150');
  q.addColorStop(1, '#6b5a38');
  g.fillStyle = q;
  g.fillRect(0, 0, 512, 256);
  for (const [x, rad] of [
    [150, 60],
    [400, 34],
  ]) {
    const s = g.createRadialGradient(x, 78, 0, x, 78, rad);
    s.addColorStop(0, 'rgba(255,250,225,1)');
    s.addColorStop(0.3, 'rgba(255,232,175,0.75)');
    s.addColorStop(1, 'rgba(255,215,150,0)');
    g.fillStyle = s;
    g.fillRect(x - rad, 78 - rad, rad * 2, rad * 2);
  }
  // Horizon silhouettes give metal something to reflect
  g.fillStyle = 'rgba(70,92,52,0.65)';
  for (let x = 0; x < 512; x += 8) g.fillRect(x, 124 - (Math.sin(x / 23) + 1) * 4, 8, 14);
  const t = toTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

// ------------------------------------------------------------
// Public registry
// ------------------------------------------------------------
export interface SolsticeTextures {
  parquet: THREE.CanvasTexture;
  flagstone: THREE.CanvasTexture;
  flagstoneBump: THREE.CanvasTexture;
  grass: THREE.CanvasTexture;
  damask: THREE.CanvasTexture;
  brick: THREE.CanvasTexture;
  brickBump: THREE.CanvasTexture;
  ashlar: THREE.CanvasTexture;
  brass: THREE.CanvasTexture;
  walnut: THREE.CanvasTexture;
  marble: THREE.CanvasTexture;
  glassIron: THREE.CanvasTexture;
  starDome: THREE.CanvasTexture;
  hedge: THREE.CanvasTexture;
  roof: THREE.CanvasTexture;
  plaster: THREE.CanvasTexture;
  books: THREE.CanvasTexture;
  rug: THREE.CanvasTexture;
  rosette: THREE.CanvasTexture;
  mural: THREE.CanvasTexture;
  uvBlank: THREE.CanvasTexture[];
  uvGlow: THREE.CanvasTexture[];
  archRelief: THREE.CanvasTexture;
  blueprint: THREE.CanvasTexture;
  clockFace: THREE.CanvasTexture;
  oracleSign: THREE.CanvasTexture;
  compassDial: THREE.CanvasTexture;
  portal: THREE.CanvasTexture;
  glow: THREE.CanvasTexture;
  mote: THREE.CanvasTexture;
  env: THREE.CanvasTexture;
}

/** Canvas aspect (w/h) of each UV painting, smallest to largest. */
export const UV_FRAME_SIZES: { w: number; h: number }[] = [
  { w: 0.48, h: 0.4 },
  { w: 0.84, h: 0.7 },
  { w: 1.32, h: 1.1 },
  { w: 2.04, h: 1.7 },
];

let cache: SolsticeTextures | null = null;

export function getTextures(): SolsticeTextures {
  if (cache) return cache;
  const fs = flagstone();
  const br = brick();
  const uvPairs = [0, 1, 2, 3].map((i) => uvCanvasPair(i, 768, 640));
  cache = {
    parquet: tiled(parquet(), 2.6),
    flagstone: tiled(fs.color, 4),
    flagstoneBump: tiled(fs.bump, 4, false),
    grass: tiled(grass(), 3),
    damask: tiled(damask(), 1.5),
    brick: tiled(br.color, 1.9),
    brickBump: tiled(br.bump, 1.9, false),
    ashlar: tiled(ashlar(), 2),
    brass: tiled(brushedBrass(), 0.8),
    walnut: tiled(walnut(), 1.2),
    marble: tiled(marble(), 2, true, true),
    glassIron: tiled(glassIron(), 4),
    starDome: toTexture(starDome()),
    hedge: tiled(hedgeLeaves(), 1.4),
    roof: tiled(roofTiles(), 2.2),
    plaster: tiled(plaster(), 2),
    books: toTexture(books()),
    rug: toTexture(rug()),
    rosette: toTexture(rosette()),
    mural: toTexture(botanicalMural()),
    uvBlank: uvPairs.map((p) => toTexture(p.blank)),
    uvGlow: uvPairs.map((p) => toTexture(p.uv)),
    archRelief: toTexture(archRelief()),
    blueprint: toTexture(estateBlueprint()),
    clockFace: toTexture(clockFace()),
    oracleSign: toTexture(oracleSign()),
    compassDial: toTexture(compassDial()),
    portal: toTexture(portal()),
    glow: toTexture(softDisc('rgba(255,255,255,1)', 'rgba(255,255,255,0)')),
    mote: toTexture(softDisc('rgba(255,255,255,1)', 'rgba(255,255,255,0)', 64)),
    env: envEquirect(),
  };
  return cache;
}
