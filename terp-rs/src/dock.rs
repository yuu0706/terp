// macOS の AppKit を直接呼ぶ処理（Dock の件数・窓の後ろのぼかし）
use objc2::MainThreadMarker;
use objc2_app_kit::NSApplication;
use objc2_foundation::NSString;

pub fn set_badge(count: usize) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let tile = NSApplication::sharedApplication(mtm).dockTile();
    let label = (count > 0).then(|| NSString::from_str(&count.to_string()));
    tile.setBadgeLabel(label.as_deref());
}

// GPUI のぼかしは強さを変えられないため、Electron 版と同じ非公開の関数で半径を指定する。
// macOS の更新で使えなくなった場合は、ぼかしだけが無くなり、透過は残る
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGSMainConnectionID() -> i32;
    fn CGSSetWindowBackgroundBlurRadius(connection: i32, window: i32, radius: i32) -> i32;
}

pub fn set_blur_radius(radius: u32) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let windows = NSApplication::sharedApplication(mtm).windows();
    let connection = unsafe { CGSMainConnectionID() };
    for window in windows.iter() {
        let number = window.windowNumber() as i32;
        unsafe { CGSSetWindowBackgroundBlurRadius(connection, number, radius as i32) };
    }
}

// 透かすかぼかすときは窓の影を切る（透けた縁に影が浮いて見えるため）。不透明なら戻す
pub fn set_shadow(on: bool) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    for window in NSApplication::sharedApplication(mtm).windows().iter() {
        window.setHasShadow(on);
    }
}

// ファイルやフォルダをゴミ箱へ移す（Finder のゴミ箱から戻せる）
pub fn trash(path: &std::path::Path) -> anyhow::Result<()> {
    use objc2_foundation::{NSFileManager, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.display().to_string()));
    let manager = NSFileManager::defaultManager();
    manager
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|e| anyhow::anyhow!("ゴミ箱へ移せない: {}", e.localizedDescription()))
}

// テーマの色で描いた Dock のアイコン（ターミナルの背景・アプリの背景・強調色・薄い文字・文字の5色）
pub fn icon_svg(top: &str, bottom: &str, accent: &str, muted: &str, text: &str) -> String {
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/></linearGradient></defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
  <rect x="101.5" y="101.5" width="821" height="821" rx="183.5" fill="none" stroke="{accent}" stroke-opacity="0.35" stroke-width="3"/>
  <rect x="190" y="300" width="150" height="34" rx="17" fill="{accent}"/>
  <rect x="190" y="380" width="150" height="34" rx="17" fill="{muted}" fill-opacity="0.45"/>
  <rect x="190" y="460" width="150" height="34" rx="17" fill="{muted}" fill-opacity="0.45"/>
  <line x1="390" y1="250" x2="390" y2="774" stroke="{muted}" stroke-opacity="0.18" stroke-width="6"/>
  <path d="M470 400 L590 500 L470 600" fill="none" stroke="{accent}" stroke-width="56" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="630" y="590" width="170" height="52" rx="26" fill="{text}"/>
</svg>"##
    )
}

fn render_png(svg: &str, size: u32) -> Option<Vec<u8>> {
    let tree = resvg::usvg::Tree::from_str(svg, &resvg::usvg::Options::default()).ok()?;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size, size)?;
    let scale = size as f32 / 1024.0;
    resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    pixmap.encode_png().ok()
}

// None なら元のアイコンに戻す
pub fn set_dock_icon(svg: Option<&str>) {
    use objc2::AllocAnyThread;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSData;
    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    let Some(svg) = svg else {
        unsafe { app.setApplicationIconImage(None) };
        return;
    };
    let Some(png) = render_png(svg, 512) else { return };
    let data = NSData::with_bytes(&png);
    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { app.setApplicationIconImage(Some(&image)) };
    }
}
