import { listen } from "@tauri-apps/api/event";
import {
  applyTheme, cancelCapture, commitCapture, currentCapture, frozenUrl, getSettings,
  PEN_COLORS, PEN_WIDTHS, putSettings,
  type CaptureReady, type Settings,
} from "./api";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const frozen = el<HTMLImageElement>("frozen");
const sel = el("sel");
const selSize = el("sel-size");
const ink = el<HTMLCanvasElement>("ink");
const composer = el<HTMLFormElement>("composer");
const noteText = el<HTMLTextAreaElement>("note-text");
const chX = el("crosshair-x");
const chY = el("crosshair-y");

type Rect = { x: number; y: number; w: number; h: number };
type Stroke = { color: string; width: number; points: { x: number; y: number }[] };

let shot: CaptureReady = { version: 0, width: 0, height: 0 };
let settings: Settings;
let origin: { x: number; y: number } | null = null;
let rect: Rect | null = null;
let composing = false;

/** Strokes are kept as data, not just pixels, so undo is a redraw. */
let strokes: Stroke[] = [];
let drawing: Stroke | null = null;

/** The image covers the viewport 1:1, so CSS px map to physical px by ratio. */
const toFractions = (r: Rect): Rect => ({
  x: r.x / window.innerWidth,
  y: r.y / window.innerHeight,
  w: r.w / window.innerWidth,
  h: r.h / window.innerHeight,
});

/** Physical pixels per CSS pixel of the frozen screenshot. */
const pixelScale = () => shot.width / window.innerWidth;

const physical = (r: Rect) => ({
  w: Math.round(r.w * pixelScale()),
  h: Math.round((r.h / window.innerHeight) * shot.height),
});

function drawSelection(r: Rect) {
  sel.hidden = false;
  sel.style.left = `${r.x}px`;
  sel.style.top = `${r.y}px`;
  sel.style.width = `${r.w}px`;
  sel.style.height = `${r.h}px`;
  const p = physical(r);
  selSize.textContent = `${p.w} × ${p.h}`;
}

// ------------------------------------------------------------------- the pen

/**
 * The canvas sits exactly over the selection but its backing store is the
 * crop's real pixel size, so the marker layer composites onto the screenshot
 * with no resampling.
 */
function placeCanvas(r: Rect) {
  const p = physical(r);
  ink.width = p.w;
  ink.height = p.h;
  ink.style.left = `${r.x}px`;
  ink.style.top = `${r.y}px`;
  ink.style.width = `${r.w}px`;
  ink.style.height = `${r.h}px`;
  ink.hidden = false;
  repaint();
}

