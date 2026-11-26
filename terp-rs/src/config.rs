// 設定ファイル（~/.config/terp/config.json）とテーマの読み込み。書式は Electron 版と共通にする。
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("TERP_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    home_dir().join(".config").join("terp")
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Blur {
    Flag(bool),
    Radius(f64),
}

impl Blur {
    // true は半径 20。Ghostty の background-blur と同じ読み方
    pub fn radius(&self) -> u32 {
        match self {
            Blur::Flag(true) => 20,
            Blur::Flag(false) => 0,
            Blur::Radius(radius) => radius.clamp(0.0, 100.0).round() as u32,
        }
    }
}

// Electron 版にしかない項目は読み飛ばす。値の型が違うものは既定値に戻す
#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub theme: Option<String>,
    pub accent: Option<String>,
    pub foreground: Option<String>,
    pub background: Option<String>,
    pub app_background: Option<String>,
    pub app_background_theme: Option<String>,
    pub palette: Option<BTreeMap<String, String>>,
    pub font_family: String,
    pub font_size: f32,
    pub padding_x: f32,
    pub padding_y: f32,
    pub cursor_style: String,
    pub background_opacity: f32,
    pub background_blur: Blur,
    pub minimum_contrast: f32,
    pub keybindings: BTreeMap<String, Option<String>>,
    pub notifications: bool,
    pub notify_agent_done: bool,
    pub notify_bell: bool,
    pub notify_when_visible: bool,
    pub notify_sound: bool,
    pub notify_message: bool,
    pub dock_badge: bool,
    pub permission_card: bool,
    pub confirm_draft_remove: bool,
    pub cursor_blink: bool,
    // 起動のボタンに足す・上書きする AI エージェント（項目ごとに読み、誤った項目は飛ばす）
    pub agents: Vec<serde_json::Value>,
    pub skip_approvals: bool,
    pub main_agent: Option<String>,
    pub agent_input_select: bool,
    pub agent_rename: bool,
    pub commands: Vec<serde_json::Value>,
    pub frequent_tabs: bool,
    pub pets: bool,
    pub pet_kind: String,
    pub pet_scene: String,
    pub themed_icon: bool,
    pub ai_assist: bool,
    pub ai_model: String,
    pub ai_commit_message: bool,
    pub ai_name_terminal: bool,
    pub ai_auto_title: bool,
    pub ai_daily_limit: u32,
    // 外部のエディタで開くコマンド。{file}・{line}・{col} を置き換える。空なら macOS の既定のアプリで開く
    pub editor: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            theme: None,
            accent: None,
            foreground: None,
            background: None,
            app_background: None,
            app_background_theme: None,
            palette: None,
            font_family: "\"JetBrains Mono\", Menlo, \"Hiragino Sans\", monospace".into(),
            font_size: 14.0,
            padding_x: 10.0,
            padding_y: 8.0,
            cursor_style: "block".into(),
            background_opacity: 1.0,
            background_blur: Blur::Flag(false),
            minimum_contrast: 1.0,
            keybindings: BTreeMap::new(),
            notifications: true,
            notify_agent_done: true,
            notify_bell: true,
            notify_when_visible: false,
            notify_sound: true,
            notify_message: true,
            dock_badge: true,
            permission_card: true,
            confirm_draft_remove: true,
            cursor_blink: false,
            agents: Vec::new(),
            skip_approvals: false,
            main_agent: None,
            agent_input_select: true,
            agent_rename: true,
            commands: Vec::new(),
            frequent_tabs: true,
            pets: true,
            pet_kind: "cat".into(),
            pet_scene: "grass".into(),
            themed_icon: true,
            ai_assist: true,
            ai_model: "haiku".into(),
            ai_commit_message: true,
            ai_name_terminal: true,
            ai_auto_title: false,
            ai_daily_limit: 30,
            editor: String::new(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> (Config, Option<String>) {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return (Config::default(), None),
            Err(err) => return (Config::default(), Some(format!("設定ファイルを読めない: {err}"))),
        };
        Self::parse(&text)
    }

    pub fn parse(text: &str) -> (Config, Option<String>) {
        let value: serde_json::Value = match serde_json::from_str(text) {
            Ok(value) => value,
            Err(err) => return (Config::default(), Some(format!("設定ファイルの JSON が正しくない: {err}"))),
        };
        let serde_json::Value::Object(map) = value else {
            return (Config::default(), Some("設定ファイルは JSON のオブジェクトで書く".into()));
        };
        // 1項目の誤りで全体を既定値にしないよう、項目ごとに読む
        let mut config = Config::default();
        let mut errors = Vec::new();
        for (key, value) in map {
            let single = serde_json::json!({ key.clone(): value });
            match serde_json::from_value::<Config>(single) {
                Ok(parsed) => config.merge_field(&key, parsed),
                Err(_) => errors.push(key),
            }
        }
        config.font_size = config.font_size.clamp(6.0, 72.0);
        config.background_opacity = config.background_opacity.clamp(0.2, 1.0);
        config.padding_x = config.padding_x.clamp(0.0, 40.0);
        config.padding_y = config.padding_y.clamp(0.0, 40.0);
        config.minimum_contrast = config.minimum_contrast.clamp(1.0, 21.0);
        let error = (!errors.is_empty()).then(|| format!("値の型が正しくない項目を既定値にした: {}", errors.join("・")));
        (config, error)
    }

    fn merge_field(&mut self, key: &str, parsed: Config) {
        match key {
            "theme" => self.theme = parsed.theme,
            "accent" => self.accent = parsed.accent,
            "foreground" => self.foreground = parsed.foreground,
            "background" => self.background = parsed.background,
            "appBackground" => self.app_background = parsed.app_background,
            "appBackgroundTheme" => self.app_background_theme = parsed.app_background_theme,
            "palette" => self.palette = parsed.palette,
            "fontFamily" => self.font_family = parsed.font_family,
            "fontSize" => self.font_size = parsed.font_size,
            "paddingX" => self.padding_x = parsed.padding_x,
            "paddingY" => self.padding_y = parsed.padding_y,
            "cursorStyle" => self.cursor_style = parsed.cursor_style,
            "backgroundOpacity" => self.background_opacity = parsed.background_opacity,
            "backgroundBlur" => self.background_blur = parsed.background_blur,
            "minimumContrast" => self.minimum_contrast = parsed.minimum_contrast,
            "keybindings" => self.keybindings = parsed.keybindings,
            "notifications" => self.notifications = parsed.notifications,
            "notifyAgentDone" => self.notify_agent_done = parsed.notify_agent_done,
            "notifyBell" => self.notify_bell = parsed.notify_bell,
            "notifyWhenVisible" => self.notify_when_visible = parsed.notify_when_visible,
            "dockBadge" => self.dock_badge = parsed.dock_badge,
            "notifySound" => self.notify_sound = parsed.notify_sound,
            "notifyMessage" => self.notify_message = parsed.notify_message,
            "permissionCard" => self.permission_card = parsed.permission_card,
            "confirmDraftRemove" => self.confirm_draft_remove = parsed.confirm_draft_remove,
            "cursorBlink" => self.cursor_blink = parsed.cursor_blink,
            "agents" => self.agents = parsed.agents,
            "skipApprovals" => self.skip_approvals = parsed.skip_approvals,
            "mainAgent" => self.main_agent = parsed.main_agent,
            "agentInputSelect" => self.agent_input_select = parsed.agent_input_select,
            "agentRename" => self.agent_rename = parsed.agent_rename,
            "commands" => self.commands = parsed.commands,
            "frequentTabs" => self.frequent_tabs = parsed.frequent_tabs,
            "pets" => self.pets = parsed.pets,
            "petKind" => self.pet_kind = parsed.pet_kind,
            "petScene" => self.pet_scene = parsed.pet_scene,
            "themedIcon" => self.themed_icon = parsed.themed_icon,
            "aiAssist" => self.ai_assist = parsed.ai_assist,
            "aiModel" => self.ai_model = parsed.ai_model,
            "aiCommitMessage" => self.ai_commit_message = parsed.ai_commit_message,
            "aiNameTerminal" => self.ai_name_terminal = parsed.ai_name_terminal,
            "aiAutoTitle" => self.ai_auto_title = parsed.ai_auto_title,
            "aiDailyLimit" => self.ai_daily_limit = parsed.ai_daily_limit,
            "editor" => self.editor = parsed.editor,
            _ => {}
        }
    }

    // CSS の font-family の書き方を、名前の並びに直す
    pub fn font_families(&self) -> Vec<String> {
        self.font_family
            .split(',')
            .map(|name| name.trim().trim_matches('"').trim_matches('\'').trim().to_string())
            .filter(|name| !name.is_empty() && name != "monospace")
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    pub fn parse(value: &str) -> Option<Rgb> {
        let hex = value.trim().trim_start_matches('#');
        if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let n = u32::from_str_radix(hex, 16).ok()?;
        Some(Rgb((n >> 16) as u8, (n >> 8) as u8, n as u8))
    }

    pub fn mix(self, other: Rgb, ratio: f32) -> Rgb {
        let ch = |x: u8, y: u8| (x as f32 + (y as f32 - x as f32) * ratio).round().clamp(0.0, 255.0) as u8;
        Rgb(ch(self.0, other.0), ch(self.1, other.1), ch(self.2, other.2))
    }

    fn linear(self) -> [f64; 3] {
        let lin = |v: u8| {
            let v = v as f64 / 255.0;
            if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
        };
        [lin(self.0), lin(self.1), lin(self.2)]
    }

    pub fn luminance(self) -> f64 {
        let [r, g, b] = self.linear();
        r * 0.2126 + g * 0.7152 + b * 0.0722
    }

    pub fn contrast(self, other: Rgb) -> f64 {
        let (x, y) = (self.luminance(), other.luminance());
        (x.max(y) + 0.05) / (x.min(y) + 0.05)
    }

    pub fn oklab(self) -> [f64; 3] {
        let [r, g, b] = self.linear();
        let l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b).cbrt();
        let m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b).cbrt();
        let s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b).cbrt();
        [
            0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
        ]
    }

    pub fn from_oklab([l_, a, b]: [f64; 3]) -> Rgb {
        let l = (l_ + 0.3963377774 * a + 0.2158037573 * b).powi(3);
        let m = (l_ - 0.1055613458 * a - 0.0638541728 * b).powi(3);
        let s = (l_ - 0.0894841775 * a - 1.2914855480 * b).powi(3);
        let gamma = |v: f64| {
            let v = if v <= 0.0031308 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
            (255.0 * v.clamp(0.0, 1.0)).round() as u8
        };
        Rgb(
            gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            gamma(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
        )
    }

    pub fn distance(self, other: Rgb) -> f64 {
        let (x, y) = (self.oklab(), other.oklab());
        ((x[0] - y[0]).powi(2) + (x[1] - y[1]).powi(2) + (x[2] - y[2]).powi(2)).sqrt()
    }
}

