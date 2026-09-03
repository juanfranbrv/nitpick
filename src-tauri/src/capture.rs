use std::io::Cursor;
use std::path::Path;
use std::time::Instant;
use xcap::image::codecs::bmp::BmpEncoder;
use xcap::image::{imageops, ExtendedColorType, Rgba, RgbaImage};
use xcap::Monitor;

/// The screen as it looked when the shortcut fired. Kept in memory: encoding a
/// full-desktop PNG to disk and reading it back was the bulk of the delay
/// between pressing the shortcut and seeing the selector.
pub struct Frozen {
    pub image: RgbaImage,
    pub origin_x: i32,
    pub origin_y: i32,
}

impl Frozen {
    pub fn width(&self) -> u32 {
        self.image.width()
    }
    pub fn height(&self) -> u32 {
        self.image.height()
    }
}

/// Grab every monitor and lay them out like the virtual desktop, so a selection
/// can span screens.
pub fn freeze() -> Result<Frozen, String> {
    let start = Instant::now();
    let monitors =
        Monitor::all().map_err(|e| format!("no se pudieron enumerar los monitores: {e}"))?;
    let enumerated = start.elapsed();

    let mut shots = Vec::with_capacity(monitors.len());
    for m in &monitors {
        // Each getter is its own Windows call, so ask once and reuse.
        let x = m.x().map_err(|e| format!("posición X del monitor: {e}"))?;
        let y = m.y().map_err(|e| format!("posición Y del monitor: {e}"))?;
        let img = m.capture_image().map_err(|e| format!("captura del monitor: {e}"))?;
        shots.push((x, y, img));
    }
    let grabbed = start.elapsed();

    // One monitor is the common case, and then the capture already *is* the
    // canvas: allocating a second desktop-sized buffer and copying every pixel
    // into it would be pure waste.
    let screens = shots.len();
    let frozen = if screens == 1 {
        let (origin_x, origin_y, image) = shots.pop().unwrap();
        Frozen { image, origin_x, origin_y }
    } else if screens == 0 {
        return Err("no se detectó ningún monitor".into());
    } else {
        let min_x = shots.iter().map(|(x, _, _)| *x).min().unwrap();
        let min_y = shots.iter().map(|(_, y, _)| *y).min().unwrap();
        let max_x = shots.iter().map(|(x, _, i)| x + i.width() as i32).max().unwrap();
        let max_y = shots.iter().map(|(_, y, i)| y + i.height() as i32).max().unwrap();

        let mut canvas = RgbaImage::from_pixel(
            (max_x - min_x) as u32,
            (max_y - min_y) as u32,
            Rgba([0, 0, 0, 255]),
        );
        for (x, y, img) in &shots {
            blit(&mut canvas, img, (x - min_x) as u32, (y - min_y) as u32);
        }
        Frozen { image: canvas, origin_x: min_x, origin_y: min_y }
    };

    eprintln!(
        "  freeze: {screens} monitor(es), enumerar {} ms, capturar {} ms, componer {} ms",
        enumerated.as_millis(),
        (grabbed - enumerated).as_millis(),
        (start.elapsed() - grabbed).as_millis(),
    );
    Ok(frozen)
}

/// Row-wise `copy_from_slice` instead of `imageops::replace`.
///
/// Pasting a second monitor with `replace` measured 271 ms of a 408 ms capture:
/// it walks pixel by pixel through `get_pixel`/`put_pixel`, which no amount of
/// optimisation turns back into the memory copy this actually is. Both images
/// are tightly packed RGBA, so each row is one memcpy.
fn blit(canvas: &mut RgbaImage, src: &RgbaImage, dx: u32, dy: u32) {
    const BPP: usize = 4;
    let canvas_w = canvas.width() as usize;
    let src_w = src.width() as usize;

    // The canvas is sized to bound every monitor, so this always holds; bail
    // rather than panic if a display is ever reported inconsistently.
    if dx as usize + src_w > canvas_w || dy + src.height() > canvas.height() {
        return;
    }

    let row_bytes = src_w * BPP;
    let source = src.as_raw();
    let target: &mut [u8] = canvas;

    for row in 0..src.height() as usize {
        let from = row * row_bytes;
        let to = ((dy as usize + row) * canvas_w + dx as usize) * BPP;
        target[to..to + row_bytes].copy_from_slice(&source[from..from + row_bytes]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hand-rolled row copies are exactly where an off-by-one silently
    /// corrupts an image, so pin the placement down.
    #[test]
    fn blit_lands_at_the_right_offset() {
        let mut canvas = RgbaImage::from_pixel(4, 3, Rgba([0, 0, 0, 255]));
        let patch = RgbaImage::from_pixel(2, 2, Rgba([10, 20, 30, 255]));

        blit(&mut canvas, &patch, 2, 1);

        for (x, y) in [(2, 1), (3, 1), (2, 2), (3, 2)] {
            assert_eq!(*canvas.get_pixel(x, y), Rgba([10, 20, 30, 255]), "en {x},{y}");
        }
        // Everything outside the patch is untouched.
        for (x, y) in [(0, 0), (1, 0), (2, 0), (3, 0), (0, 1), (1, 1), (0, 2), (1, 2)] {
            assert_eq!(*canvas.get_pixel(x, y), Rgba([0, 0, 0, 255]), "en {x},{y}");
        }
    }

    /// A monitor reported outside the canvas must not panic mid-capture.
    #[test]
    fn blit_refuses_to_run_off_the_canvas() {
        let mut canvas = RgbaImage::from_pixel(2, 2, Rgba([0, 0, 0, 255]));
        let patch = RgbaImage::from_pixel(2, 2, Rgba([9, 9, 9, 255]));

        blit(&mut canvas, &patch, 1, 0);

        assert_eq!(*canvas.get_pixel(1, 0), Rgba([0, 0, 0, 255]));
    }
}

/// BMP because it is uncompressed: the webview gets the bitmap almost as fast
/// as it can be copied, where a PNG of the whole desktop costs hundreds of ms.
/// RGBA goes straight through, so nothing has to strip the alpha channel first.
pub fn to_bmp(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(image.as_raw().len() + 128);
    BmpEncoder::new(&mut Cursor::new(&mut out))
        .encode(image.as_raw(), image.width(), image.height(), ExtendedColorType::Rgba8)
        .map_err(|e| format!("no se pudo codificar la captura: {e}"))?;
    Ok(out)
}

/// Cut `rect` (physical pixels) out of the frozen image, burn in the marker
/// strokes if there are any, and write it as a PNG. Only the crop touches disk,
/// so it stays cheap.
///
/// `strokes` is a transparent PNG the selector drew at the crop's own pixel
/// size, so it composites one-to-one with no resampling.
pub fn crop_to_png(
    image: &RgbaImage,
    dest: &Path,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    strokes: Option<&[u8]>,
) -> Result<(), String> {
    let mut cut = imageops::crop_imm(image, x, y, w, h).to_image();

    if let Some(bytes) = strokes {
        let layer = xcap::image::load_from_memory(bytes)
            .map_err(|e| format!("no se pudieron leer los trazos: {e}"))?
            .to_rgba8();
        imageops::overlay(&mut cut, &layer, 0, 0);
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    cut.save(dest).map_err(|e| format!("no se pudo guardar el recorte: {e}"))
}
