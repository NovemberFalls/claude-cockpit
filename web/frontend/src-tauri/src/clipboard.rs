//! Read-only image fallback for a foreground local terminal paste gesture.
use serde::Serialize;

#[derive(Serialize)]
pub struct ClipboardImage {
    mime: &'static str,
    bytes: Vec<u8>,
}

#[tauri::command]
pub fn read_clipboard_image(window: tauri::WebviewWindow) -> Result<Option<ClipboardImage>, String> {
    let url = window.url().map_err(|_| "Cannot verify clipboard caller")?;
    let local = url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
        && url.port_or_known_default() == Some(8420);
    if !local || !window.is_focused().unwrap_or(false) {
        return Err("Focus the local terminal window before pasting".into());
    }
    #[cfg(windows)]
    { windows_image() }
    #[cfg(not(windows))]
    { Ok(None) }
}

#[cfg(windows)]
fn windows_image() -> Result<Option<ClipboardImage>, String> {
    use std::ffi::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(owner: *mut c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn GetClipboardData(format: u32) -> *mut c_void;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalLock(handle: *mut c_void) -> *const u8;
        fn GlobalUnlock(handle: *mut c_void) -> i32;
        fn GlobalSize(handle: *mut c_void) -> usize;
    }
    struct Clipboard;
    impl Drop for Clipboard { fn drop(&mut self) { unsafe { CloseClipboard(); } } }
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("Clipboard is busy; try pasting again".into());
        }
        let _clipboard = Clipboard;
        let png_name: Vec<u16> = "PNG\0".encode_utf16().collect();
        let png = RegisterClipboardFormatW(png_name.as_ptr());
        let format = [png, 17, 8].into_iter().find(|f| *f != 0 && IsClipboardFormatAvailable(*f) != 0);
        let Some(format) = format else { return Ok(None); };
        let handle = GetClipboardData(format);
        if handle.is_null() { return Err("Clipboard image is unavailable".into()); }
        let size = GlobalSize(handle);
        if size == 0 || size > 25 * 1024 * 1024 { return Err("Clipboard image exceeds the 25 MB limit".into()); }
        let pointer = GlobalLock(handle);
        if pointer.is_null() { return Err("Cannot read clipboard image".into()); }
        let bytes = std::slice::from_raw_parts(pointer, size).to_vec();
        GlobalUnlock(handle);
        if format == png {
            validate_png(&bytes)?;
            return Ok(Some(ClipboardImage { mime: "image/png", bytes }));
        }
        let bytes = dib_to_bmp(bytes)?;
        Ok(Some(ClipboardImage { mime: "image/bmp", bytes }))
    }
}

#[cfg(any(windows, test))]
fn dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 || width > 16384 || height > 16384
        || u64::from(width) * u64::from(height) > 64 * 1024 * 1024 {
        return Err("Clipboard image dimensions exceed the supported limit".into());
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn validate_png(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 33 || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || bytes[8..12] != 13u32.to_be_bytes() || &bytes[12..16] != b"IHDR" {
        return Err("Clipboard PNG header is invalid".into());
    }
    dimensions(u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
               u32::from_be_bytes(bytes[20..24].try_into().unwrap()))
}

#[cfg(any(windows, test))]
fn dib_to_bmp(dib: Vec<u8>) -> Result<Vec<u8>, String> {
    if dib.len() < 40 { return Err("Clipboard bitmap header is incomplete".into()); }
    let number = |at| u32::from_le_bytes(dib[at..at + 4].try_into().unwrap()) as usize;
    let header = number(0);
    if !matches!(header, 40 | 108 | 124) || header > dib.len() {
        return Err("Clipboard bitmap format is unsupported".into());
    }
    let depth = u16::from_le_bytes([dib[14], dib[15]]);
    let width = i32::from_le_bytes(dib[4..8].try_into().unwrap());
    let height = i32::from_le_bytes(dib[8..12].try_into().unwrap());
    if width <= 0 || height == i32::MIN || u16::from_le_bytes([dib[12], dib[13]]) != 1 {
        return Err("Clipboard bitmap dimensions or planes are invalid".into());
    }
    dimensions(width as u32, height.unsigned_abs())?;
    let compression = number(16);
    if !matches!(depth, 1 | 4 | 8 | 16 | 24 | 32) || !matches!(compression, 0 | 3 | 6) {
        return Err("Clipboard bitmap encoding is unsupported".into());
    }
    let colors = number(32);
    let palette = if colors != 0 { colors } else if depth <= 8 { 1usize << depth } else { 0 };
    let masks = if header == 40 { match compression { 3 => 12, 6 => 16, _ => 0 } } else { 0 };
    let offset = header.checked_add(masks).and_then(|v| palette.checked_mul(4).and_then(|n| v.checked_add(n)))
        .ok_or("Clipboard bitmap size is invalid")?;
    let stride = ((width as usize * depth as usize + 31) / 32) * 4;
    let end = stride.checked_mul(height.unsigned_abs() as usize).and_then(|size| offset.checked_add(size));
    if end.is_none() || end.unwrap() > dib.len() { return Err("Clipboard bitmap pixels are missing".into()); }
    let mut bmp = Vec::with_capacity(dib.len() + 14);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&((dib.len() + 14) as u32).to_le_bytes());
    bmp.extend_from_slice(&[0; 4]);
    bmp.extend_from_slice(&((offset + 14) as u32).to_le_bytes());
    bmp.extend_from_slice(&dib);
    Ok(bmp)
}

#[cfg(test)]
mod tests {
    use super::{dib_to_bmp, validate_png};
    #[test]
    fn bitmap_fixture_and_invalid_offsets() {
        let mut dib = vec![0; 44];
        dib[..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&1i32.to_le_bytes());
        dib[8..12].copy_from_slice(&1i32.to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&24u16.to_le_bytes());
        let bmp = dib_to_bmp(dib.clone()).unwrap();
        assert_eq!(&bmp[..2], b"BM");
        assert_eq!(u32::from_le_bytes(bmp[10..14].try_into().unwrap()), 54);
        assert_eq!(&bmp[14..], &dib);
        let mut huge = dib.clone();
        huge[4..8].copy_from_slice(&i32::MAX.to_le_bytes());
        assert!(dib_to_bmp(huge).is_err());
        let mut incomplete = dib.clone();
        incomplete[8..12].copy_from_slice(&2i32.to_le_bytes());
        assert!(dib_to_bmp(incomplete).is_err());
        dib[32..36].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(dib_to_bmp(dib).is_err());
        assert!(dib_to_bmp(vec![0; 8]).is_err());
    }
    #[test]
    fn png_dimensions_are_bounded_before_browser_decode() {
        let mut png = vec![0; 33];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[8..12].copy_from_slice(&13u32.to_be_bytes());
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&1u32.to_be_bytes());
        png[20..24].copy_from_slice(&1u32.to_be_bytes());
        assert!(validate_png(&png).is_ok());
        png[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(validate_png(&png).is_err());
        assert!(validate_png(b"not png").is_err());
    }
}
