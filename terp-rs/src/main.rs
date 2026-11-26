mod agent;
mod agents;
mod agentsettings;
mod app;
mod assets;
mod assist;
mod appearance;
mod config;
mod dock;
mod editor;
mod filetabs;
mod quick;
mod ghostty;
mod git;
mod gitops;
mod input;
mod inputbox;
mod keys;
mod links;
mod markdown;
mod offers;
mod overlay;
mod overview;
mod panes;
mod permission;
mod pets;
mod projects;
mod rightpanel;
mod rows;
mod ptyhost;
mod search;
mod settings;
mod sidebar;
mod snapshot;
mod state;
mod syntax;
mod terminal;
mod terminal_view;
mod textbuf;
mod themeai;
mod wallpaper;
mod themegen;
mod tooltip;
mod transcript;
mod ui;

use app::*;
use appearance::Appearance;
use gpui::{
    Action, App, Bounds, KeyBinding, Menu, MenuItem, OsAction, TitlebarOptions, WindowBounds, WindowOptions, actions,
    point, prelude::*, px, size,
};
use gpui_platform::application;
use terminal_view::{Clear, Copy, Find, FindNext, Paste, SelectAll};

actions!(terp_app, [Quit, Hide, HideOthers, ShowAll, Minimize, ToggleFullScreen]);

// 近道の id と既定のキー（設定の画面で使う）
pub fn shortcut_defaults() -> Vec<(&'static str, &'static str)> {
    shortcuts().into_iter().map(|(id, key, _)| (id, key)).collect()
}

// 近道の一覧。id は Electron 版の設定（keybindings）と同じ名前にする
fn shortcuts() -> Vec<(&'static str, &'static str, Box<dyn Action>)> {
    vec![
        ("settings", "Command+,", Box::new(OpenSettings)),
        ("new", "Command+T", Box::new(NewTerminal)),
        ("quick-terminal", "Command+Alt+N", Box::new(ToggleQuick)),
        ("split-right", "Command+\\", Box::new(SplitRight)),
        ("next-attention", "Command+Shift+J", Box::new(NextAttention)),
        ("pane-left", "Command+Alt+Left", Box::new(PaneLeft)),
        ("pane-right", "Command+Alt+Right", Box::new(PaneRight)),
        ("pane-up", "Command+Alt+Up", Box::new(PaneUp)),
        ("pane-down", "Command+Alt+Down", Box::new(PaneDown)),
        ("close", "Command+W", Box::new(CloseTab)),
        ("clear", "Command+K", Box::new(Clear)),
        ("find", "Command+F", Box::new(Find)),
        ("find-next", "Command+G", Box::new(FindNext)),
        ("select-all", "Command+A", Box::new(SelectAll)),
        ("recent", "Control+Tab", Box::new(RecentTab)),
        ("prev", "Command+Shift+[", Box::new(PrevTab)),
        ("next", "Command+Shift+]", Box::new(NextTab)),
        ("tab-1", "Command+1", Box::new(SelectTab1)),
        ("tab-2", "Command+2", Box::new(SelectTab2)),
        ("tab-3", "Command+3", Box::new(SelectTab3)),
        ("tab-4", "Command+4", Box::new(SelectTab4)),
        ("tab-5", "Command+5", Box::new(SelectTab5)),
        ("tab-6", "Command+6", Box::new(SelectTab6)),
        ("tab-7", "Command+7", Box::new(SelectTab7)),
        ("tab-8", "Command+8", Box::new(SelectTab8)),
        ("tab-9", "Command+9", Box::new(SelectTab9)),
        ("workspace-1", "Control+Command+1", Box::new(Workspace1)),
        ("workspace-2", "Control+Command+2", Box::new(Workspace2)),
        ("workspace-3", "Control+Command+3", Box::new(Workspace3)),
        ("workspace-4", "Control+Command+4", Box::new(Workspace4)),
        ("workspace-5", "Control+Command+5", Box::new(Workspace5)),
        ("workspace-6", "Control+Command+6", Box::new(Workspace6)),
        ("workspace-7", "Control+Command+7", Box::new(Workspace7)),
        ("workspace-8", "Control+Command+8", Box::new(Workspace8)),
        ("workspace-9", "Control+Command+9", Box::new(Workspace9)),
        ("workspace-next", "Control+Command+]", Box::new(WorkspaceNext)),
        ("workspace-prev", "Control+Command+[", Box::new(WorkspacePrev)),
        ("toggle-sidebar", "Command+B", Box::new(ToggleSidebar)),
        ("toggle-files", "Command+Shift+E", Box::new(ToggleFiles)),
        ("toggle-changes", "Command+Shift+G", Box::new(ToggleChanges)),
        ("toggle-history", "Command+Shift+H", Box::new(ToggleHistory)),
        ("reopen", "Command+Shift+T", Box::new(ReopenClosed)),
        ("overview", "Command+M", Box::new(ToggleOverview)),
        ("new-work", "Command+N", Box::new(NewWork)),
        ("font-bigger", "Command+=", Box::new(FontBigger)),
        ("font-smaller", "Command+-", Box::new(FontSmaller)),
        ("font-reset", "Command+0", Box::new(FontReset)),
    ]
}