pub const BLACK: Rgb = Rgb(0, 0, 0);
pub const WHITE: Rgb = Rgb(255, 255, 255);

#[derive(Debug, Clone, PartialEq)]
pub struct Theme {
    pub palette: [Rgb; 16],
    pub background: Rgb,
    pub foreground: Rgb,
    pub cursor: Rgb,
    pub cursor_text: Rgb,
    pub app_background: Option<Rgb>,
}

// テーマを指定しないときの色（Catppuccin Mocha 相当）
pub fn builtin_theme() -> Theme {
    let p = |s: &str| Rgb::parse(s).unwrap();
    Theme {
        palette: [
            "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
            "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
        ]
        .map(p),
        background: p("#1e1e2e"),
        foreground: p("#cdd6f4"),
        cursor: p("#f5e0dc"),
        cursor_text: p("#1e1e2e"),
        app_background: None,
    }
}

pub fn parse_ghostty_theme(text: &str) -> Theme {
    let mut theme = builtin_theme();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let (key, value) = (key.trim(), value.trim());
        if key == "palette" {
            if let Some((index, color)) = value.split_once('=')
                && let (Ok(index), Some(color)) = (index.trim().parse::<usize>(), Rgb::parse(color))
                && index < 16
            {
                theme.palette[index] = color;
            }
            continue;
        }
        let Some(color) = Rgb::parse(value) else { continue };
        match key {
            "background" => theme.background = color,
            "foreground" => theme.foreground = color,
            "cursor-color" => theme.cursor = color,
            "cursor-text" => theme.cursor_text = color,
            _ => {}
        }
    }
    theme
}

