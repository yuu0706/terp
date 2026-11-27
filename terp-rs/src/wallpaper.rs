// 全画面のときに窓の後ろへ敷く、いまの壁紙。
// macOS の全画面は窓を専用の Space へ移し、後ろに壁紙も他の窓も無くなるため、透過しても灰色の板しか見えない。
// 壁紙をぼかした JPEG にして窓の後ろに敷き、透けて見えるようにする
use std::path::{Path, PathBuf};

// 長い辺の画素数。ぼかして敷くため、これ以上は要らない
const MAX_SIDE: u32 = 2560;

// いまの主画面の壁紙の場所と、画面の横幅（点）。NSWorkspace に聞く（System Events を通さないため、操作の許可を求められない）
pub fn current() -> Option<(PathBuf, f32)> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSScreen, NSWorkspace};
    let mtm = MainThreadMarker::new()?;
    let screen = NSScreen::mainScreen(mtm)?;
    let url = NSWorkspace::sharedWorkspace().desktopImageURLForScreen(&screen)?;
    let width = screen.frame().size.width as f32;
    url.path().map(|p| (PathBuf::from(p.to_string()), width))
}

// HEIC などは画像として読めないため、sips で JPEG に変えてからぼかす。壁紙・更新時刻・半径が同じなら使い回す
pub fn prepare(source: &Path, blur: u32, screen_width: f32) -> Result<PathBuf, String> {
    let modified = std::fs::metadata(source).and_then(|m| m.modified()).map_err(|e| format!("壁紙を読めない: {e}"))?;
    let dir = crate::config::config_dir().join("cache");
    std::fs::create_dir_all(&dir).map_err(|e| format!("控えの置き場所を作れない: {e}"))?;
    let key = format!("{}:{:?}:{MAX_SIDE}:{blur}", source.display(), modified);
    // 画面の絵は場所ごとに覚えて使い回されるため、作り直したら別の名前にする
    let hash = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        key.hash(&mut h);
        h.finish()
    };
    let name = format!("gpui-wallpaper-{hash:016x}.jpg");
    let out = dir.join(&name);
    if out.exists() {
        return Ok(out);
    }
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.starts_with("gpui-wallpaper-") && n.ends_with(".jpg") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let plain = dir.join("gpui-wallpaper-plain.tmp.jpg");
    let status = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", &MAX_SIDE.to_string()])
        .arg(source)
        .arg("--out")
        .arg(&plain)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("sips を起動できない: {e}"))?;
    if !status.success() {
        return Err("壁紙を JPEG に変えられない".into());
    }
    let mut image = image::open(&plain).map_err(|e| format!("壁紙を読めない: {e}"))?.to_rgb8();
    if blur > 0 {
        // 半径は画面の点の数で決めてある。画像は画面より細かいことがあるため、横幅の比で広げる
        let sigma = blur as f32 * (image.width() as f32 / screen_width.max(1.0)).max(1.0) / 2.0;
        image = image::imageops::fast_blur(&image, sigma);
    }
    image.save_with_format(&out, image::ImageFormat::Jpeg).map_err(|e| format!("壁紙を書けない: {e}"))?;
    let _ = std::fs::remove_file(&plain);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 実際の壁紙を変換してぼかす。sips を使うため既定では回さない
    #[test]
    #[ignore]
    fn 壁紙を_jpeg_にしてぼかし_同じ条件なら使い回す() {
        let dir = std::env::temp_dir().join(format!("terp-wallpaper-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        unsafe { std::env::set_var("TERP_CONFIG_DIR", &dir) };
        let source = std::fs::read_dir("/System/Library/Desktop Pictures").unwrap().flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|e| e == "heic")).unwrap();
        let first = prepare(&source, 4, 1512.0).unwrap();
        let again = prepare(&source, 4, 1512.0).unwrap();
        assert_eq!(first, again);
        let image = image::open(&first).unwrap();
        assert!(image.width().max(image.height()) <= MAX_SIDE);
        let other = prepare(&source, 0, 1512.0).unwrap();
        assert_ne!(first, other);
        assert!(!first.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
