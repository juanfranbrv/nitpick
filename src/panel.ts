import { convertFileSrc } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  addClipboardNote, addTextNote, applyTheme, archiveNotes, beginCapture, buildMarkdown,
  clearNotes, DEFAULT_TEMPLATE, deleteNote, getSettings, listArchives, listNotes,
  openArchive, openBaseDir, PRIORITIES, putSettings, quitApp, reorderNotes, setPriority,
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

// ----------------------------------------------------------------- ask first

const modal = el("modal");
const modalOk = el<HTMLButtonElement>("modal-ok");
const modalCancel = el<HTMLButtonElement>("modal-cancel");

/**
 * Stands in for the webview's native `confirm()`, which cannot be styled and
 * labels itself with the page's origin.
 *
 * Enter and Space need no handling: whichever button holds focus answers them
 * natively. A destructive action focuses Cancel, so it is never one stray
 * Enter away.
 */
function ask(opts: {
  title: string;
  body: string;
  confirm?: string;
  danger?: boolean;
}): Promise<boolean> {
  el("modal-title").textContent = opts.title;
  el("modal-body").textContent = opts.body;
  modalOk.textContent = opts.confirm ?? "Aceptar";
  modalOk.classList.toggle("danger", opts.danger === true);
  modal.hidden = false;

  const previous = document.activeElement as HTMLElement | null;
  (opts.danger ? modalCancel : modalOk).focus();

  return new Promise((resolve) => {
    const listeners = new AbortController();
    const close = (answer: boolean) => {
      listeners.abort();
      modal.hidden = true;
      previous?.focus();
      resolve(answer);
    };
    const on = { signal: listeners.signal };

    modalOk.addEventListener("click", () => close(true), on);
    modalCancel.addEventListener("click", () => close(false), on);
    // Clicking the backdrop, but not the card itself, dismisses.
    modal.addEventListener("mousedown", (e) => e.target === modal && close(false), on);
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        close(false);
      },
      { ...on, capture: true },
    );
  });
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
      idx.addEventListener("mousedown", (e) => startDrag(e, note.id, li));
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
      text.addEventListener("input", () => autosize(text));
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

  // Measured only once the rows are laid out. Sizing a textarea in a
  // microtask read a scrollHeight from before the thumbnail and the priority
  // chip had taken their width, so every note came out several lines too tall.
  requestAnimationFrame(() => {
    for (const text of notesList.querySelectorAll<HTMLTextAreaElement>(".note-text")) {
      autosize(text);
    }
  });
}

/** Grow a note's box to fit its text, so nothing hides behind a scrollbar. */
function autosize(text: HTMLTextAreaElement) {
  text.style.height = "auto";
  text.style.height = `${text.scrollHeight}px`;
}

// -------------------------------------------------------------- drag to order

/**
 * Reordering runs on plain mouse events, not HTML5 drag and drop.
 *
 * The webview registers an OS-level drop target so it can accept dropped
 * files, and that swallows drags started inside the page — dragstart fires and
 * nothing else follows. Mouse events sidestep the whole mechanism, and give a
 * drop indicator that tracks the pointer instead of a ghost image.
 *
 * The order you spot things in is not the order you want them fixed in.
 */
let drag: { id: string; row: HTMLLIElement } | null = null;
let dropAt: { id: string; above: boolean } | null = null;
let autoScroll = 0;

function clearDropMarks() {
  for (const row of notesList.children) {
    row.classList.remove("drop-above", "drop-below", "dragging");
  }
}

function startDrag(e: MouseEvent, id: string, row: HTMLLIElement) {
  if (e.button !== 0) return;
  // Stop the handle's own text from being selected as the pointer moves.
  e.preventDefault();
  drag = { id, row };
  dropAt = null;
  row.classList.add("dragging");
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", endDrag, { once: true });
}

function onDragMove(e: MouseEvent) {
  if (!drag) return;
  const rows = [...notesList.children] as HTMLLIElement[];

  // A long list has to scroll while you drag, or the far end is unreachable.
  const list = notesList.getBoundingClientRect();
  const edge = 28;
  if (e.clientY < list.top + edge) autoScroll = -8;
  else if (e.clientY > list.bottom - edge) autoScroll = 8;
  else autoScroll = 0;
  if (autoScroll) notesList.scrollTop += autoScroll;

  dropAt = null;
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    if (e.clientY < box.bottom) {
      dropAt = { id: row.dataset.id!, above: e.clientY < box.top + box.height / 2 };
      break;
    }
  }
  // Past the last row means "put it at the end".
  if (!dropAt && rows.length) {
    dropAt = { id: rows[rows.length - 1].dataset.id!, above: false };
  }

  clearDropMarks();
  drag.row.classList.add("dragging");
  if (dropAt && dropAt.id !== drag.id) {
    const target = rows.find((r) => r.dataset.id === dropAt!.id);
    target?.classList.add(dropAt.above ? "drop-above" : "drop-below");
  }
}

async function endDrag() {
  document.removeEventListener("mousemove", onDragMove);
  const moved = drag;
  const target = dropAt;
  drag = null;
  dropAt = null;
  autoScroll = 0;
  clearDropMarks();
  if (!moved || !target || target.id === moved.id) return;

  const ids = notes.map((n) => n.id).filter((id) => id !== moved.id);
  const at = ids.indexOf(target.id);
  if (at < 0) return;
  ids.splice(target.above ? at : at + 1, 0, moved.id);

  notes = await reorderNotes(ids);
  render();
}

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
// Nothing is lost on exit: the list is already on disk.
el("btn-quit").addEventListener("click", () => quitApp());
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
    const ok = await ask({
      title: "Abrir otras notas",
      body: `Se guardarán antes las ${notes.length} notas de la lista actual, con sus capturas. No se pierde nada.`,
      confirm: "Guardar y abrir",
    });
    if (!ok) return;
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
  if (!notes.length) return;
  const withShots = notes.filter((n) => n.image).length;
  const detail = withShots ? ` y sus ${withShots} capturas` : "";
  const ok = await ask({
    title: "Vaciar las notas",
    body: `Se borrarán ${notes.length} anotaciones${detail}. Esto no se puede deshacer: usa «Guardar notas» si quieres conservarlas.`,
    confirm: "Borrar",
    danger: true,
  });
  if (!ok) return;
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

const excludeCapture = el<HTMLInputElement>("exclude-capture");

excludeCapture.addEventListener("change", async () => {
  settings.exclude_from_capture = excludeCapture.checked;
  await putSettings(settings);
  toast(
    excludeCapture.checked
      ? "El panel queda fuera de las capturas"
      : "El panel se ocultará durante cada captura",
  );
});

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
excludeCapture.checked = settings.exclude_from_capture;

notes = await listNotes();
render();
await setCollapsed(false);

// A shortcut another program already owns fails silently otherwise.
const warnings = await startupWarnings();
if (warnings.length) toast(warnings.join(" · "));