// 設定の keybindings で上書きし、null なら外す。読めない書き方は既定のキーのままにする
pub fn bind_keys(cx: &mut App) {
    let overrides = cx.global::<Appearance>().config.keybindings.clone();
    let mut bindings = vec![
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-h", Hide, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
        KeyBinding::new("ctrl-cmd-f", ToggleFullScreen, None),
        KeyBinding::new("cmd-c", Copy, Some("Terminal")),
        KeyBinding::new("cmd-v", Paste, Some("Terminal")),
        // ＋ を直接打つ配列のための別名
        KeyBinding::new("cmd-+", FontBigger, None),
        KeyBinding::new("ctrl-shift-tab", RecentTabBack, None),
    ];
    // 誤った値と、別の操作と重なる上書きは捨てて既定のキーにし、知らせる
    let mut bad = false;
    let mut used: Vec<String> = Vec::new();
    for (id, default, _) in shortcuts() {
        if let Some(Some(custom)) = overrides.get(id) {
            match keys::accelerator_to_gpui(custom) {
                Some(k) if !used.contains(&k) => used.push(k),
                _ => bad = true,
            }
        } else if let Some(k) = keys::accelerator_to_gpui(default)
            && !matches!(overrides.get(id), Some(None))
        {
            used.push(k);
        }
    }
    let known: Vec<&str> = shortcuts().iter().map(|s| s.0).collect();
    if overrides.keys().any(|k| !known.contains(&k.as_str())) {
        bad = true;
    }
    let mut taken: Vec<String> = Vec::new();
    for (id, default, action) in shortcuts() {
        let accelerator = match overrides.get(id) {
            Some(None) => continue,
            Some(Some(custom)) => keys::accelerator_to_gpui(custom)
                .filter(|k| !taken.contains(k))
                .or_else(|| keys::accelerator_to_gpui(default)),
            None => keys::accelerator_to_gpui(default),
        };
        if let Some(k) = &accelerator {
            taken.push(k.clone());
        }
        if let Some(binding) = accelerator.and_then(|keystroke| KeyBinding::load(&keystroke, action, None, false, None, cx).ok()) {
            bindings.push(binding);
        }
    }
    bindings.extend(input::key_bindings());
    bindings.extend(editor::key_bindings());
    cx.clear_key_bindings();
    cx.bind_keys(bindings);
    if bad {
        let warning = "keybindings の値を確認する。使えない割り当ては既定で動作中".to_string();
        let appearance = cx.global_mut::<Appearance>();
        appearance.error = Some(match appearance.error.take() {
            Some(e) => format!("{e} / {warning}"),
            None => warning,
        });
    }
}

fn set_menus(cx: &mut App) {
    cx.set_menus([
        Menu::new("terp").items([
            MenuItem::action("設定…", OpenSettings),
            MenuItem::action("設定ファイルを開く", OpenConfig),
            MenuItem::separator(),
            MenuItem::action("terp を隠す", Hide),
            MenuItem::action("ほかを隠す", HideOthers),
            MenuItem::action("すべて表示", ShowAll),
            MenuItem::separator(),
            MenuItem::action("terp を終了", Quit),
        ]),
        Menu::new("ターミナル").items([
            MenuItem::action("新しいターミナル", NewTerminal),
            MenuItem::action("右に分割", SplitRight),
            MenuItem::action("タブを閉じる", CloseTab),
            MenuItem::action("閉じたタブを開き直す", ReopenClosed),
            MenuItem::separator(),
            MenuItem::action("新しい作業…", NewWork),
            MenuItem::action("リポジトリを追加…", AddRepository),
            MenuItem::action("名前を変える", RenameTab),
            MenuItem::separator(),
            MenuItem::action("画面を消去", Clear),
            MenuItem::separator(),
            MenuItem::action("端末の中を探す", Find),
            MenuItem::action("次を探す", FindNext),
        ]),
        Menu::new("ワークスペース").items([
            MenuItem::action("ワークスペース 1", Workspace1),
            MenuItem::action("ワークスペース 2", Workspace2),
            MenuItem::action("ワークスペース 3", Workspace3),
            MenuItem::separator(),
            MenuItem::action("次のワークスペース", WorkspaceNext),
            MenuItem::action("前のワークスペース", WorkspacePrev),
        ]),
        Menu::new("編集").items([
            MenuItem::os_action("コピー", Copy, OsAction::Copy),
            MenuItem::os_action("貼り付け", Paste, OsAction::Paste),
            MenuItem::os_action("すべて選択", SelectAll, OsAction::SelectAll),
        ]),
        Menu::new("移動").items([
            MenuItem::action("直前のタブ", RecentTab),
            MenuItem::action("前のタブ", PrevTab),
            MenuItem::action("次のタブ", NextTab),
            MenuItem::action("次の要対応", NextAttention),
            MenuItem::action("全体の一覧", ToggleOverview),
            MenuItem::action("今の枠を固定", ToggleLock),
            MenuItem::separator(),
            MenuItem::action("左の枠", PaneLeft),
            MenuItem::action("右の枠", PaneRight),
            MenuItem::action("上の枠", PaneUp),
            MenuItem::action("下の枠", PaneDown),
        ]),
        Menu::new("表示").items([
            MenuItem::action("左の一覧", ToggleSidebar),
            MenuItem::action("ファイル", ToggleFiles),
            MenuItem::action("変更の一覧", ToggleChanges),
            MenuItem::action("履歴", ToggleHistory),
            MenuItem::separator(),
            MenuItem::action("ターミナルの表示を作り直す", RedrawTerminal),
            MenuItem::action("常駐のプロセスを入れ替える…", ReplaceHost),
            MenuItem::separator(),
            MenuItem::action("文字を大きく", FontBigger),
            MenuItem::action("文字を小さく", FontSmaller),
            MenuItem::action("文字を元の大きさに", FontReset),
            MenuItem::separator(),
            MenuItem::action("フルスクリーン", ToggleFullScreen),
        ]),
        Menu::new("ウインドウ").items([MenuItem::action("しまう", Minimize)]),
    ]);
}