// 利用者が作ったテーマの置き場所
pub fn created_theme_dir() -> PathBuf {
    config_dir().join("themes")
}

// 利用者が Ghostty 用に置いたテーマ
pub fn ghostty_theme_dir() -> PathBuf {
    home_dir().join(".config").join("ghostty").join("themes")
}

// Ghostty に付いてくるテーマ。一覧には出さないが、設定で選んだままの名前は読めるようにする
pub fn ghostty_bundled_theme_dir() -> PathBuf {
    PathBuf::from("/Applications/Ghostty.app/Contents/Resources/ghostty/themes")
}

pub fn theme_dirs() -> Vec<PathBuf> {
    vec![created_theme_dir(), ghostty_theme_dir(), ghostty_bundled_theme_dir()]
}

pub fn find_theme(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains('/') || name == "." || name == ".." {
        return None;
    }
    theme_dirs().into_iter().map(|dir| dir.join(name)).find(|file| file.is_file())
}

// テーマに設定の色の上書きを重ねる
pub fn resolve_theme(config: &Config) -> (Theme, Option<String>) {
    let (mut theme, error) = match config.theme.as_deref() {
        None => (builtin_theme(), None),
        Some(name) => match find_theme(name).and_then(|file| std::fs::read_to_string(file).ok()) {
            Some(text) => (parse_ghostty_theme(&text), None),
            None => (builtin_theme(), Some(format!("テーマ「{name}」が見つかりません"))),
        },
    };
    if let Some(color) = config.foreground.as_deref().and_then(Rgb::parse) {
        theme.foreground = color;
    }
    if let Some(color) = config.background.as_deref().and_then(Rgb::parse) {
        theme.background = color;
    }
    if let Some(palette) = &config.palette {
        for (index, color) in palette {
            if let (Ok(index), Some(color)) = (index.parse::<usize>(), Rgb::parse(color))
                && index < 16
            {
                theme.palette[index] = color;
            }
        }
    }
    // appBackground は、決めたときのテーマ（既定のテーマは空の文字）と今のテーマが同じときだけ使う。印の無い古い値は使わない
    if config.app_background_theme.as_deref() == Some(config.theme.as_deref().unwrap_or("")) {
        theme.app_background = config.app_background.as_deref().and_then(Rgb::parse);
    }
    (theme, error)
}

