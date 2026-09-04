#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod win;

use chrono::Local;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::http::{Response, StatusCode};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const OVERLAY: &str = "overlay";
const MAIN: &str = "main";

/// The three priorities, in the order they are cycled through in the panel.
/// Stored as stable keys; `PRIORITY_LABELS` is what reaches the Markdown.
const PRIORITIES: [&str; 3] = ["normal", "blocker", "minor"];
const PRIORITY_LABELS: [(&str, &str); 3] =
    [("normal", ""), ("blocker", "bloqueante"), ("minor", "menor")];

fn priority_label(key: &str) -> &'static str {
    PRIORITY_LABELS.iter().find(|(k, _)| *k == key).map(|(_, l)| *l).unwrap_or("")
}

fn priority_from_label(label: &str) -> String {
    PRIORITY_LABELS
        .iter()
        .find(|(_, l)| !l.is_empty() && *l == label)
        .map(|(k, _)| *k)
        .unwrap_or("normal")
        .to_string()
}

fn default_priority() -> String {
    "normal".into()
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Note {
    id: String,
    text: String,
    /// Absolute path to the PNG, or None for a text-only note.
    image: Option<String>,
    created_at: String,
    /// One of `PRIORITIES`.
    priority: String,
    /// Title and client size of the window that was in front when the capture
    /// was taken. None for notes typed by hand.
    context: Option<String>,
}

impl Default for Note {
    fn default() -> Self {
        Note {
            id: String::new(),
            text: String::new(),
            image: None,
            created_at: String::new(),
            priority: default_priority(),
            context: None,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Session {
    id: String,
    seq: u32,
    notes: Vec<Note>,
}

impl Default for Session {
    fn default() -> Self {
        Session {
            id: Local::now().format("%Y%m%d-%H%M%S").to_string(),
            seq: 0,
            notes: vec![],
        }
    }
}

/// `serde(default)` matters here: it lets a settings.json written by an older
/// version keep the values it does have instead of being discarded wholesale.
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Settings {
    /// "dark", "light" or "system".
    theme: String,
    /// 0.4 to 1.0. Applied as CSS opacity, which works because the window
    /// itself is transparent.
    opacity: f64,
    /// Logical size the panel was last left at. None until it is first resized,
    /// so the initial size can be worked out from the actual screen.
    width: Option<f64>,
    height: Option<f64>,
    /// Keep the panel out of screen captures at the OS level. On by default:
    /// it removes the hide-and-repaint wait and the blink. Off makes the panel
    /// visible to other recorders again, at the cost of hiding it for ~70 ms
    /// on every capture of our own.
    exclude_from_capture: bool,
    pen_color: String,
    pen_width: f64,
    /// Wrapper for the copied text. `{{notas}}` is required; `{{total}}` and
    /// `{{fecha}}` are optional. Different agents respond to different
    /// preambles, so the whole envelope is yours to change.
    template: String,
}

pub const DEFAULT_TEMPLATE: &str = "# Anotaciones ({{total}}) - {{fecha}}\n{{notas}}";

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "dark".into(),
            opacity: 1.0,
            width: None,
            height: None,
            exclude_from_capture: true,
            pen_color: "#ff3b30".into(),
            pen_width: 4.0,
            template: DEFAULT_TEMPLATE.into(),
        }
    }
}

/// Missing or corrupt state falls back to the default rather than refusing to
/// start; nothing here is worth losing the app over.
fn read_json<T: Default + serde::de::DeserializeOwned>(path: PathBuf) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

struct Store {
    base: PathBuf,
    session: Mutex<Session>,
    settings: Mutex<Settings>,
    /// The screen as it looked when the shortcut fired, held in memory for as
    /// long as the selector is open.
    frozen: Mutex<Option<capture::Frozen>>,
    /// What was in front when the shortcut fired, read before our own panel
    /// hides itself and stealing focus makes it unknowable.
    pending_context: Mutex<Option<String>>,
    /// Bumped per capture so the webview cannot reuse the previous bitmap.
    version: AtomicU64,
    capturing: AtomicBool,
    /// True when Windows agreed to keep our windows out of screenshots, which
    /// makes hiding the panel before a capture unnecessary.
    hidden_from_capture: AtomicBool,
    /// Problems worth telling the user about once the panel is up.
    warnings: Mutex<Vec<String>>,
}

impl Store {
    fn session_file(&self) -> PathBuf {
        self.base.join("session.json")
    }

    fn settings_file(&self) -> PathBuf {
        self.base.join("settings.json")
    }

    fn load(base: PathBuf) -> Store {
        Store {
            session: Mutex::new(read_json(base.join("session.json"))),
            settings: Mutex::new(read_json(base.join("settings.json"))),
            base,
            frozen: Mutex::new(None),
            pending_context: Mutex::new(None),
            version: AtomicU64::new(0),
            capturing: AtomicBool::new(false),
            hidden_from_capture: AtomicBool::new(false),
            warnings: Mutex::new(vec![]),
        }
    }

    fn save_session(&self) {
        let session = self.session.lock().unwrap();
        let _ = std::fs::create_dir_all(&self.base);
        if let Ok(json) = serde_json::to_string_pretty(&*session) {
            let _ = std::fs::write(self.session_file(), json);
        }
    }

    fn save_settings(&self) {
        let settings = self.settings.lock().unwrap();
        let _ = std::fs::create_dir_all(&self.base);
        if let Ok(json) = serde_json::to_string_pretty(&*settings) {
            let _ = std::fs::write(self.settings_file(), json);
        }
    }

    /// The clipboard payload, wrapped in the user's template. `only` limits it
    /// to a subset of note ids.
    fn markdown(&self, only: Option<&[String]>) -> String {
        let notes = &self.session.lock().unwrap().notes;
        let picked: Vec<Note> = match only {
            Some(ids) => notes.iter().filter(|n| ids.contains(&n.id)).cloned().collect(),
            None => notes.clone(),
        };
        let template = self.settings.lock().unwrap().template.clone();
        apply_template(&template, &picked)
    }
}

/// Plain text carrying absolute image paths: the only shape that fits in one
/// clipboard slot and still lets a local agent open every screenshot. It is
/// also the archive format, so `parse_archive` has to round-trip it.
fn render_notes(notes: &[Note]) -> String {
    let mut out = String::new();
    for (i, note) in notes.iter().enumerate() {
        let label = priority_label(&note.priority);
        if label.is_empty() {
            out.push_str(&format!("\n## {}\n", i + 1));
        } else {
            out.push_str(&format!("\n## {} · {label}\n", i + 1));
        }

        let text = note.text.trim();
        if !text.is_empty() {
            out.push_str(text);
            out.push('\n');
        }
        if let Some(ctx) = &note.context {
            out.push_str(&format!("Contexto: {ctx}\n"));
        }
        if let Some(path) = &note.image {
            out.push_str(&format!("Captura: {path}\n"));
        }
    }
    out
}

/// A malformed template still has to produce usable output, so a missing
/// `{{notas}}` gets the notes appended rather than silently dropped.
fn apply_template(template: &str, notes: &[Note]) -> String {
    let body = render_notes(notes);
    let filled = template
        .replace("{{total}}", &notes.len().to_string())
        .replace("{{fecha}}", &Local::now().format("%Y-%m-%d %H:%M").to_string());

    if filled.contains("{{notas}}") {
        filled.replace("{{notas}}", &body)
    } else {
        format!("{filled}\n{body}")
    }
}

/// Put the capture-exclusion setting into effect and record whether it took,
/// which is what decides between the fast path and hide-and-wait.
fn apply_capture_exclusion(app: &AppHandle) -> bool {
    let store = app.state::<Store>();
    let wanted = store.settings.lock().unwrap().exclude_from_capture;

    let applied = [MAIN, OVERLAY]
        .iter()
        .filter_map(|label| app.get_webview_window(label))
        .filter_map(|w| w.hwnd().ok())
        .all(|h| win::set_capture_exclusion(h.0 as isize, wanted));

    let effective = wanted && applied;
    store.hidden_from_capture.store(effective, Ordering::SeqCst);
    effective
}

/// Push the current list to the panel so it never has to poll.
fn broadcast(app: &AppHandle) {
    let notes = app.state::<Store>().session.lock().unwrap().notes.clone();
    let _ = app.emit("notes-changed", notes);
}

// ---------------------------------------------------------------- capture flow

#[derive(Clone, Serialize)]
struct CaptureReady {
    version: u64,
    width: u32,
    height: u32,
}

/// Hide the panel, freeze the screen, then bring up the selector over it.
fn start_capture(app: AppHandle) {
    let store = app.state::<Store>();
    if store.capturing.swap(true, Ordering::SeqCst) {
        return; // A capture is already in progress.
    }
    let started = Instant::now();

    let main = app.get_webview_window(MAIN);

    // Read the foreground window first: hiding our panel and then showing the
    // selector both change what is in front.
    let ours: Vec<isize> = [MAIN, OVERLAY]
        .iter()
        .filter_map(|label| app.get_webview_window(label))
        .filter_map(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .collect();
    *store.pending_context.lock().unwrap() = win::foreground(&ours);

    // When Windows keeps our windows out of screenshots there is nothing to
    // hide from, so the panel stays put: no blink, and no waiting for the
    // compositor. Otherwise fall back to hiding it and giving the screen time
    // to repaint, or the panel lands inside its own capture.
    let hide_first = !store.hidden_from_capture.load(Ordering::SeqCst);
    if hide_first {
        if let Some(w) = &main {
            let _ = w.hide();
        }
        std::thread::sleep(Duration::from_millis(70));
    }

    let ready = match capture::freeze() {
        Ok(frozen) => {
            let ready = CaptureReady {
                version: store.version.fetch_add(1, Ordering::SeqCst) + 1,
                width: frozen.width(),
                height: frozen.height(),
            };
            *store.frozen.lock().unwrap() = Some(frozen);
            ready
        }
        Err(e) => {
            eprintln!("captura fallida: {e}");
            store.capturing.store(false, Ordering::SeqCst);
            if let Some(w) = &main {
                let _ = w.show();
            }
            return;
        }
    };

    let (origin_x, origin_y) = {
        let guard = store.frozen.lock().unwrap();
        let frozen = guard.as_ref().unwrap();
        (frozen.origin_x, frozen.origin_y)
    };

    // The overlay window is built once at startup and reused; creating a
    // webview per capture was the other half of the lag.
    match app.get_webview_window(OVERLAY) {
        Some(win) => {
            let _ = win.set_position(PhysicalPosition::new(origin_x, origin_y));
            let _ = win.set_size(PhysicalSize::new(ready.width, ready.height));
            let _ = win.emit_to(OVERLAY, "capture-ready", ready);
            let _ = win.show();
            let _ = win.set_focus();
            eprintln!("captura lista en {} ms", started.elapsed().as_millis());
        }
        None => {
            eprintln!("la ventana de selección no existe");
            store.capturing.store(false, Ordering::SeqCst);
            if let Some(w) = &main {
                let _ = w.show();
            }
        }
    }
}

fn end_capture(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.hide();
    }
    let store = app.state::<Store>();
    // Free the desktop-sized bitmap as soon as the selector is gone.
    *store.frozen.lock().unwrap() = None;
    store.capturing.store(false, Ordering::SeqCst);

    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[derive(Deserialize)]
struct Selection {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

// ------------------------------------------------------------------- commands

#[tauri::command]
fn begin_capture(app: AppHandle) {
    std::thread::spawn(move || start_capture(app));
}

/// Fallback for the selector: if it finished loading after the event was
/// already emitted, it can still ask what is waiting for it.
#[tauri::command]
fn current_capture(store: State<Store>) -> Option<CaptureReady> {
    let guard = store.frozen.lock().unwrap();
    guard.as_ref().map(|f| CaptureReady {
        version: store.version.load(Ordering::SeqCst),
        width: f.width(),
        height: f.height(),
    })
}

#[tauri::command]
fn cancel_capture(app: AppHandle) {
    end_capture(&app);
}

/// `strokes` is a base64 PNG of the marker layer, drawn by the selector at the
/// crop's exact pixel size. None when nothing was drawn.
#[tauri::command]
fn commit_capture(
    app: AppHandle,
    sel: Selection,
    text: String,
    strokes: Option<String>,
) -> Result<(), String> {
    let strokes = match strokes {
        Some(b64) => Some(
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64)
                .map_err(|e| format!("trazos ilegibles: {e}"))?,
        ),
        None => None,
    };
    {
        let store = app.state::<Store>();
        let guard = store.frozen.lock().unwrap();
        let frozen = guard.as_ref().ok_or("no hay captura activa")?;
        let (fw, fh) = (frozen.width(), frozen.height());

        // The selector sends fractions of the image, so display scaling never
        // enters the arithmetic.
        let x = (sel.x * fw as f64).round().clamp(0.0, (fw - 1) as f64) as u32;
        let y = (sel.y * fh as f64).round().clamp(0.0, (fh - 1) as f64) as u32;
        let w = ((sel.w * fw as f64).round() as u32).clamp(1, fw - x);
        let h = ((sel.h * fh as f64).round() as u32).clamp(1, fh - y);

        let (seq, session_id) = {
            let mut session = store.session.lock().unwrap();
            session.seq += 1;
            (session.seq, session.id.clone())
        };
        let dest = store
            .base
            .join("capturas")
            .join(&session_id)
            .join(format!("{seq:02}.png"));
        capture::crop_to_png(&frozen.image, &dest, x, y, w, h, strokes.as_deref())?;

        store.session.lock().unwrap().notes.push(Note {
            id: format!("n{seq:03}"),
            text,
            image: Some(dest.to_string_lossy().into_owned()),
            created_at: Local::now().format("%Y-%m-%d %H:%M").to_string(),
            context: store.pending_context.lock().unwrap().clone(),
            ..Note::default()
        });
        store.save_session();
    }
    end_capture(&app);
    broadcast(&app);
    Ok(())
}

#[tauri::command]
fn startup_warnings(store: State<Store>) -> Vec<String> {
    store.warnings.lock().unwrap().clone()
}

#[tauri::command]
fn list_notes(store: State<Store>) -> Vec<Note> {
    store.session.lock().unwrap().notes.clone()
}

#[tauri::command]
fn add_text_note(store: State<Store>, text: String) -> Vec<Note> {
    {
        let mut session = store.session.lock().unwrap();
        session.seq += 1;
        let seq = session.seq;
        session.notes.push(Note {
            id: format!("n{seq:03}"),
            text,
            created_at: Local::now().format("%Y-%m-%d %H:%M").to_string(),
            ..Note::default()
        });
    }
    store.save_session();
    store.session.lock().unwrap().notes.clone()
}

/// Paste an image sitting in the clipboard as a new note — for shots taken
/// with Win+Shift+S, or ones someone else sent you.
#[tauri::command]
fn add_clipboard_note(
    app: AppHandle,
    store: State<Store>,
    text: String,
) -> Result<Vec<Note>, String> {
    let image = app
        .clipboard()
        .read_image()
        .map_err(|_| "no hay ninguna imagen en el portapapeles".to_string())?;

    let rgba = xcap::image::RgbaImage::from_raw(image.width(), image.height(), image.rgba().to_vec())
        .ok_or("la imagen del portapapeles no se pudo leer")?;

    let (seq, session_id) = {
        let mut session = store.session.lock().unwrap();
        session.seq += 1;
        (session.seq, session.id.clone())
    };
    let dest = store
        .base
        .join("capturas")
        .join(&session_id)
        .join(format!("{seq:02}.png"));
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    rgba.save(&dest).map_err(|e| format!("no se pudo guardar la imagen: {e}"))?;

    store.session.lock().unwrap().notes.push(Note {
        id: format!("n{seq:03}"),
        text,
        image: Some(dest.to_string_lossy().into_owned()),
        created_at: Local::now().format("%Y-%m-%d %H:%M").to_string(),
        ..Note::default()
    });
    store.save_session();
    Ok(store.session.lock().unwrap().notes.clone())
}

#[tauri::command]
fn set_priority(store: State<Store>, id: String, priority: String) -> Vec<Note> {
    {
        let mut session = store.session.lock().unwrap();
        if let Some(note) = session.notes.iter_mut().find(|n| n.id == id) {
            // Reject anything the panel did not send us.
            if PRIORITIES.contains(&priority.as_str()) {
                note.priority = priority;
            }
        }
    }
    store.save_session();
    store.session.lock().unwrap().notes.clone()
}

/// Reorder to match `ids`. Anything missing from the list keeps its relative
/// order at the end, so a stale panel can never drop a note.
#[tauri::command]
fn reorder_notes(store: State<Store>, ids: Vec<String>) -> Vec<Note> {
    {
        let mut session = store.session.lock().unwrap();
        let mut remaining = std::mem::take(&mut session.notes);
        let mut ordered = Vec::with_capacity(remaining.len());

        for id in &ids {
            if let Some(pos) = remaining.iter().position(|n| &n.id == id) {
                ordered.push(remaining.remove(pos));
            }
        }
        ordered.extend(remaining);
        session.notes = ordered;
    }
    store.save_session();
    store.session.lock().unwrap().notes.clone()
}

#[tauri::command]
fn update_note(store: State<Store>, id: String, text: String) {
    {
        let mut session = store.session.lock().unwrap();
        if let Some(note) = session.notes.iter_mut().find(|n| n.id == id) {
            note.text = text;
        }
    }
    store.save_session();
}

#[tauri::command]
fn delete_note(store: State<Store>, id: String) -> Vec<Note> {
    {
        let mut session = store.session.lock().unwrap();
        if let Some(pos) = session.notes.iter().position(|n| n.id == id) {
            let note = session.notes.remove(pos);
            if let Some(path) = note.image {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    store.save_session();
    store.session.lock().unwrap().notes.clone()
}

#[derive(Serialize)]
struct Archive {
    id: String,
    label: String,
    count: usize,
    preview: String,
}

fn archive_dir(base: &PathBuf) -> PathBuf {
    base.join("guardadas")
}

/// Session ids are timestamps, so they double as the display label.
fn label_for(id: &str) -> String {
    chrono::NaiveDateTime::parse_from_str(id, "%Y%m%d-%H%M%S")
        .map(|t| t.format("%d/%m/%Y %H:%M").to_string())
        .unwrap_or_else(|_| id.to_string())
}

/// Read back a batch written by `archive_notes`. The Markdown is the archive
/// format itself — no parallel JSON to drift out of sync, and a batch stays
/// editable by hand.
fn parse_archive(text: &str, id: &str) -> Session {
    let created_at = chrono::NaiveDateTime::parse_from_str(id, "%Y%m%d-%H%M%S")
        .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default();

    struct Block<'a> {
        lines: Vec<&'a str>,
        image: Option<&'a str>,
        context: Option<&'a str>,
        priority: String,
    }

    let mut blocks: Vec<Block> = Vec::new();
    for line in text.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            // "3 · bloqueante" — the label is only there when it is not normal.
            let priority = heading
                .split_once(" · ")
                .map(|(_, label)| priority_from_label(label.trim()))
                .unwrap_or_else(default_priority);
            blocks.push(Block { lines: Vec::new(), image: None, context: None, priority });
        } else if let Some(path) = line.strip_prefix("Captura: ") {
            if let Some(block) = blocks.last_mut() {
                block.image = Some(path.trim());
            }
        } else if let Some(ctx) = line.strip_prefix("Contexto: ") {
            if let Some(block) = blocks.last_mut() {
                block.context = Some(ctx.trim());
            }
        } else if let Some(block) = blocks.last_mut() {
            block.lines.push(line);
        }
    }

    let notes: Vec<Note> = blocks
        .into_iter()
        .enumerate()
        .map(|(i, block)| Note {
            id: format!("n{:03}", i + 1),
            text: block.lines.join("\n").trim().to_string(),
            image: block.image.map(str::to_string),
            created_at: created_at.clone(),
            priority: block.priority,
            context: block.context.map(str::to_string),
        })
        .collect();

    // Carry on numbering past the highest screenshot already in the batch, or a
    // new capture would overwrite one that a deleted note left behind.
    let highest = notes
        .iter()
        .filter_map(|n| n.image.as_deref())
        .filter_map(|p| Path::new(p).file_stem()?.to_str()?.parse::<u32>().ok())
        .max()
        .unwrap_or(0);

    Session {
        id: id.to_string(),
        seq: highest.max(notes.len() as u32),
        notes,
    }
}

#[tauri::command]
fn list_archives(store: State<Store>) -> Vec<Archive> {
    let Ok(entries) = std::fs::read_dir(archive_dir(&store.base)) else {
        return vec![];
    };
    let mut archives: Vec<Archive> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
        .filter_map(|e| {
            let path = e.path();
            let id = path.file_stem()?.to_str()?.to_string();
            let session = parse_archive(&std::fs::read_to_string(&path).ok()?, &id);
            let preview = session
                .notes
                .iter()
                .map(|n| n.text.as_str())
                .find(|t| !t.is_empty())
                .unwrap_or("(solo capturas)")
                .lines()
                .next()
                .unwrap_or("")
                .to_string();
            Some(Archive {
                label: label_for(&id),
                id,
                count: session.notes.len(),
                preview,
            })
        })
        .collect();
    // Ids are timestamps, so a reverse sort puts the newest batch first.
    archives.sort_by(|a, b| b.id.cmp(&a.id));
    archives
}

/// Load an archived batch as the working list. Refuses while the current list
/// has anything in it, so nothing can be silently overwritten.
#[tauri::command]
fn open_archive(app: AppHandle, id: String) -> Result<Vec<Note>, String> {
    let store = app.state::<Store>();
    if !store.session.lock().unwrap().notes.is_empty() {
        return Err("guarda o vacía la tanda actual antes de abrir otra".into());
    }
    let path = archive_dir(&store.base).join(format!("{id}.md"));
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("no se pudo leer {}: {e}", path.display()))?;

    let session = parse_archive(&text, &id);
    if session.notes.is_empty() {
        return Err("esa tanda no tiene anotaciones legibles".into());
    }
    let notes = session.notes.clone();
    *store.session.lock().unwrap() = session;
    store.save_session();
    Ok(notes)
}

/// Write the batch out as a Markdown file, keep its screenshots, and start a
/// fresh list. The counterpart to `clear_notes`, which throws the batch away.
#[tauri::command]
fn archive_notes(store: State<Store>) -> Result<String, String> {
    if store.session.lock().unwrap().notes.is_empty() {
        return Err("no hay nada que guardar".into());
    }
    // Always the canonical format, never the user's template: the archive is
    // what `parse_archive` reads back, so a customised preamble must not be
    // able to make saved notes unopenable.
    let markdown = {
        let session = store.session.lock().unwrap();
        apply_template(DEFAULT_TEMPLATE, &session.notes)
    };
    let dest = {
        let session = store.session.lock().unwrap();
        store.base.join("guardadas").join(format!("{}.md", session.id))
    };
    std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&dest, markdown).map_err(|e| format!("no se pudo guardar: {e}"))?;

    *store.session.lock().unwrap() = Session::default();
    store.save_session();
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
fn clear_notes(store: State<Store>) -> Vec<Note> {
    {
        let mut session = store.session.lock().unwrap();
        for note in session.notes.drain(..) {
            if let Some(path) = note.image {
                let _ = std::fs::remove_file(path);
            }
        }
        // A fresh batch gets a fresh folder.
        *session = Session::default();
    }
    store.save_session();
    vec![]
}

/// `ids` limits the copy to a subset; None copies everything.
#[tauri::command]
fn build_markdown_for(store: State<Store>, ids: Option<Vec<String>>) -> String {
    store.markdown(ids.as_deref())
}

#[tauri::command]
fn get_settings(store: State<Store>) -> Settings {
    store.settings.lock().unwrap().clone()
}

/// Takes the whole object rather than one command per field, so adding a
/// setting later means touching the struct and the UI, nothing else.
#[tauri::command]
fn put_settings(app: AppHandle, settings: Settings) -> Settings {
    let store = app.state::<Store>();
    let saved = {
        let mut current = store.settings.lock().unwrap();
        *current = settings;
        current.opacity = current.opacity.clamp(0.2, 1.0);
        current.clone()
    };
    store.save_settings();
    // The exclusion is an OS-level window flag, so toggling it has to reach
    // Windows now rather than at the next capture.
    apply_capture_exclusion(&app);
    let _ = app.emit("settings-changed", saved.clone());
    saved
}

/// Notes live in session.json, so quitting loses nothing and needs no
/// confirmation.
#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn open_base_dir(store: State<Store>) -> Result<(), String> {
    let _ = std::fs::create_dir_all(&store.base);
    tauri_plugin_opener::open_path(store.base.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

// ----------------------------------------------------------------------- main

fn main() {
    let capture_key = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyA);
    let copy_key = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyC);

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &capture_key {
                        let app = app.clone();
                        std::thread::spawn(move || start_capture(app));
                    } else if shortcut == &copy_key {
                        let markdown = app.state::<Store>().markdown(None);
                        let _ = app.clipboard().write_text(markdown);
                    }
                })
                .build(),
        )
        // Serves the frozen screenshot straight out of memory.
        .register_uri_scheme_protocol("frozen", |ctx, _request| {
            let guard = ctx.app_handle().state::<Store>();
            let frozen = guard.frozen.lock().unwrap();
            match frozen.as_ref().map(|f| capture::to_bmp(&f.image)) {
                Some(Ok(bytes)) => Response::builder()
                    .header("Content-Type", "image/bmp")
                    .header("Cache-Control", "no-store")
                    .body(bytes)
                    .unwrap(),
                _ => Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .setup(move |app| {
            let base = app.path().home_dir()?.join("Nitpick");
            std::fs::create_dir_all(&base)?;
            app.manage(Store::load(base));

            // Built once, up front: showing an existing hidden window is
            // near-instant, building a webview is not.
            WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("overlay.html".into()))
                .title("Seleccionar region")
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .shadow(false)
                .visible(false)
                .build()?;

            if !apply_capture_exclusion(app.handle()) {
                eprintln!("el panel se ocultará durante cada captura");
            }

            // Another app may already own one of these. That costs a shortcut,
            // not the whole program, so never let it abort startup.
            for (key, label) in [(capture_key, "Ctrl+Alt+A"), (copy_key, "Ctrl+Alt+C")] {
                if let Err(e) = app.global_shortcut().register(key) {
                    eprintln!("atajo {label} no registrado: {e}");
                    app.state::<Store>()
                        .warnings
                        .lock()
                        .unwrap()
                        .push(format!("{label} ya lo usa otro programa"));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            begin_capture,
            cancel_capture,
            current_capture,
            commit_capture,
            startup_warnings,
            list_notes,
            add_text_note,
            update_note,
            delete_note,
            archive_notes,
            list_archives,
            open_archive,
            clear_notes,
            build_markdown_for,
            add_clipboard_note,
            set_priority,
            reorder_notes,
            get_settings,
            put_settings,
            open_base_dir,
            quit,
        ])
        .run(tauri::generate_context!())
        .expect("error al arrancar Nitpick");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(text: &str, image: Option<&str>) -> Note {
        Note { text: text.into(), image: image.map(str::to_string), ..Note::default() }
    }

    fn canonical(notes: &[Note]) -> String {
        apply_template(DEFAULT_TEMPLATE, notes)
    }

    /// The Markdown is the archive format, so whatever is written must come
    /// back — otherwise reopening a batch quietly loses notes.
    #[test]
    fn markdown_round_trips() {
        let notes = vec![
            note("El sidebar se solapa con el header.", Some(r"C:\shots\01.png")),
            note("Dos líneas\nde texto", Some(r"C:\shots\02.png")),
            note("Sin captura", None),
            note("", Some(r"C:\shots\04.png")),
        ];
        let parsed = parse_archive(&canonical(&notes), "20260903-155711");

        assert_eq!(parsed.notes.len(), notes.len());
        for (before, after) in notes.iter().zip(&parsed.notes) {
            assert_eq!(before.text, after.text);
            assert_eq!(before.image, after.image);
        }
    }

    /// A deleted note leaves a gap in the screenshot numbering, so a reopened
    /// batch must resume past the highest file rather than overwrite one.
    #[test]
    fn seq_resumes_past_the_highest_screenshot() {
        let notes = vec![
            note("primera", Some(r"C:\shots\01.png")),
            note("quinta", Some(r"C:\shots\05.png")),
        ];
        let parsed = parse_archive(&canonical(&notes), "20260903-155711");
        assert_eq!(parsed.seq, 5);
    }

    /// Priority and context travel in the Markdown, so reopening a saved list
    /// must not quietly downgrade every note to normal.
    #[test]
    fn priority_and_context_round_trip() {
        let mut notes = vec![note("bloquea el login", Some(r"C:\shots.png")), note("detalle", None)];
        notes[0].priority = "blocker".into();
        notes[0].context = Some("Dashboard - Chrome · 1280×900".into());
        notes[1].priority = "minor".into();

        let parsed = parse_archive(&canonical(&notes), "20260903-155711");

        assert_eq!(parsed.notes[0].priority, "blocker");
        assert_eq!(parsed.notes[0].context.as_deref(), Some("Dashboard - Chrome · 1280×900"));
        assert_eq!(parsed.notes[0].text, "bloquea el login");
        assert_eq!(parsed.notes[1].priority, "minor");
        assert_eq!(parsed.notes[1].context, None);
    }

    /// A template without the placeholder must still carry the notes.
    #[test]
    fn template_without_placeholder_keeps_the_notes() {
        let notes = vec![note("algo va mal", None)];
        let out = apply_template("Solo un preambulo", &notes);
        assert!(out.starts_with("Solo un preambulo"));
        assert!(out.contains("algo va mal"));
    }

    #[test]
    fn template_fills_its_placeholders() {
        let notes = vec![note("uno", None), note("dos", None)];
        let out = apply_template("Total: {{total}}
{{notas}}", &notes);
        assert!(out.starts_with("Total: 2
"));
        assert!(out.contains("uno") && out.contains("dos"));
    }

    #[test]
    fn label_falls_back_to_the_raw_id() {
        assert_eq!(label_for("20260903-155711"), "03/09/2026 15:57");
        assert_eq!(label_for("no-es-una-fecha"), "no-es-una-fecha");
    }
}
