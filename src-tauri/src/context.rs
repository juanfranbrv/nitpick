//! What was on screen when the shortcut fired.
//!
//! The window title and client size of whatever you were looking at is half of
//! a UI bug report, and typing it by hand is exactly the friction this app
//! exists to remove.
//!
//! Deliberate limit: this reads the *title*, not the URL. Pulling the address
//! out of a browser needs UI Automation — walking the window's accessibility
//! tree for the omnibox and reading its value pattern — which is browser
//! specific and fails quietly when it drifts. The title plus the viewport size
//! is what can be had reliably.

/// `skip` is the handle of our own panel: when the capture is started from its
/// button, our window is the foreground one and naming it would be useless.
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
