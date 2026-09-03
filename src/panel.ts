import { convertFileSrc } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  addClipboardNote, addTextNote, applyTheme, archiveNotes, beginCapture, buildMarkdown,
  clearNotes, DEFAULT_TEMPLATE, deleteNote, getSettings, listArchives, listNotes,
  openArchive, openBaseDir, PRIORITIES, putSettings, reorderNotes, setPriority,
  startupWarnings, updateNote, type Note, type Settings,
} from "./api";

/** Wanted size on a machine that has never run this before. */
const WANTED = { width: 760, height: 1140 };
const MIN = { width: 320, height: 320 };
const COLLAPSED = new LogicalSize(210, 44);

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const pill = el("pill");
const panel = el("panel");
const settingsSheet = el("settings");
const archives = el("archives");
const archiveList = el<HTMLUListElement>("archive-list");
const notesList = el<HTMLUListElement>("notes");
const empty = el("empty");
const quick = el<HTMLTextAreaElement>("quick");
const btnCopy = el<HTMLButtonElement>("btn-copy");
const btnArchive = el<HTMLButtonElement>("btn-archive");
const toastEl = el("toast");
const win = getCurrentWindow();

let notes: Note[] = [];
/** Ticked notes; empty means "copy everything". UI state only. */
const picked = new Set<string>();
let settings: Settings;
let collapsed = false;
let toastTimer = 0;
let saveSizeTimer = 0;

function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 2600);
}

// ------------------------------------------------------------- size & opacity

/**
 * The remembered size, or a first-run default trimmed to fit. Asking for
 * 760x1140 on a 1080p screen would put the footer off-screen, so the wanted
 * size is capped against the monitor's real work area.
 */
async function expandedSize(): Promise<LogicalSize> {
  if (settings.width && settings.height) {
    return new LogicalSize(settings.width, settings.height);
  }
  const monitor = await currentMonitor();
  if (!monitor) return new LogicalSize(WANTED.width, WANTED.height);

  const scale = monitor.scaleFactor || 1;
  const available = { w: monitor.size.width / scale, h: monitor.size.height / scale };
  return new LogicalSize(
    Math.max(MIN.width, Math.min(WANTED.width, Math.round(available.w * 0.92))),
    Math.max(MIN.height, Math.min(WANTED.height, Math.round(available.h * 0.88))),
  );
}

function applyOpacity() {
  document.documentElement.style.setProperty("--panel-opacity", String(settings.opacity));
}

/** Resizing fires continuously, so only the size it settles at is persisted. */
function rememberSize() {
  clearTimeout(saveSizeTimer);
  saveSizeTimer = window.setTimeout(async () => {
    if (collapsed) return;
    const size = (await win.innerSize()).toLogical(await win.scaleFactor());
    if (size.width < MIN.width || size.height < MIN.height) return;
    settings.width = Math.round(size.width);
    settings.height = Math.round(size.height);
    await putSettings(settings);
  }, 500);
}