// 文字の色が地の色に対して ratio のコントラスト比に届かなければ、届くまで明るさをずらす。
// 地が暗ければ明るい向きを先に試し、届かなければ逆の向きも試す（xterm.js の minimumContrastRatio と同じ考え方）
pub fn ensure_contrast(fg: Rgb, bg: Rgb, ratio: f32) -> Rgb {
    let ratio = ratio as f64;
    if ratio <= 1.0 || fg.contrast(bg) >= ratio {
        return fg;
    }
    let dark_ground = bg.luminance() < 0.5;
    let order = if dark_ground { [WHITE, BLACK] } else { [BLACK, WHITE] };
    let mut best = fg;
    for target in order {
        for step in 1..=20 {
            let c = fg.mix(target, step as f32 / 20.0);
            if c.contrast(bg) >= ratio {
                return c;
            }
            if c.contrast(bg) > best.contrast(bg) {
                best = c;
            }
        }
    }
    best
}

pub fn readable_on(base: Rgb, candidates: &[Rgb]) -> Rgb {
    candidates
        .iter()
        .copied()
        .find(|c| c.contrast(base) >= 4.5)
        .unwrap_or_else(|| {
            candidates
                .iter()
                .copied()
                .fold(candidates[0], |best, c| if c.contrast(base) > best.contrast(base) { c } else { best })
        })
}

const ACCENT_MIN_CONTRAST: f64 = 3.0;

