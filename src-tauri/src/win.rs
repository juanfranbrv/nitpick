//! Windows-specific glue: reading what was on screen when the shortcut fired,
//! and keeping our own panel out of the screenshot.
//!
//! Deliberate limit on the first: this reads the window *title*, not the URL.
//! Pulling the address out of a browser needs UI Automation — walking the
//! window's accessibility tree for the omnibox and reading its value pattern —
//! which is browser specific and fails quietly when it drifts. The title plus
//! the viewport size is what can be had reliably.

/// Ask Windows to leave this window out of any screen capture.
///
/// Worth more than it looks: without it the panel has to be hidden and the
/// compositor given ~70 ms to repaint before the screen can be frozen, which
/// was half the remaining capture latency and made the panel visibly blink on
/// every shortcut. Needs Windows 10 2004 or newer; the caller keeps the
/// hide-and-wait path for when this returns false.
#[cfg(windows)]
pub fn exclude_from_capture(hwnd: isize) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };
    unsafe { SetWindowDisplayAffinity(HWND(hwnd as *mut _), WDA_EXCLUDEFROMCAPTURE).is_ok() }
}

#[cfg(not(windows))]
pub fn exclude_from_capture(_hwnd: isize) -> bool {
    false
}

/// Title and client size of the window in front, for the note's context line.
///
/// `skip` holds our own window handles: when the capture is started from the
/// panel's own button, our window is the foreground one and naming it would be
/// useless.
#[cfg(windows)]
pub fn foreground(skip: &[isize]) -> Option<String> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetForegroundWindow, GetWindowTextW,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() || skip.contains(&(hwnd.0 as isize)) {
            return None;
        }

        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
        let title = title.trim();

        let mut rect = RECT::default();
        let size = GetClientRect(hwnd, &mut rect)
            .ok()
            .map(|_| (rect.right - rect.left, rect.bottom - rect.top))
            .filter(|(w, h)| *w > 0 && *h > 0);

        match (title.is_empty(), size) {
            (true, None) => None,
            (true, Some((w, h))) => Some(format!("{w}×{h}")),
            (false, None) => Some(title.to_string()),
            (false, Some((w, h))) => Some(format!("{title} · {w}×{h}")),
        }
    }
}

#[cfg(not(windows))]
pub fn foreground(_skip: &[isize]) -> Option<String> {
    None
}