function render() {
  el("count").textContent = String(notes.length);
  el("pill-count").textContent = String(notes.length);
  empty.hidden = notes.length > 0;
  btnCopy.disabled = notes.length === 0;
  btnArchive.disabled = notes.length === 0;

  // Notes can be deleted while ticked; never let a stale id reach the copy.
  const live = new Set(notes.map((n) => n.id));
  for (const id of [...picked]) if (!live.has(id)) picked.delete(id);
  btnCopy.textContent = picked.size ? `Copiar ${picked.size}` : "Copiar todo";

  notesList.replaceChildren(
    ...notes.map((note, i) => {
      const li = document.createElement("li");
      li.className = "note";
      li.dataset.id = note.id;

      const pick = document.createElement("input");
      pick.type = "checkbox";
      pick.className = "note-pick";
      pick.checked = picked.has(note.id);
      pick.title = "Incluir solo esta en la copia";
      pick.addEventListener("change", () => {
        if (pick.checked) picked.add(note.id);
        else picked.delete(note.id);
        btnCopy.textContent = picked.size ? `Copiar ${picked.size}` : "Copiar todo";
      });
      li.append(pick);

      const idx = document.createElement("span");
      idx.className = "note-idx";
      idx.textContent = String(i + 1);
      idx.title = "Arrastra para reordenar";
      // The row becomes draggable only while the handle is held, so selecting
      // text inside the note still works.
      idx.addEventListener("mousedown", () => (li.draggable = true));
      li.addEventListener("dragend", () => {
        li.draggable = false;
        clearDropMarks();
      });
      li.append(idx);

      if (note.image) {
        const img = document.createElement("img");
        img.className = "note-thumb";
        img.src = convertFileSrc(note.image);
        img.title = "Abrir la captura";
        img.addEventListener("click", () => openPath(note.image!));
        li.append(img);
      }

      const body = document.createElement("div");
      body.className = "note-body";
      const text = document.createElement("textarea");
      text.className = "note-text";
      text.rows = 1;
      text.value = note.text;
      text.placeholder = "(sin texto)";
      // Grow to fit so nothing hides behind a scrollbar.
      const autosize = () => {
        text.style.height = "auto";
        text.style.height = `${text.scrollHeight}px`;
      };
      text.addEventListener("input", autosize);
      text.addEventListener("change", () => updateNote(note.id, text.value));
      text.addEventListener("blur", () => updateNote(note.id, text.value));
      body.append(text);

      if (note.context) {
        const ctx = document.createElement("span");
        ctx.className = "note-context";
        ctx.textContent = note.context;
        ctx.title = note.context;
        body.append(ctx);
      }
      li.append(body);
      queueMicrotask(autosize);

      const prio = document.createElement("button");
      prio.className = "note-prio";
      prio.dataset.priority = note.priority;
      prio.textContent = PRIORITIES.find((p) => p.key === note.priority)?.label ?? "normal";
      prio.title = "Cambiar prioridad";
      prio.addEventListener("click", async () => {
        const at = PRIORITIES.findIndex((p) => p.key === note.priority);
        const next = PRIORITIES[(at + 1) % PRIORITIES.length].key;
        notes = await setPriority(note.id, next);
        render();
      });
      li.append(prio);

      const del = document.createElement("button");
      del.className = "note-del";
      del.textContent = "✕";
      del.title = "Borrar anotación";
      del.addEventListener("click", async () => {
        notes = await deleteNote(note.id);
        render();
      });
      li.append(del);

      return li;
    }),
  );
}

// -------------------------------------------------------------- drag to order

/** The order you spot things is not the order you want them fixed in. */
let dragId: string | null = null;

function clearDropMarks() {
  for (const li of notesList.children) {
    li.classList.remove("drop-above", "drop-below", "dragging");
  }
}

notesList.addEventListener("dragstart", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>("li.note");
  if (!li) return;
  dragId = li.dataset.id ?? null;
  li.classList.add("dragging");
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
});

notesList.addEventListener("dragover", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>("li.note");
  if (!li || !dragId || li.dataset.id === dragId) return;
  e.preventDefault();
  const box = li.getBoundingClientRect();
  const above = e.clientY < box.top + box.height / 2;
  li.classList.toggle("drop-above", above);
  li.classList.toggle("drop-below", !above);
});

notesList.addEventListener("dragleave", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>("li.note");
  li?.classList.remove("drop-above", "drop-below");
});

notesList.addEventListener("drop", async (e) => {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>("li.note");
  const targetId = li?.dataset.id;
  if (!li || !dragId || !targetId || targetId === dragId) return;
  e.preventDefault();

  const box = li.getBoundingClientRect();
  const above = e.clientY < box.top + box.height / 2;

  const ids = notes.map((n) => n.id).filter((id) => id !== dragId);
  const at = ids.indexOf(targetId);
  ids.splice(above ? at : at + 1, 0, dragId);

  dragId = null;
  clearDropMarks();
  notes = await reorderNotes(ids);
  render();
});

async function setCollapsed(next: boolean) {
  collapsed = next;
  pill.hidden = !next;
  panel.hidden = next;
  // Expanding restores the size it was left at, not a hardcoded one.
  await win.setSize(next ? COLLAPSED : await expandedSize());
}

async function submitQuick() {
  const text = quick.value.trim();
  if (!text) return;
  notes = await addTextNote(text);
  quick.value = "";
  render();
  quick.focus();
}

el("btn-collapse").addEventListener("click", () => setCollapsed(true));
el("btn-expand").addEventListener("click", () => setCollapsed(false));
el("btn-shot").addEventListener("click", () => beginCapture());
el("btn-folder").addEventListener("click", () => openBaseDir());
/** Reopening a saved list is the other half of saving one; without it the .md
 *  files would be a dead end. */
async function showArchives() {
  const saved = await listArchives();
  el("archives-empty").hidden = saved.length > 0;
  archiveList.replaceChildren(
    ...saved.map((a) => {
      const li = document.createElement("li");
      li.className = "archive";
      li.title = "Abrir estas notas";

      const main = document.createElement("div");
      main.className = "archive-main";
      const label = document.createElement("span");
      label.className = "archive-label";
      label.textContent = a.label;
      const preview = document.createElement("span");
      preview.className = "archive-preview";
      preview.textContent = a.preview;
      main.append(label, preview);

      const count = document.createElement("span");
      count.className = "archive-count";
      count.textContent = String(a.count);

      li.append(main, count);
      li.addEventListener("click", () => openBatch(a.id));
      return li;
    }),
  );
  archives.hidden = false;
}

