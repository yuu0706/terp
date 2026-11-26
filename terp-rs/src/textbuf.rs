// ファイルの編集の中身。文字・行の位置・選択・取り消しを持ち、画面を知らない。
use std::ops::Range;
use std::time::{Duration, Instant};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug)]
struct Edit {
    at: usize,
    removed: String,
    inserted: String,
    before: (Range<usize>, bool),
    after: (Range<usize>, bool),
    time: Instant,
}

pub struct TextBuffer {
    text: String,
    line_starts: Vec<usize>,
    pub selected: Range<usize>,
    pub reversed: bool,
    // ↑↓ で動くときに保つ桁（文字の数）
    preferred_col: Option<usize>,
    undo: Vec<Edit>,
    redo: Vec<Edit>,
    // 変えるたびに増える。保存した時点の値と比べて、未保存かを見る
    pub version: u64,
    pub crlf: bool,
    indent_unit: String,
}

// 続けて打った字は、1秒以内なら1回の取り消しにまとめる
const MERGE_WINDOW: Duration = Duration::from_millis(1000);

fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
    starts
}

// 字下げの単位。タブで始まる行が多ければタブ、無ければ空白の最小の幅（2 か 4）
fn detect_indent(text: &str) -> String {
    let (mut tabs, mut spaces) = (0, Vec::new());
    for line in text.lines().take(2000) {
        if line.starts_with('\t') {
            tabs += 1;
        } else {
            let n = line.len() - line.trim_start_matches(' ').len();
            if n > 0 && !line.trim().is_empty() {
                spaces.push(n);
            }
        }
    }
    if tabs > spaces.len() {
        return "\t".into();
    }
    let unit = spaces.iter().min().map(|n| (*n).clamp(2, 8)).unwrap_or(4);
    " ".repeat(unit)
}

