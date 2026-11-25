// 画面で使う絵（アイコン・エージェントの印）。実行ファイルに埋め込む。
use gpui::{AssetSource, SharedString};
use rust_embed::RustEmbed;
use std::borrow::Cow;

#[derive(RustEmbed)]
#[folder = "assets/"]
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        Ok(Self::get(path).map(|f| f.data))
    }

    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(Self::iter().filter(|p| p.starts_with(path)).map(SharedString::from).collect())
    }
}

pub fn has(path: &str) -> bool {
    Assets::get(path).is_some()
}