/** The backend refuses to overwrite a non-empty list, so save it first. */
async function openBatch(id: string) {
  if (notes.length) {
    const msg = `Se guardarán las ${notes.length} notas actuales antes de abrir. ¿Continuar?`;
    if (!confirm(msg)) return;
    await archiveNotes();
  }
  try {
    notes = await openArchive(id);
    render();
    archives.hidden = true;
    toast(`${notes.length} notas cargadas`);
  } catch (e) {
    toast(String(e));
  }
}

el("btn-archives").addEventListener("click", showArchives);
el("btn-archives-back").addEventListener("click", () => (archives.hidden = true));
el("btn-archives-folder").addEventListener("click", () => openBaseDir());
el("btn-settings").addEventListener("click", () => (settingsSheet.hidden = false));
el("btn-settings-back").addEventListener("click", () => (settingsSheet.hidden = true));
el("btn-quick").addEventListener("click", submitQuick);

// Enter inside a three-line box has to mean "new line", so the button and
// Ctrl+Enter are what submit.
quick.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    submitQuick();
  }
});

el("btn-copy").addEventListener("click", async () => {
  const ids = picked.size ? [...picked] : null;
  await writeText(await buildMarkdown(ids));
  const n = ids ? ids.length : notes.length;
  toast(`${n} ${n === 1 ? "anotación copiada" : "anotaciones copiadas"}`);
});

async function pasteImage() {
  try {
    notes = await addClipboardNote(quick.value.trim());
    quick.value = "";
    render();
    toast("Imagen pegada");
  } catch (e) {
    toast(String(e));
  }
}

el("btn-paste").addEventListener("click", pasteImage);

// Ctrl+V with an image on the clipboard becomes a note; plain text still
// pastes into whatever field has focus.
document.addEventListener("paste", (e) => {
  const hasImage = [...(e.clipboardData?.items ?? [])].some((i) => i.type.startsWith("image/"));
  if (!hasImage) return;
  e.preventDefault();
  void pasteImage();
});

btnArchive.addEventListener("click", async () => {
  try {
    const path = await archiveNotes();
    notes = await listNotes();
    render();
    toast(`Guardado en ${path.replace(/^.*[\\/]guardadas[\\/]/, "guardadas\\")}`);
  } catch (e) {
    toast(String(e));
  }
});

el("btn-clear").addEventListener("click", async () => {
  const withShots = notes.filter((n) => n.image).length;
  const detail = withShots ? ` y sus ${withShots} capturas` : "";
  if (notes.length && !confirm(`¿Borrar las ${notes.length} anotaciones${detail}?`)) return;
  notes = await clearNotes();
  render();
});

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="theme"]')) {
  radio.addEventListener("change", async () => {
    settings.theme = radio.value;
    applyTheme(settings.theme);
    await putSettings(settings);
  });
}

const opacity = el<HTMLInputElement>("opacity");
const opacityOut = el<HTMLOutputElement>("opacity-out");

opacity.addEventListener("input", () => {
  settings.opacity = Number(opacity.value) / 100;
  opacityOut.value = `${opacity.value}%`;
  applyOpacity();
});
// Dragging a slider fires per pixel; only write once it is let go.
opacity.addEventListener("change", () => void putSettings(settings));

const template = el<HTMLTextAreaElement>("template");

template.addEventListener("change", () => {
  settings.template = template.value;
  void putSettings(settings);
});

el("btn-template-reset").addEventListener("click", () => {
  settings.template = DEFAULT_TEMPLATE;
  template.value = DEFAULT_TEMPLATE;
  void putSettings(settings);
});

win.onResized(rememberSize);

// The Rust side owns the note list; it tells us whenever a capture lands.
listen<Note[]>("notes-changed", (e) => {
  notes = e.payload;
  render();
  if (collapsed) toast(`${notes.length} anotaciones`);
});

settings = await getSettings();
applyTheme(settings.theme);
applyOpacity();

const chosen = document.querySelector<HTMLInputElement>(
  `input[name="theme"][value="${settings.theme}"]`,
);
if (chosen) chosen.checked = true;
opacity.value = String(Math.round(settings.opacity * 100));
opacityOut.value = `${opacity.value}%`;
template.value = settings.template;

notes = await listNotes();
render();
await setCollapsed(false);

// A shortcut another program already owns fails silently otherwise.
const warnings = await startupWarnings();
if (warnings.length) toast(warnings.join(" · "));