impl TextBuffer {
    pub fn new(text: &str) -> Self {
        let crlf = text.contains("\r\n");
        let text = text.replace("\r\n", "\n");
        let indent_unit = detect_indent(&text);
        TextBuffer { line_starts: line_starts(&text), text, selected: 0..0, reversed: false, preferred_col: None, undo: Vec::new(), redo: Vec::new(), version: 0, crlf, indent_unit }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    // 保存するときの中身。元が CRLF なら戻す
    pub fn file_text(&self) -> String {
        if self.crlf { self.text.replace('\n', "\r\n") } else { self.text.clone() }
    }

    // 外で変わったファイルを読み直す。取り消しの履歴は捨て、選択は範囲の中に収める
    pub fn reload(&mut self, text: &str) {
        let cursor = self.cursor();
        *self = TextBuffer { version: self.version + 1, ..TextBuffer::new(text) };
        let at = self.clamp(cursor);
        self.selected = at..at;
    }

    pub fn line_count(&self) -> usize {
        self.line_starts.len()
    }

    pub fn line_start(&self, line: usize) -> usize {
        self.line_starts[line.min(self.line_starts.len() - 1)]
    }

    pub fn line_end(&self, line: usize) -> usize {
        match self.line_starts.get(line + 1) {
            Some(next) => next - 1,
            None => self.text.len(),
        }
    }

    pub fn line(&self, line: usize) -> &str {
        &self.text[self.line_start(line)..self.line_end(line)]
    }

    pub fn line_of(&self, offset: usize) -> usize {
        match self.line_starts.binary_search(&offset) {
            Ok(i) => i,
            Err(i) => i - 1,
        }
    }

    pub fn cursor(&self) -> usize {
        if self.reversed { self.selected.start } else { self.selected.end }
    }

    fn clamp(&self, offset: usize) -> usize {
        let mut at = offset.min(self.text.len());
        while !self.text.is_char_boundary(at) {
            at -= 1;
        }
        at
    }

    pub fn selected_text(&self) -> &str {
        &self.text[self.selected.clone()]
    }

    // ---- 選択と移動 ----

    pub fn set_selection(&mut self, range: Range<usize>, reversed: bool) {
        let (a, b) = (self.clamp(range.start), self.clamp(range.end));
        self.selected = a.min(b)..a.max(b);
        self.reversed = reversed && a != b;
    }

    pub fn move_to(&mut self, offset: usize, select: bool) {
        let offset = self.clamp(offset);
        if !select {
            self.selected = offset..offset;
            self.reversed = false;
            return;
        }
        let anchor = if self.reversed { self.selected.end } else { self.selected.start };
        if offset < anchor {
            self.selected = offset..anchor;
            self.reversed = true;
        } else {
            self.selected = anchor..offset;
            self.reversed = false;
        }
    }

    pub fn select_all(&mut self) {
        self.selected = 0..self.text.len();
        self.reversed = false;
    }

    fn prev_grapheme(&self, offset: usize) -> usize {
        self.text[..offset].grapheme_indices(true).next_back().map(|(i, _)| i).unwrap_or(0)
    }

    fn next_grapheme(&self, offset: usize) -> usize {
        self.text[offset..].graphemes(true).next().map(|g| offset + g.len()).unwrap_or(self.text.len())
    }

    fn prev_word(&self, offset: usize) -> usize {
        self.text[..offset].unicode_word_indices().next_back().map(|(i, _)| i).unwrap_or(0)
    }

    fn next_word(&self, offset: usize) -> usize {
        self.text[offset..].unicode_word_indices().next().map(|(i, w)| offset + i + w.len()).unwrap_or(self.text.len())
    }

    pub fn left(&mut self, select: bool, word: bool) {
        self.preferred_col = None;
        if !select && !self.selected.is_empty() && !word {
            let to = self.selected.start;
            self.move_to(to, false);
            return;
        }
        let at = self.cursor();
        let to = if word { self.prev_word(at) } else { self.prev_grapheme(at) };
        self.move_to(to, select);
    }

    pub fn right(&mut self, select: bool, word: bool) {
        self.preferred_col = None;
        if !select && !self.selected.is_empty() && !word {
            let to = self.selected.end;
            self.move_to(to, false);
            return;
        }
        let at = self.cursor();
        let to = if word { self.next_word(at) } else { self.next_grapheme(at) };
        self.move_to(to, select);
    }

    fn col_of(&self, offset: usize) -> usize {
        let line = self.line_of(offset);
        self.text[self.line_start(line)..offset].chars().count()
    }

    fn offset_at_col(&self, line: usize, col: usize) -> usize {
        let start = self.line_start(line);
        self.line(line).char_indices().nth(col).map(|(i, _)| start + i).unwrap_or(self.line_end(line))
    }

    // 行を上下に動く。先頭・末尾の行を越えるときは、その行の端へ動く
    pub fn vertical(&mut self, rows: isize, select: bool) {
        let at = self.cursor();
        let col = *self.preferred_col.get_or_insert(self.col_of(at));
        let line = self.line_of(at) as isize + rows;
        let to = if line < 0 {
            0
        } else if line as usize >= self.line_count() {
            self.text.len()
        } else {
            self.offset_at_col(line as usize, col)
        };
        self.move_to(to, select);
    }

    // 行の頭へ。字下げの後ろと本当の行頭を行き来する
    pub fn home(&mut self, select: bool) {
        self.preferred_col = None;
        let at = self.cursor();
        let line = self.line_of(at);
        let start = self.line_start(line);
        let text = self.line(line);
        let indent = start + (text.len() - text.trim_start().len());
        let to = if at == indent { start } else { indent };
        self.move_to(to, select);
    }

    pub fn end(&mut self, select: bool) {
        self.preferred_col = None;
        let to = self.line_end(self.line_of(self.cursor()));
        self.move_to(to, select);
    }

    pub fn doc_edge(&mut self, end: bool, select: bool) {
        self.preferred_col = None;
        self.move_to(if end { self.text.len() } else { 0 }, select);
    }

    // ダブルクリックで単語、トリプルクリックで行を選ぶ
    pub fn word_range(&self, offset: usize) -> Range<usize> {
        let line = self.line_of(offset);
        let start = self.line_start(line);
        for (i, w) in self.line(line).split_word_bound_indices() {
            let (a, b) = (start + i, start + i + w.len());
            if offset >= a && offset < b || (offset == b && b == self.line_end(line)) {
                return a..b;
            }
        }
        offset..offset
    }

    pub fn line_range(&self, offset: usize) -> Range<usize> {
        let line = self.line_of(offset);
        let end = self.line_starts.get(line + 1).copied().unwrap_or(self.text.len());
        self.line_start(line)..end
    }

    // ---- 書き換え ----

    pub fn replace(&mut self, range: Range<usize>, text: &str) {
        let range = self.clamp(range.start)..self.clamp(range.end);
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        let before = (self.selected.clone(), self.reversed);
        let removed = self.text[range.clone()].to_string();
        if removed.is_empty() && text.is_empty() {
            return;
        }
        self.text.replace_range(range.clone(), &text);
        self.line_starts = line_starts(&self.text);
        let end = range.start + text.len();
        self.selected = end..end;
        self.reversed = false;
        self.preferred_col = None;
        self.version += 1;
        self.redo.clear();
        let now = Instant::now();
        let edit = Edit { at: range.start, removed, inserted: text, before, after: (self.selected.clone(), false), time: now };
        if let Some(last) = self.undo.last_mut()
            && now.duration_since(last.time) < MERGE_WINDOW
            && last.removed.is_empty()
            && edit.removed.is_empty()
            && last.at + last.inserted.len() == edit.at
            && !edit.inserted.contains('\n')
            && edit.inserted.chars().count() == 1
        {
            last.inserted.push_str(&edit.inserted);
            last.after = edit.after;
            last.time = now;
            return;
        }
        self.undo.push(edit);
    }

    pub fn insert(&mut self, text: &str) {
        let range = self.selected.clone();
        self.replace(range, text);
    }

    pub fn backspace(&mut self, word: bool, to_line_start: bool) {
        if !self.selected.is_empty() {
            return self.insert("");
        }
        let at = self.cursor();
        let from = if to_line_start {
            self.line_start(self.line_of(at))
        } else if word {
            self.prev_word(at)
        } else {
            // 字下げの中なら、字下げの1段ぶんを消す
            let line_start = self.line_start(self.line_of(at));
            let before = &self.text[line_start..at];
            let unit = self.indent_unit.len();
            if self.indent_unit != "\t" && !before.is_empty() && before.chars().all(|c| c == ' ') {
                at - (before.len() - 1) % unit - 1
            } else {
                self.prev_grapheme(at)
            }
        };
        let from = if from == at && at > 0 { self.prev_grapheme(at) } else { from };
        self.replace(from..at, "");
    }

    pub fn delete_forward(&mut self, word: bool) {
        if !self.selected.is_empty() {
            return self.insert("");
        }
        let at = self.cursor();
        let to = if word { self.next_word(at) } else { self.next_grapheme(at) };
        self.replace(at..to, "");
    }

    // 改行して、今の行の字下げを引き継ぐ
    pub fn newline(&mut self) {
        let line = self.line_of(self.selected.start);
        let text = self.line(line);
        let indent: String = text.chars().take_while(|c| *c == ' ' || *c == '\t').collect();
        let indent = &indent[..indent.len().min(self.selected.start - self.line_start(line))];
        self.insert(&format!("\n{indent}"));
    }

    // Tab。選択が複数行にまたがれば各行を1段下げ、そうでなければ字下げを挟む
    pub fn indent(&mut self) {
        let (first, last) = (self.line_of(self.selected.start), self.line_of(self.selected.end));
        if first == last {
            let unit = self.indent_unit.clone();
            return self.insert(&unit);
        }
        let last = if self.selected.end == self.line_start(last) && last > first { last - 1 } else { last };
        self.change_lines(first, last, |line, unit| if line.is_empty() { line.to_string() } else { format!("{unit}{line}") });
    }

    // ⇧Tab。選んだ行（無ければ今の行）を1段上げる
    pub fn outdent(&mut self) {
        let (first, last) = (self.line_of(self.selected.start), self.line_of(self.selected.end));
        let last = if self.selected.end == self.line_start(last) && last > first { last - 1 } else { last };
        self.change_lines(first, last, |line, unit| {
            if let Some(rest) = line.strip_prefix(unit) {
                rest.to_string()
            } else {
                line.trim_start_matches(|c| c == ' ' || c == '\t').to_string()
            }
        });
    }

    fn change_lines(&mut self, first: usize, last: usize, f: impl Fn(&str, &str) -> String) {
        let start = self.line_start(first);
        let end = self.line_end(last);
        let unit = self.indent_unit.clone();
        let changed: Vec<String> = (first..=last).map(|l| f(self.line(l), &unit)).collect();
        let joined = changed.join("\n");
        if joined == self.text[start..end] {
            return;
        }
        self.replace(start..end, &joined);
        self.selected = start..start + joined.len();
    }

    pub fn undo(&mut self) -> bool {
        let Some(edit) = self.undo.pop() else { return false };
        self.text.replace_range(edit.at..edit.at + edit.inserted.len(), &edit.removed);
        self.line_starts = line_starts(&self.text);
        self.selected = edit.before.0.clone();
        self.reversed = edit.before.1;
        self.version += 1;
        self.redo.push(edit);
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(edit) = self.redo.pop() else { return false };
        self.text.replace_range(edit.at..edit.at + edit.removed.len(), &edit.inserted);
        self.line_starts = line_starts(&self.text);
        self.selected = edit.after.0.clone();
        self.reversed = edit.after.1;
        self.version += 1;
        self.undo.push(edit);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buf(text: &str, at: usize) -> TextBuffer {
        let mut b = TextBuffer::new(text);
        b.move_to(at, false);
        b
    }

    #[test]
    fn 行の位置を引ける() {
        let b = TextBuffer::new("ab\ncde\n\nf");
        assert_eq!(b.line_count(), 4);
        assert_eq!((b.line(1), b.line(2), b.line(3)), ("cde", "", "f"));
        assert_eq!((b.line_of(0), b.line_of(3), b.line_of(6), b.line_of(7)), (0, 1, 1, 2));
    }

    #[test]
    fn crlf_は読むときに直し_保存するときに戻す() {
        let mut b = TextBuffer::new("a\r\nb");
        assert_eq!(b.text(), "a\nb");
        b.move_to(3, false);
        b.insert("c");
        assert_eq!(b.file_text(), "a\r\nbc");
    }

    #[test]
    fn 上下の移動は桁を保ち_短い行では行末に止まる() {
        let mut b = buf("abcdef\nab\nabcdef", 5);
        b.vertical(1, false);
        assert_eq!(b.cursor(), 9);
        b.vertical(1, false);
        assert_eq!(b.cursor(), 15);
        b.vertical(1, false);
        assert_eq!(b.cursor(), b.text().len());
    }

    #[test]
    fn 改行は字下げを引き継ぐ() {
        let mut b = buf("    let a = 1;", 14);
        b.newline();
        assert_eq!(b.text(), "    let a = 1;\n    ");
    }

    #[test]
    fn 字下げの中の後退は1段ぶん消す() {
        let mut b = buf("fn a() {\n    x\n}", 13);
        b.backspace(false, false);
        assert_eq!(b.text(), "fn a() {\nx\n}");
    }

    #[test]
    fn 複数行の字下げと字上げ() {
        let mut b = TextBuffer::new("a\nb\n\nc");
        b.set_selection(0..b.text().len(), false);
        b.indent();
        assert_eq!(b.text(), "    a\n    b\n\n    c");
        b.outdent();
        assert_eq!(b.text(), "a\nb\n\nc");
    }

    #[test]
    fn 続けて打った字は1回で取り消し_やり直せる() {
        let mut b = buf("", 0);
        for c in ["h", "i", " ", "x"] {
            b.insert(c);
        }
        b.newline();
        assert!(b.undo());
        assert_eq!(b.text(), "hi x");
        assert!(b.undo());
        assert_eq!(b.text(), "");
        assert!(b.redo());
        assert_eq!(b.text(), "hi x");
    }

    #[test]
    fn 書き換えと取り消しのたびに版が進む() {
        let mut b = buf("a", 1);
        let saved = b.version;
        b.insert("b");
        assert!(b.version > saved);
        b.undo();
        assert!(b.version > saved);
    }

    #[test]
    fn 字下げの単位を見分ける() {
        assert_eq!(detect_indent("a\n\tb\n\tc"), "\t");
        assert_eq!(detect_indent("a\n  b\n    c"), "  ");
        assert_eq!(detect_indent("a\n    b\n        c"), "    ");
        assert_eq!(detect_indent("a"), "    ");
    }

    #[test]
    fn 行頭は字下げの後ろと行頭を行き来する() {
        let mut b = buf("    abc", 6);
        b.home(false);
        assert_eq!(b.cursor(), 4);
        b.home(false);
        assert_eq!(b.cursor(), 0);
    }

    #[test]
    fn 単語と行の範囲() {
        let b = TextBuffer::new("let foo_bar = 1;\nx");
        assert_eq!(b.word_range(5), 4..11);
        assert_eq!(b.line_range(3), 0..17);
    }
}
