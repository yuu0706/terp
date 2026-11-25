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

// ファイルやフォルダをゴミ箱へ移す（Finder のゴミ箱から戻せる）
pub fn trash(path: &std::path::Path) -> anyhow::Result<()> {
    use objc2_foundation::{NSFileManager, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.display().to_string()));
    let manager = NSFileManager::defaultManager();
    manager
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|e| anyhow::anyhow!("ゴミ箱へ移せない: {}", e.localizedDescription()))
}
