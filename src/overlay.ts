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

type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Tool = "pen" | "arrow" | "rect" | "blur";
type Stroke = { tool: Tool; color: string; width: number; points: Point[] };

const TOOLS: { key: Tool; glyph: string; title: string }[] = [
  { key: "pen", glyph: "✎", title: "Rotulador" },
  { key: "arrow", glyph: "↗", title: "Flecha" },
  { key: "rect", glyph: "▭", title: "Recuadro" },
  { key: "blur", glyph: "▒", title: "Difuminar (tapar datos sensibles)" },
];

let shot: CaptureReady = { version: 0, width: 0, height: 0 };
let settings: Settings;
let tool: Tool = "pen";
let origin: Point | null = null;
let rect: Rect | null = null;
let composing = false;

/** Strokes are kept as data, not pixels, so undo is just a redraw. */
let strokes: Stroke[] = [];
let drawing: Stroke | null = null;

/** The image covers the viewport 1:1, so CSS px map to physical px by ratio. */
const toFractions = (r: Rect): Rect => ({
  x: r.x / window.innerWidth,
  y: r.y / window.innerHeight,
  w: r.w / window.innerWidth,
  h: r.h / window.innerHeight,
});

/** Physical pixels of the screenshot per CSS pixel on screen. */
const pixelScale = () => shot.width / window.innerWidth;

const physical = (r: Rect) => ({
  w: Math.round(r.w * pixelScale()),
  h: Math.round((r.h / window.innerHeight) * shot.height),
});

/** Two corners in any order to a positive-size rect. */
function span(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function drawSelection(r: Rect) {
  sel.hidden = false;
  sel.style.left = `${r.x}px`;
  sel.style.top = `${r.y}px`;
  sel.style.width = `${r.w}px`;
  sel.style.height = `${r.h}px`;
  const p = physical(r);
  selSize.textContent = `${p.w} × ${p.h}`;
}

// ------------------------------------------------------------------- the tools

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

function strokePath(ctx: CanvasRenderingContext2D, stroke: Stroke, scale: number) {
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

function arrow(ctx: CanvasRenderingContext2D, stroke: Stroke, scale: number) {
  const from = stroke.points[0];
  const to = stroke.points[stroke.points.length - 1];
  const x1 = from.x * scale;
  const y1 = from.y * scale;
  const x2 = to.x * scale;
  const y2 = to.y * scale;

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Head scaled to the line weight, so a thick arrow does not get a pinhead.
  const head = Math.max(10, stroke.width * scale * 3.2);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread));
  ctx.lineTo(x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread));
  ctx.closePath();
  ctx.fillStyle = stroke.color;
  ctx.fill();
}

/**
 * Blur draws the screenshot back over itself through a CSS filter, which is
 * why it needs the frozen image rather than just the ink layer. The source
 * region is padded and then clipped, or the filter would sample past the edge
 * and leave a soft halo instead of a hard-edged patch.
 */
function blur(ctx: CanvasRenderingContext2D, stroke: Stroke, scale: number) {
  if (!rect || stroke.points.length < 2) return;
  const area = span(stroke.points[0], stroke.points[stroke.points.length - 1]);
  if (area.w < 2 || area.h < 2) return;

  const pad = 24;
  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x * scale, area.y * scale, area.w * scale, area.h * scale);
  ctx.clip();
  ctx.filter = `blur(${Math.max(6, stroke.width * 2.5)}px)`;
  ctx.drawImage(
    frozen,
    (rect.x + area.x - pad) * scale,
    (rect.y + area.y - pad) * scale,
    (area.w + pad * 2) * scale,
    (area.h + pad * 2) * scale,
    (area.x - pad) * scale,
    (area.y - pad) * scale,
    (area.w + pad * 2) * scale,
    (area.h + pad * 2) * scale,
  );
  ctx.restore();
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

    if (stroke.tool === "blur") {
      blur(ctx, stroke, scale);
    } else if (stroke.tool === "arrow" && stroke.points.length >= 2) {
      arrow(ctx, stroke, scale);
    } else if (stroke.tool === "rect" && stroke.points.length >= 2) {
      const area = span(stroke.points[0], stroke.points[stroke.points.length - 1]);
      ctx.strokeRect(area.x * scale, area.y * scale, area.w * scale, area.h * scale);
    } else {
      strokePath(ctx, stroke, scale);
    }
  }
}

/** Pointer position relative to the selection, in CSS pixels. */
function penPoint(e: MouseEvent): Point {
  const box = ink.getBoundingClientRect();
  return { x: e.clientX - box.left, y: e.clientY - box.top };
}

ink.addEventListener("mousedown", (e) => {
  e.stopPropagation();
  drawing = {
    tool,
    color: settings.pen_color,
    width: settings.pen_width,
    points: [penPoint(e)],
  };
  repaint();
});

ink.addEventListener("mousemove", (e) => {
  if (!drawing) return;
  const pt = penPoint(e);
  // Shapes only need their two corners; freehand keeps every point.
  if (drawing.tool === "pen") drawing.points.push(pt);
  else drawing.points = [drawing.points[0], pt];
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
  el("tool-picker").replaceChildren(
    ...TOOLS.map(({ key, glyph, title }) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tool";
      b.textContent = glyph;
      b.title = title;
      b.dataset.tool = key;
      b.addEventListener("click", () => {
        tool = key;
        markTools();
      });
      return b;
    }),
  );

  el("swatches").replaceChildren(
    ...PEN_COLORS.map((color) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.style.background = color;
      b.title = color;
      b.dataset.color = color;
      b.addEventListener("click", () => {
        settings.pen_color = color;
        void putSettings(settings);
        markTools();
      });
      return b;
    }),
  );

  el("widths").replaceChildren(
    ...PEN_WIDTHS.map((width) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "width";
      b.title = `${width} px`;
      b.dataset.width = String(width);
      const dot = document.createElement("span");
      dot.style.width = `${width + 2}px`;
      dot.style.height = `${width + 2}px`;
      b.append(dot);
      b.addEventListener("click", () => {
        settings.pen_width = width;
        void putSettings(settings);
        markTools();
      });
      return b;
    }),
  );
}

function markTools() {
  for (const b of document.querySelectorAll<HTMLElement>(".tool")) {
    b.classList.toggle("on", b.dataset.tool === tool);
  }
  // Colour means nothing to the blur tool, so stop offering it.
  el("swatches").classList.toggle("dimmed", tool === "blur");
  for (const b of document.querySelectorAll<HTMLElement>(".swatch")) {
    b.classList.toggle("on", b.dataset.color === settings.pen_color);
  }
  for (const b of document.querySelectorAll<HTMLElement>(".width")) {
    b.classList.toggle("on", Number(b.dataset.width) === settings.pen_width);
    (b.firstElementChild as HTMLElement).style.background =
      tool === "blur" ? "var(--dim)" : settings.pen_color;
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

function startComposing(r: Rect) {
  rect = r;
  composing = true;
  document.body.classList.remove("selecting");
  document.body.classList.add("composing");
  drawSelection(r);
  composer.hidden = false;
  placeCanvas(r);
  markTools();
  placeComposer(r);
  noteText.focus();
}

/** Annotate the whole frozen screen: sometimes what is wrong is the relation
 *  between two distant places, not a single box. */
function wholeScreen() {
  if (composing) return;
  startComposing({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
}

el("btn-full").addEventListener("click", wholeScreen);

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
  rect = span(origin, { x: e.clientX, y: e.clientY });
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
  startComposing(rect);
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
  } else if (e.key === "Enter" && !composing) {
    e.preventDefault();
    wholeScreen();
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
