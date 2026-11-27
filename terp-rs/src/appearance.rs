// 画面全体で共有する見た目（設定・テーマ・フォント）
use crate::config::{Chrome, Config, Rgb, Theme, chrome_colors, resolve_theme};
use gpui::{App, Font, FontFallbacks, Global, Hsla, Pixels, Rgba, font, px};
use std::sync::Arc;

pub struct Appearance {
    pub config: Config,
    pub theme: Theme,
    pub chrome: Chrome,
    pub font: Font,
    pub font_size: Pixels,
    pub error: Option<String>,
}

impl Global for Appearance {}

pub fn hsla(color: Rgb, alpha: f32) -> Hsla {
    Rgba { r: color.0 as f32 / 255.0, g: color.1 as f32 / 255.0, b: color.2 as f32 / 255.0, a: alpha }.into()
}

impl Appearance {
    pub fn build(config: Config, config_error: Option<String>, font_delta: f32, cx: &App) -> Appearance {
        let (theme, theme_error) = resolve_theme(&config);
        let accent = config.accent.as_deref().and_then(Rgb::parse);
        let chrome = chrome_colors(&theme, accent);
        let installed = cx.text_system().all_font_names();
        let families = config.font_families();
        // 入っていないフォントは飛ばし、残りを予備の字形（日本語など）に回す
        let mut available: Vec<String> = families.into_iter().filter(|name| installed.iter().any(|f| f == name)).collect();
        if available.is_empty() {
            available.push("Menlo".into());
        }
        if !available.iter().any(|f| f == "Hiragino Sans") {
            available.push("Hiragino Sans".into());
        }
        let mut primary = font(available.remove(0));
        primary.fallbacks = Some(FontFallbacks(Arc::new(available)));
        let font_size = px((config.font_size + font_delta).clamp(6.0, 72.0));
        let error = [config_error, theme_error].into_iter().flatten().collect::<Vec<_>>();
        Appearance {
            config,
            theme,
            chrome,
            font: primary,
            font_size,
            error: (!error.is_empty()).then(|| error.join("。")),
        }
    }

    pub fn opacity(&self) -> f32 {
        self.config.background_opacity
    }
}
