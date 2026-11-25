// エージェント（claude など）の画面から、入力欄の場所と中身を探す。
// 入力欄はカーソルの行から上下へ、横線・枠の角・背景色の切れ目まで広げ、❯ › > で始まる行からを入力とみなす。
use regex::Regex;
use std::sync::LazyLock;

static PROMPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\s*)[❯›>]\s").unwrap());
static RULE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[╭╰┌└]?[─━]{3,}[╮╯┐┘]?\s*$").unwrap());
static SIDE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\s*[│┃]\s?)(.*?)(\s?[│┃]\s*)?$").unwrap());
const MAX_ROWS: usize = 40;

pub struct LineInfo {
    // 1マス1文字（全角の後ろの空きは除く）
    pub text: String,
    // 文字ごとの桁
    pub cols: Vec<usize>,
    // 行の中ほどの背景（既定の背景なら None）
    pub bg: Option<u32>,
    // その桁の文字が薄い（案内の文字）
    pub dim: Vec<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InputBox {
    // 行と文字の位置
    pub start: (usize, usize),
    pub end: (usize, usize),
    pub text: String,
}

fn is_rule(text: &str, cols: usize) -> bool {
    RULE.is_match(text) && text.trim().chars().count() * 2 >= cols
}

fn is_edge(lines: &[LineInfo], y: usize, cols: usize, bg: Option<u32>) -> bool {
    is_rule(&lines[y].text, cols) || lines[y].bg != bg
}

fn bounds(lines: &[LineInfo], cols: usize, row: usize) -> Option<(usize, usize)> {
    let bg = lines[row].bg;
    let mut top = row;
    while top > 0 && row - top < MAX_ROWS && !is_edge(lines, top - 1, cols, bg) {
        top -= 1;
    }
    let mut bottom = row;
    while bottom + 1 < lines.len() && bottom - row < MAX_ROWS && !is_edge(lines, bottom + 1, cols, bg) {
        bottom += 1;
    }
    if top == 0 || bottom == lines.len() - 1 || row - top >= MAX_ROWS || bottom - row >= MAX_ROWS {
        return None;
    }
    Some((top, bottom))
}

// 左右の │ ┃ を除いた中身と、その始まりの文字の位置
fn inner(text: &str) -> (usize, String) {
    if let Some(c) = SIDE.captures(text) {
        let side = c.get(1).map(|m| m.as_str()).unwrap_or("");
        if side.contains(['│', '┃']) {
            return (side.chars().count(), c.get(2).map(|m| m.as_str().to_string()).unwrap_or_default());
        }
    }
    (0, text.to_string())
}

pub fn find(lines: &[LineInfo], cols: usize, cursor_row: usize) -> Option<InputBox> {
    if cursor_row >= lines.len() {
        return None;
    }
    let (top, bottom) = bounds(lines, cols, cursor_row)?;
    let mut start = None;
    let mut indent = 0;
    for (y, line) in lines.iter().enumerate().take(bottom + 1).skip(top) {
        let (col, text) = inner(&line.text);
        if let Some(m) = PROMPT.find(&text) {
            start = Some(y);
            indent = col + m.as_str().chars().count();
            break;
        }
    }
    let start = start?;
    if cursor_row < start {
        return None;
    }
    let mut rows: Vec<String> = Vec::new();
    for line in &lines[start..=bottom] {
        let (col, text) = inner(&line.text);
        rows.push(format!("{}{}", " ".repeat(col), text).trim_end().to_string());
    }
    while rows.len() > 1 && rows.last().is_some_and(|r| r.trim().is_empty()) {
        rows.pop();
    }
    let empty = InputBox { start: (start, indent), end: (start, indent), text: String::new() };
    // 空の入力欄に出る薄い案内は、入力に数えない
    if lines[start].dim.get(indent).copied().unwrap_or(false) {
        return Some(empty);
    }
    let body: Vec<String> = rows
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let chars: Vec<char> = t.chars().collect();
            let skip = if i == 0 { indent } else { indent.min(chars.len() - t.trim_start().chars().count()) };
            chars.iter().skip(skip).collect()
        })
        .collect();
    if body.iter().all(|b| b.is_empty()) {
        return Some(empty);
    }
    let end_row = start + rows.len() - 1;
    let last_len = rows.last().map(|r| r.chars().count()).unwrap_or(0);
    Some(InputBox { start: (start, indent), end: (end_row, last_len.max(if end_row == start { indent } else { 0 })), text: body.join("\n") })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(texts: &[&str]) -> Vec<LineInfo> {
        texts.iter().map(|t| LineInfo { text: t.to_string(), cols: (0..t.chars().count()).collect(), bg: None, dim: vec![false; t.chars().count()] }).collect()
    }

    #[test]
    fn 枠の中の入力を拾う() {
        let l = lines(&["出力", "╭────────────────────╮", "│ > こんにちは       │", "│   続きの行         │", "╰────────────────────╯", "? for shortcuts"]);
        let b = find(&l, 22, 2).unwrap();
        assert_eq!(b.text, "こんにちは\n続きの行");
        assert_eq!(b.start, (2, 4));
    }

    #[test]
    fn 空の入力欄() {
        let l = lines(&["出力", "────────────────────", "❯ ", "────────────────────", "下"]);
        assert_eq!(find(&l, 20, 2).unwrap().text, "");
    }

    #[test]
    fn 入力欄が無ければ_none() {
        let l = lines(&["a", "b", "c"]);
        assert!(find(&l, 10, 1).is_none());
    }
}
