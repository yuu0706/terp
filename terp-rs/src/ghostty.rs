// Ghostty の設定（テーマ・フォント・透過・余白・コントラスト・カーソル）を terp の設定へ写す。1回きりで、監視しない。
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub fn config_paths() -> Vec<PathBuf> {
    if let Ok(p) = std::env::var("TERP_GHOSTTY_CONFIG") {
        return vec![PathBuf::from(p)];
    }
    let home = crate::config::home_dir();
    let xdg = std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|_| home.join(".config"));
    let support = home.join("Library/Application Support/com.mitchellh.ghostty");
    vec![xdg.join("ghostty/config.ghostty"), xdg.join("ghostty/config"), support.join("config.ghostty"), support.join("config")]
}

pub fn parse(text: &str) -> Vec<(String, String)> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let (k, v) = l.split_once('=')?;
            let mut v = v.trim();
            if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
                v = &v[1..v.len() - 1];
            }
            (!k.trim().is_empty()).then(|| (k.trim().to_string(), v.to_string()))
        })
        .collect()
}

// config-file は記述元の末尾で順に読む。同じ実体は1回だけ。? 付きの欠落は無視する
pub fn read() -> Result<(Vec<(String, String)>, Vec<PathBuf>), String> {
    let home = crate::config::home_dir();
    let mut entries = Vec::new();
    let mut files = Vec::new();
    let mut visited = HashSet::new();
    fn go(file: &Path, optional: bool, home: &Path, entries: &mut Vec<(String, String)>, files: &mut Vec<PathBuf>, visited: &mut HashSet<PathBuf>) -> Result<(), String> {
        let canonical = std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
        if visited.contains(&canonical) {
            return Ok(());
        }
        let text = match std::fs::read_to_string(file) {
            Ok(t) => t,
            Err(e) if optional && e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("Ghostty の設定を読めない: {}（{e}）", file.display())),
        };
        visited.insert(canonical);
        files.push(file.to_path_buf());
        let mut includes = Vec::new();
        for (k, v) in parse(&text) {
            if k == "config-file" { includes.push(v) } else { entries.push((k, v)) }
        }
        for inc in includes {
            let (optional, inc) = match inc.strip_prefix('?') { Some(r) => (true, r.to_string()), None => (false, inc) };
            if inc.is_empty() {
                return Err(format!("config-file のパスを指定する: {}", file.display()));
            }
            let path = match inc.strip_prefix("~/") { Some(r) => home.join(r), None => file.parent().unwrap_or(Path::new("/")).join(inc) };
            go(&path, optional, home, entries, files, visited)?;
        }
        Ok(())
    }
    for p in config_paths() {
        go(&p, true, &home, &mut entries, &mut files, &mut visited)?;
    }
    Ok((entries, files))
}

