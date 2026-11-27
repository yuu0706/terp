// 画面で使う絵（アイコン・エージェントの印）。実行ファイルに埋め込む。
use gpui::{AssetSource, SharedString};
use rust_embed::RustEmbed;
use std::borrow::Cow;

#[derive(RustEmbed)]
#[folder = "assets/"]
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        let data = Self::get(path).map(|f| f.data);
        // エージェントの絵は大きさが 1em で、そのまま色付きで描くと 1em の大きさで画素にされ、Retina でぼやける。
        // 元のファイルは配布元のまま残したいので、読むときに大きく描かせる
        if path.starts_with("agents/") && path.ends_with(".svg") {
            return Ok(data.map(|d| Cow::Owned(enlarge_svg(&d))));
        }
        Ok(data)
    }

    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(Self::iter().filter(|p| p.starts_with(path)).map(SharedString::from).collect())
    }
}

pub fn has(path: &str) -> bool {
    Assets::get(path).is_some()
}

fn enlarge_svg(data: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(data);
    let Some(end) = text.find('>') else { return data.to_vec() };
    let head = text[..end].replacen("width=\"1em\"", "width=\"96\"", 1).replacen("height=\"1em\"", "height=\"96\"", 1);
    format!("{head}{}", &text[end..]).into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn エージェントの絵は最初の要素の大きさだけを広げる() {
        let svg = br#"<svg height="1em" viewBox="0 0 24 24" width="1em"><rect width="1em" height="1em"/></svg>"#;
        let out = String::from_utf8(enlarge_svg(svg)).unwrap();
        assert_eq!(out, r#"<svg height="96" viewBox="0 0 24 24" width="96"><rect width="1em" height="1em"/></svg>"#);
    }
}