// 強調色が地の色に溶けるときは、地と反対の向きへ明るさをずらして見分けられる色にする
pub fn visible_accent(accent: Rgb, grounds: &[Rgb]) -> Rgb {
    let worst = |c: Rgb| grounds.iter().map(|g| c.contrast(*g)).fold(f64::INFINITY, f64::min);
    if worst(accent) >= ACCENT_MIN_CONTRAST {
        return accent;
    }
    let toward = if worst(BLACK) >= worst(WHITE) { BLACK } else { WHITE };
    let mut best = accent;
    for step in 1..=50 {
        let c = accent.mix(toward, step as f32 / 50.0);
        if worst(c) >= ACCENT_MIN_CONTRAST {
            return c;
        }
        if worst(c) > worst(best) {
            best = c;
        }
    }
    best
}

// 表示中の行に敷く強調色の濃さ（0〜1）。地との差が足りないテーマだけ濃くする
pub fn accent_fill(accent: Rgb, ground: Rgb) -> f32 {
    let mut fill = 22;
    while fill < 40 && ground.distance(ground.mix(accent, fill as f32 / 100.0)) < 0.12 {
        fill += 1;
    }
    fill as f32 / 100.0
}

// 選んだ範囲の色。地の補色の色合いで、文字とのコントラスト比 4.5 を目安に明るさをずらす
pub fn selection_color(background: Rgb, foreground: Rgb) -> Rgb {
    const GRAY_HUE: Rgb = Rgb(0x26, 0x4f, 0x78);
    let [l, a, b] = background.oklab();
    let [_, ga, gb] = GRAY_HUE.oklab();
    let hue = if a.hypot(b) < 0.02 { gb.atan2(ga) } else { b.atan2(a) + std::f64::consts::PI };
    let direction = if l < 0.6 { 1.0 } else { -1.0 };
    let mut best: Option<Rgb> = None;
    for sign in [direction, -direction] {
        let (low, high) = if sign == direction { (0.0, 1.0) } else { (0.15, 0.85) };
        let mut shift = 0.25;
        while shift >= 0.12 - 1e-9 {
            let lightness = l + sign * shift;
            shift -= 0.01;
            if lightness < low || lightness > high {
                continue;
            }
            let color = Rgb::from_oklab([lightness, 0.08 * hue.cos(), 0.08 * hue.sin()]);
            if color.contrast(foreground) >= 4.5 {
                return color;
            }
            if best.is_none_or(|b| color.contrast(foreground) > b.contrast(foreground)) {
                best = Some(color);
            }
        }
    }
    best.unwrap_or(GRAY_HUE)
}

// アプリの枠（左の一覧・タブ）の色。端末の色から作る
#[derive(Debug, Clone, PartialEq)]
pub struct Chrome {
    pub term_bg: Rgb,
    pub bg: Rgb,
    pub bg_hover: Rgb,
    pub bg_active: Rgb,
    pub border: Rgb,
    pub text: Rgb,
    pub text_muted: Rgb,
    pub accent: Rgb,
    pub accent_fill: f32,
    pub selection: Rgb,
}