function repaint() {
  const ctx = ink.getContext("2d");
  if (!ctx) return;
  const scale = pixelScale();
  ctx.clearRect(0, 0, ink.width, ink.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const stroke of strokes.concat(drawing ? [drawing] : [])) {
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width * scale;
    ctx.beginPath();
    stroke.points.forEach((pt, i) => {
      const x = pt.x * scale;
      const y = pt.y * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    // A single click should still leave a dot rather than nothing.
    if (stroke.points.length === 1) {
      const [pt] = stroke.points;
      ctx.lineTo(pt.x * scale + 0.01, pt.y * scale);
    }
    ctx.stroke();
  }
}

/** Pointer position relative to the selection, in CSS pixels. */
function penPoint(e: MouseEvent) {
  const box = ink.getBoundingClientRect();
  return { x: e.clientX - box.left, y: e.clientY - box.top };
}

ink.addEventListener("mousedown", (e) => {
  e.stopPropagation();
  drawing = { color: settings.pen_color, width: settings.pen_width, points: [penPoint(e)] };
  repaint();
});

ink.addEventListener("mousemove", (e) => {
  if (!drawing) return;
  drawing.points.push(penPoint(e));
  repaint();
});

function endStroke() {
  if (!drawing) return;
  strokes.push(drawing);
  drawing = null;
  repaint();
}

// Released outside the canvas still finishes the stroke.
window.addEventListener("mouseup", endStroke);

function undo() {
  strokes.pop();
  repaint();
}

el("btn-undo").addEventListener("click", undo);

/** Null when nothing was drawn, so a clean capture stays a clean PNG. */
function inkLayer(): string | null {
  if (!strokes.length) return null;
  return ink.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

function buildTools() {
  const swatches = el("swatches");
  swatches.replaceChildren(
    ...PEN_COLORS.map((color) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.style.background = color;
      b.title = color;
      b.addEventListener("click", () => {
        settings.pen_color = color;
        void putSettings(settings);
        markTools();
      });
      b.dataset.color = color;
      return b;
    }),
  );

  const widths = el("widths");
  widths.replaceChildren(
    ...PEN_WIDTHS.map((width) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "width";
      b.title = `${width} px`;
      const dot = document.createElement("span");
      dot.style.width = `${width + 2}px`;
      dot.style.height = `${width + 2}px`;
      b.append(dot);
      b.addEventListener("click", () => {
        settings.pen_width = width;
        void putSettings(settings);
        markTools();
      });
      b.dataset.width = String(width);
      return b;
    }),
  );
}

function markTools() {
  for (const b of document.querySelectorAll<HTMLElement>(".swatch")) {
    b.classList.toggle("on", b.dataset.color === settings.pen_color);
  }
  for (const b of document.querySelectorAll<HTMLElement>(".width")) {
    b.classList.toggle("on", Number(b.dataset.width) === settings.pen_width);
    (b.firstElementChild as HTMLElement).style.background = settings.pen_color;
  }
}

// ------------------------------------------------------------------ selection

function placeComposer(r: Rect) {
  const gap = 12;
  const width = composer.offsetWidth;
  const height = composer.offsetHeight;
  const below = r.y + r.h + gap;
  const top = below + height <= window.innerHeight ? below : Math.max(gap, r.y - height - gap);
  const left = Math.min(Math.max(gap, r.x), window.innerWidth - width - gap);
  composer.style.top = `${top}px`;
  composer.style.left = `${left}px`;
}

/** This window is reused for every capture, so each one starts from scratch. */
function reset() {
  origin = null;
  rect = null;
  composing = false;
  strokes = [];
  drawing = null;
  sel.hidden = true;
  ink.hidden = true;
  composer.hidden = true;
  noteText.value = "";
  document.body.classList.remove("selecting", "composing");
}

document.addEventListener("mousedown", (e) => {
  if (composing) return;
  origin = { x: e.clientX, y: e.clientY };
  document.body.classList.add("selecting");
});

document.addEventListener("mousemove", (e) => {
  if (!composing && !origin) {
    chX.style.top = `${e.clientY}px`;
    chY.style.left = `${e.clientX}px`;
    return;
  }
  if (!origin) return;
  rect = {
    x: Math.min(origin.x, e.clientX),
    y: Math.min(origin.y, e.clientY),
    w: Math.abs(e.clientX - origin.x),
    h: Math.abs(e.clientY - origin.y),
  };
  drawSelection(rect);
});

document.addEventListener("mouseup", () => {
  if (composing || !origin) return;
  origin = null;
  document.body.classList.remove("selecting");

  // A stray click is not a selection; go back to waiting for a real drag.
  if (!rect || rect.w < 8 || rect.h < 8) {
    rect = null;
    sel.hidden = true;
    return;
  }

  composing = true;
  document.body.classList.add("composing");
  composer.hidden = false;
  placeCanvas(rect);
  markTools();
  placeComposer(rect);
  noteText.focus();
});

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  save();
});

async function save() {
  if (!rect) return;
  await commitCapture(toFractions(rect), noteText.value.trim(), inkLayer());
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    cancelCapture();
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && composing) {
    e.preventDefault();
    save();
  } else if (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey) && composing) {
    // Only steal Ctrl+Z when there is a stroke to take back, so it still
    // undoes typing inside the note.
    if (strokes.length) {
      e.preventDefault();
      undo();
    }
  }
});

function show(ready: CaptureReady) {
  shot = ready;
  reset();
  frozen.src = frozenUrl(ready.version);
}

listen<CaptureReady>("capture-ready", (e) => show(e.payload));

listen<Settings>("settings-changed", (e) => {
  settings = e.payload;
  applyTheme(settings.theme);
  markTools();
});

settings = await getSettings();
applyTheme(settings.theme);
buildTools();
markTools();

// Covers the first capture landing before this page had a listener attached.
const pending = await currentCapture();
if (pending) show(pending);
