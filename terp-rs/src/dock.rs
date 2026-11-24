// Dock のアイコンに、要対応の件数を出す
use objc2::MainThreadMarker;
use objc2_app_kit::NSApplication;
use objc2_foundation::NSString;

pub fn set_badge(count: usize) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let tile = NSApplication::sharedApplication(mtm).dockTile();
    let label = (count > 0).then(|| NSString::from_str(&count.to_string()));
    tile.setBadgeLabel(label.as_deref());
}