pub fn chrome_colors(theme: &Theme, accent: Option<Rgb>) -> Chrome {
    let base = theme.app_background.unwrap_or(theme.background);
    let text = readable_on(base, &[theme.foreground, theme.background, BLACK, WHITE]);
    let bg = theme.app_background.unwrap_or_else(|| theme.background.mix(BLACK, 0.2));
    let accent = visible_accent(accent.unwrap_or(theme.cursor), &[theme.background, bg]);
    Chrome {
        term_bg: theme.background,
        bg,
        bg_hover: base.mix(text, 0.07),
        bg_active: base.mix(text, 0.14),
        border: base.mix(text, 0.22),
        text,
        text_muted: text.mix(base, 0.35),
        accent,
        accent_fill: accent_fill(accent, bg),
        selection: selection_color(theme.background, theme.foreground),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn アプリの背景色は決めたときのテーマの間だけ使う() {
        let (config, _) = Config::parse(r##"{"appBackground": "#e6ecf5"}"##);
        assert_eq!(resolve_theme(&config).0.app_background, None);
        let (config, _) = Config::parse(r##"{"appBackground": "#e6ecf5", "appBackgroundTheme": ""}"##);
        assert_eq!(resolve_theme(&config).0.app_background, Rgb::parse("#e6ecf5"));
        let (config, _) = Config::parse(r##"{"theme": "0x96f", "appBackground": "#e6ecf5", "appBackgroundTheme": ""}"##);
        assert_eq!(resolve_theme(&config).0.app_background, None);
    }

    #[test]
    fn 不正な項目だけを既定値に戻す() {
        let (config, error) = Config::parse(r#"{"fontSize": "big", "theme": "Nord", "unknownKey": 1}"#);
        assert_eq!(config.font_size, 14.0);
        assert_eq!(config.theme.as_deref(), Some("Nord"));
        assert!(error.unwrap().contains("fontSize"));
    }

    #[test]
    fn ぼかしは真偽値と半径の両方を読む() {
        assert_eq!(Config::parse(r#"{"backgroundBlur": true}"#).0.background_blur.radius(), 20);
        assert_eq!(Config::parse(r#"{"backgroundBlur": 4}"#).0.background_blur.radius(), 4);
        assert_eq!(Config::parse(r#"{"backgroundBlur": 0}"#).0.background_blur.radius(), 0);
    }

    #[test]
    fn フォントの並びから引用符と総称名を外す() {
        let config = Config::parse(r#"{"fontFamily": "\"JetBrains Mono\", Menlo, 'Hiragino Sans', monospace"}"#).0;
        assert_eq!(config.font_families(), vec!["JetBrains Mono", "Menlo", "Hiragino Sans"]);
    }

    #[test]
    fn ghostty_のテーマを読む() {
        let theme = parse_ghostty_theme("palette = 1=#ff0000\nbackground = 101010\nforeground=#eeeeee\ncursor-color = #00ff00\n# comment");
        assert_eq!(theme.palette[1], Rgb(255, 0, 0));
        assert_eq!(theme.background, Rgb(0x10, 0x10, 0x10));
        assert_eq!(theme.foreground, Rgb(0xee, 0xee, 0xee));
        assert_eq!(theme.cursor, Rgb(0, 255, 0));
    }

    #[test]
    fn 地に溶ける強調色は見分けられる明るさへずらす() {
        let ground = Rgb(0x1e, 0x1e, 0x2e);
        let accent = visible_accent(Rgb(0x22, 0x22, 0x33), &[ground]);
        assert!(accent.contrast(ground) >= ACCENT_MIN_CONTRAST);
        let bright = Rgb(0xf5, 0xe0, 0xdc);
        assert_eq!(visible_accent(bright, &[ground]), bright);
    }

    #[test]
    fn 選択色は文字が読める濃さにする() {
        let (bg, fg) = (Rgb(0x1e, 0x1e, 0x2e), Rgb(0xcd, 0xd6, 0xf4));
        assert!(selection_color(bg, fg).contrast(fg) >= 4.5);
        let (bg, fg) = (Rgb(0xff, 0xff, 0xff), Rgb(0x33, 0x33, 0x33));
        assert!(selection_color(bg, fg).contrast(fg) >= 4.5);
    }

    #[test]
    fn 薄い文字は指定のコントラスト比まで濃くする() {
        let bg = Rgb(0xe6, 0xec, 0xf5);
        let fg = Rgb(0xc0, 0xc8, 0xd0);
        let adjusted = ensure_contrast(fg, bg, 3.0);
        assert!(adjusted.contrast(bg) >= 3.0);
        assert_eq!(ensure_contrast(BLACK, bg, 3.0), BLACK);
        assert_eq!(ensure_contrast(fg, bg, 1.0), fg);
    }

    #[test]
    fn ぼかしの半径() {
        assert_eq!(Blur::Flag(true).radius(), 20);
        assert_eq!(Blur::Radius(4.0).radius(), 4);
        assert_eq!(Blur::Radius(400.0).radius(), 100);
    }

    #[test]
    fn oklab_の往復で色が戻る() {
        let color = Rgb(0x89, 0xb4, 0xfa);
        assert_eq!(Rgb::from_oklab(color.oklab()), color);
    }
}
