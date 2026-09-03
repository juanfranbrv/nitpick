import { invoke } from "@tauri-apps/api/core";

export interface Note {
  id: string;
  text: string;
  /** Absolute path to the PNG, or null for a text-only note. */
  image: string | null;
  created_at: string;
  /** One of `PRIORITIES`. */
  priority: string;
  /** Window title and size captured with the screenshot, when known. */
  context: string | null;
}

/** Cycled in this order by the chip on each note. */
export const PRIORITIES = [
  { key: "normal", label: "normal" },
  { key: "blocker", label: "bloqueante" },
  { key: "minor", label: "menor" },
];

export interface Archive {
  id: string;
  /** The session timestamp, formatted for display. */
  label: string;
  count: number;
  preview: string;
}

export interface Settings {
  /** "dark", "light" or "system". */
  theme: string;
  /** 0.2 to 1. Applied as CSS opacity over the transparent window. */
  opacity: number;
  /** Logical size the panel was last left at; null until it is first resized. */
  width: number | null;
  height: number | null;
  pen_color: string;
  pen_width: number;
  /** Wrapper for the copied text. `{{notas}}`, `{{total}}`, `{{fecha}}`. */
  template: string;
}

export const DEFAULT_TEMPLATE = "# Anotaciones ({{total}}) - {{fecha}}\n{{notas}}";

/** Sent by the backend when a fresh screenshot is waiting for the selector. */
export interface CaptureReady {
  version: number;
  width: number;
  height: number;
}

/** Selection expressed as fractions of the frozen image, so DPI never matters. */
export interface Selection {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const listNotes = () => invoke<Note[]>("list_notes");
export const addTextNote = (text: string) => invoke<Note[]>("add_text_note", { text });
export const updateNote = (id: string, text: string) => invoke<void>("update_note", { id, text });
export const deleteNote = (id: string) => invoke<Note[]>("delete_note", { id });
export const archiveNotes = () => invoke<string>("archive_notes");
export const listArchives = () => invoke<Archive[]>("list_archives");
export const openArchive = (id: string) => invoke<Note[]>("open_archive", { id });
export const clearNotes = () => invoke<Note[]>("clear_notes");
export const setPriority = (id: string, priority: string) =>
  invoke<Note[]>("set_priority", { id, priority });
export const reorderNotes = (ids: string[]) => invoke<Note[]>("reorder_notes", { ids });
export const addClipboardNote = (text: string) =>
  invoke<Note[]>("add_clipboard_note", { text });

/** `ids` null copies everything; otherwise only those notes. */
export const buildMarkdown = (ids: string[] | null = null) =>
  invoke<string>("build_markdown_for", { ids });
export const beginCapture = () => invoke<void>("begin_capture");
/** `strokes` is a base64 PNG of the marker layer, or null if nothing was drawn. */
export const commitCapture = (sel: Selection, text: string, strokes: string | null) =>
  invoke<void>("commit_capture", { sel, text, strokes });
export const cancelCapture = () => invoke<void>("cancel_capture");
export const currentCapture = () => invoke<CaptureReady | null>("current_capture");
export const openBaseDir = () => invoke<void>("open_base_dir");
export const startupWarnings = () => invoke<string[]>("startup_warnings");
export const getSettings = () => invoke<Settings>("get_settings");
export const putSettings = (settings: Settings) => invoke<Settings>("put_settings", { settings });

/**
 * The frozen screenshot comes from a custom URI scheme backed by memory, not a
 * file. Windows maps custom schemes onto http://<scheme>.localhost.
 */
export const frozenUrl = (version: number) =>
  `http://frozen.localhost/capture.bmp?v=${version}`;

/** "system" means: take the attribute off and let the OS preference win. */
export function applyTheme(theme: string) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

/** Marker palette, covering both dark-on-light and light-on-dark screenshots. */
export const PEN_COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#1c1c1e"];
export const PEN_WIDTHS = [2, 4, 8, 14];