fn open_window(cx: &mut App) {
    let bounds = Bounds::centered(None, size(px(1200.0), px(780.0)), cx);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: Some(TitlebarOptions {
            title: Some("terp".into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(12.0), px(13.0))),
        }),
        window_background: background_appearance(cx),
        window_min_size: Some(size(px(480.0), px(320.0))),
        ..Default::default()
    };
    let opened = cx.open_window(options, |window, cx| {
        // 窓ができた後でないと、ぼかしを掛ける窓の番号が無い
        window.on_next_frame(|_, cx| apply_blur(cx));
        cx.new(|cx| TerpApp::new(window, cx))
    });
    if let Err(err) = opened {
        eprintln!("窓を開けない: {err}");
        cx.quit();
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--pty-host") {
        let socket = args.get(2).map(std::path::PathBuf::from).unwrap_or_else(ptyhost::socket_path);
        if let Err(err) = ptyhost::run_host(&socket, true) {
            eprintln!("常駐のプロセスを始められない: {err}");
            std::process::exit(1);
        }
        return;
    }
    let app = application().with_assets(assets::Assets);
    app.on_reopen(|cx| {
        if cx.windows().is_empty() {
            open_window(cx);
        }
    });
    app.run(|cx: &mut App| {
        load_appearance(0.0, cx);
        bind_keys(cx);
        set_menus(cx);
        // 全画面のまま閉じると次に開いたとき黒い画面が残るため、先に全画面を抜けてから終える
        cx.on_action(|_: &Quit, cx| {
            // 保存していないファイルがあれば、終える前に確かめる
            if filetabs::UNSAVED.load(std::sync::atomic::Ordering::Relaxed) > 0 {
                let Some(window) = cx.active_window().or_else(|| cx.windows().into_iter().next()) else { return cx.quit() };
                let answer = window.update(cx, |_, window, cx| {
                    window.prompt(gpui::PromptLevel::Warning, "保存していないファイルがあります", Some("終了すると、保存していない変更は消えます。"), &["終了する", "やめる"], cx)
                });
                if let Ok(answer) = answer {
                    cx.spawn(async move |cx| {
                        if answer.await == Ok(0) {
                            filetabs::UNSAVED.store(0, std::sync::atomic::Ordering::Relaxed);
                            let _ = cx.update(|cx| cx.dispatch_action(&Quit));
                        }
                    })
                    .detach();
                }
                return;
            }
            let full = cx.windows().iter().any(|w| w.update(cx, |_, window, _| window.is_fullscreen()).unwrap_or(false));
            if !full {
                cx.quit();
                return;
            }
            for w in cx.windows() {
                let _ = w.update(cx, |_, window, _| {
                    if window.is_fullscreen() {
                        window.toggle_fullscreen();
                    }
                });
            }
            cx.spawn(async move |cx| {
                cx.background_executor().timer(std::time::Duration::from_millis(1200)).await;
                let _ = cx.update(|cx| cx.quit());
            })
            .detach();
        });
        cx.on_action(|_: &Hide, cx| cx.hide());
        cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
        cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
        cx.on_action(|_: &Minimize, cx| {
            if let Some(window) = cx.active_window() {
                let _ = window.update(cx, |_, window, _| window.minimize_window());
            }
        });
        cx.on_action(|_: &ToggleFullScreen, cx| {
            if let Some(window) = cx.active_window() {
                let _ = window.update(cx, |_, window, _| window.toggle_fullscreen());
            }
        });
        // 窓を閉じたら終了する（Electron 版と同じく、窓は1つだけ）
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        open_window(cx);
        cx.activate(true);
    });
}