// 写す値と、写さない項目と理由
pub fn map(entries: &[(String, String)], theme_exists: impl Fn(&str) -> bool) -> (Map<String, Value>, Vec<(String, String, String)>) {
    let mut changes = Map::new();
    let mut skipped = Vec::new();
    let mut latest: Vec<(String, (String, String))> = Vec::new();
    let mut families: Vec<String> = Vec::new();
    let mut palette = Map::new();
    let hex = |v: &str| {
        let h = v.trim_start_matches('#');
        (h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit())).then(|| format!("#{}", h.to_lowercase()))
    };
    for (k, v) in entries {
        if k == "font-family" {
            if v.is_empty() { families.clear() } else { families.push(v.clone()) }
        }
        if k == "palette" {
            let parsed = v.split_once('=').and_then(|(n, c)| n.trim().parse::<u8>().ok().filter(|n| *n < 16).zip(hex(c.trim())));
            match parsed {
                Some((n, c)) => {
                    palette.insert(n.to_string(), Value::String(c));
                }
                None => skipped.push((k.clone(), v.clone(), "0〜15 の番号と #rrggbb の色で指定する".into())),
            }
            continue;
        }
        let key = if k == "background-blur-radius" { "background-blur".to_string() } else { k.clone() };
        latest.retain(|(x, _)| *x != key);
        latest.push((key, (k.clone(), v.clone())));
    }
    let num = |v: &str| v.trim().parse::<f64>().ok().filter(|n| n.is_finite());
    for (key, (orig, value)) in latest {
        let mut skip = |reason: &str| skipped.push((orig.clone(), value.clone(), reason.to_string()));
        let mut bounded = |name: &str, min: f64, max: f64, changes: &mut Map<String, Value>| match num(&value) {
            Some(n) => {
                changes.insert(name.into(), json!(n.clamp(min, max)));
                None
            }
            None => Some("数値で指定する"),
        };
        match key.as_str() {
            "theme" => {
                let name = if value.starts_with("light:") || value.starts_with("dark:") {
                    value.split(',').map(str::trim).find_map(|p| p.strip_prefix("dark:")).map(|s| s.trim().to_string())
                } else {
                    Some(value.clone())
                };
                match name.filter(|n| theme_exists(n)) {
                    Some(n) => {
                        changes.insert("theme".into(), Value::String(n));
                    }
                    None => skip("テーマが見つからない"),
                }
            }
            "font-family" => {
                let mut list: Vec<String> = families.iter().map(|f| format!("\"{f}\"")).collect();
                list.extend(["Menlo".into(), "\"Hiragino Sans\"".into(), "monospace".into()]);
                changes.insert("fontFamily".into(), Value::String(list.join(", ")));
            }
            "font-size" => {
                if let Some(r) = bounded("fontSize", 9.0, 32.0, &mut changes) {
                    skip(r)
                }
            }
            "background-opacity" => {
                if let Some(r) = bounded("backgroundOpacity", 0.2, 1.0, &mut changes) {
                    skip(r)
                }
            }
            "minimum-contrast" => {
                if let Some(r) = bounded("minimumContrast", 1.0, 21.0, &mut changes) {
                    skip(r)
                }
            }
            "background-blur" => {
                if value == "true" || value == "false" {
                    changes.insert("backgroundBlur".into(), Value::Bool(value == "true"));
                } else if let Some(r) = bounded("backgroundBlur", 0.0, 100.0, &mut changes) {
                    skip(r)
                }
            }
            "window-padding-x" | "window-padding-y" => {
                let parts: Vec<Option<f64>> = value.split(',').map(|p| num(p)).collect();
                if parts.len() > 2 || parts.iter().any(|p| p.is_none_or(|n| n < 0.0)) {
                    skip("余白は0以上の数値を1つか2つ指定する");
                } else {
                    let avg = parts.iter().flatten().sum::<f64>() / parts.len() as f64;
                    changes.insert(if key == "window-padding-x" { "paddingX" } else { "paddingY" }.into(), json!(avg.round().clamp(0.0, 40.0)));
                }
            }
            "cursor-style" => match value.as_str() {
                "block" | "bar" | "underline" => {
                    changes.insert("cursorStyle".into(), Value::String(value.clone()));
                }
                "block_hollow" => {
                    changes.insert("cursorStyle".into(), Value::String("block".into()));
                    skip("中抜きの形は使えないため block にする");
                }
                _ => skip("カーソルの形が見つからない"),
            },
            "cursor-style-blink" => {
                if value == "true" || value == "false" {
                    changes.insert("cursorBlink".into(), Value::Bool(value == "true"));
                } else {
                    skip("true か false で指定する");
                }
            }
            "foreground" | "background" => match hex(&value) {
                Some(c) => {
                    changes.insert(key.clone(), Value::String(c));
                }
                None => skip("#rrggbb の色で指定する（色の名前は読めない）"),
            },
            "macos-option-as-alt" => skip("terp は常に Meta"),
            _ => skip("terp に無い"),
        }
    }
    if !palette.is_empty() {
        changes.insert("palette".into(), Value::Object(palette));
    }
    (changes, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 写し方() {
        let e = parse("theme = light:Day,dark:Night\nfont-family = A\nfont-family = B\nwindow-padding-x = 4,9\npalette = 1=#FF0000\ncursor-style = block_hollow\nbold-color = #fff\n");
        let (c, s) = map(&e, |n| n == "Night");
        assert_eq!(c["theme"], "Night");
        assert_eq!(c["fontFamily"], "\"A\", \"B\", Menlo, \"Hiragino Sans\", monospace");
        assert_eq!(c["paddingX"], 7.0);
        assert_eq!(c["palette"]["1"], "#ff0000");
        assert_eq!(c["cursorStyle"], "block");
        assert!(s.iter().any(|(k, _, r)| k == "bold-color" && r == "terp に無い"));
    }
}
