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
    // 複数のカーソルで一度に書き換えたものは同じ番号にし、まとめて取り消す
    group: u64,
}

// 2つ目以降のカーソル
#[derive(Clone, Debug, PartialEq)]
pub struct Cursor {
    pub range: Range<usize>,
    pub reversed: bool,
    preferred_col: Option<usize>,
}

impl Cursor {
    pub fn head(&self) -> usize {
        if self.reversed { self.range.start } else { self.range.end }
    }
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
    pub extra: Vec<Cursor>,
    group: u64,
    group_active: Option<u64>,
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
        TextBuffer {
            line_starts: line_starts(&text),
            text,
            selected: 0..0,
            reversed: false,
            preferred_col: None,
            undo: Vec::new(),
            redo: Vec::new(),
            version: 0,
            crlf,
            indent_unit,
            extra: Vec::new(),
            group: 0,
            group_active: None,
        }
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
        let group = match self.group_active {
            Some(g) => g,
            None => {
                self.group += 1;
                self.group
            }
        };
        let edit = Edit { at: range.start, removed, inserted: text, before, after: (self.selected.clone(), false), time: now, group };
        let n = self.undo.len();
        let last_alone = n >= 1 && (n < 2 || self.undo[n - 2].group != self.undo[n - 1].group);
        if last_alone
            && self.group_active.is_none()
            && let Some(last) = self.undo.last_mut()
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
        let Some(group) = self.undo.last().map(|e| e.group) else { return false };
        while self.undo.last().is_some_and(|e| e.group == group) {
            let edit = self.undo.pop().expect("あると確かめた");
            self.text.replace_range(edit.at..edit.at + edit.inserted.len(), &edit.removed);
            self.selected = edit.before.0.clone();
            self.reversed = edit.before.1;
            self.redo.push(edit);
        }
        self.line_starts = line_starts(&self.text);
        self.extra.clear();
        self.version += 1;
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(group) = self.redo.last().map(|e| e.group) else { return false };
        while self.redo.last().is_some_and(|e| e.group == group) {
            let edit = self.redo.pop().expect("あると確かめた");
            self.text.replace_range(edit.at..edit.at + edit.removed.len(), &edit.inserted);
            self.selected = edit.after.0.clone();
            self.reversed = edit.after.1;
            self.undo.push(edit);
        }
        self.line_starts = line_starts(&self.text);
        self.extra.clear();
        self.version += 1;
        true
    }

    // ---- 複数のカーソル ----

    fn take_primary(&self) -> Cursor {
        Cursor { range: self.selected.clone(), reversed: self.reversed, preferred_col: self.preferred_col }
    }

    fn set_primary(&mut self, c: Cursor) {
        self.selected = c.range;
        self.reversed = c.reversed;
        self.preferred_col = c.preferred_col;
    }

    pub fn clear_extra(&mut self) -> bool {
        let had = !self.extra.is_empty();
        self.extra.clear();
        had
    }

    // 重なったカーソルを1つにまとめる。主のカーソルを含むものは主に残す
    fn normalize(&mut self) {
        if self.extra.is_empty() {
            return;
        }
        let primary = self.take_primary();
        let mut all: Vec<(bool, Cursor)> = std::mem::take(&mut self.extra).into_iter().map(|c| (false, c)).collect();
        all.push((true, primary));
        all.sort_by_key(|(_, c)| (c.range.start, c.range.end));
        let mut merged: Vec<(bool, Cursor)> = Vec::new();
        for (is_primary, c) in all {
            match merged.last_mut() {
                Some((p, last)) if c.range.start < last.range.end || c.range == last.range || (c.range.is_empty() && c.range.start == last.range.end) => {
                    last.range.end = last.range.end.max(c.range.end);
                    *p |= is_primary;
                }
                _ => merged.push((is_primary, c)),
            }
        }
        for (is_primary, c) in merged {
            if is_primary {
                self.set_primary(c);
            } else {
                self.extra.push(c);
            }
        }
    }

    // 動きを、どのカーソルにも当てる
    pub fn each_motion(&mut self, f: impl Fn(&mut Self)) {
        let extras = std::mem::take(&mut self.extra);
        let primary = self.take_primary();
        let mut moved = Vec::with_capacity(extras.len());
        for c in extras {
            self.set_primary(c);
            f(self);
            moved.push(self.take_primary());
        }
        self.set_primary(primary);
        f(self);
        self.extra = moved;
        self.normalize();
    }

    // 書き換えを、どのカーソルにも当てる。後ろのカーソルから書き換え、前で増減した分だけ後ろをずらす
    pub fn each_edit(&mut self, f: impl Fn(&mut Self)) {
        if self.extra.is_empty() {
            return f(self);
        }
        self.group += 1;
        self.group_active = Some(self.group);
        let mut all: Vec<(bool, Cursor)> = std::mem::take(&mut self.extra).into_iter().map(|c| (false, c)).collect();
        all.push((true, self.take_primary()));
        all.sort_by_key(|(_, c)| std::cmp::Reverse(c.range.start));
        let mut done: Vec<(bool, Cursor)> = Vec::with_capacity(all.len());
        for (is_primary, c) in all {
            let before = self.text.len() as isize;
            self.set_primary(c);
            f(self);
            let delta = self.text.len() as isize - before;
            for (_, d) in &mut done {
                d.range = (d.range.start as isize + delta).max(0) as usize..(d.range.end as isize + delta).max(0) as usize;
            }
            done.push((is_primary, self.take_primary()));
        }
        self.group_active = None;
        for (is_primary, c) in done {
            if is_primary {
                self.set_primary(c);
            } else {
                self.extra.push(c);
            }
        }
        self.normalize();
    }

    pub fn add_cursor_at(&mut self, offset: usize) {
        let offset = self.clamp(offset);
        let primary = self.take_primary();
        self.extra.push(primary);
        self.selected = offset..offset;
        self.reversed = false;
        self.preferred_col = None;
        self.normalize();
    }

    // ⌥⌘↑↓。主のカーソルの上か下の行にカーソルを足す
    pub fn add_cursor_vertical(&mut self, rows: isize) {
        let primary = self.take_primary();
        self.vertical(rows, false);
        if self.selected != primary.range {
            self.extra.push(primary);
            self.normalize();
        }
    }

    // ⌘D。選んでいなければ今の単語を選び、選んでいれば同じ文字の次を選び足す
    pub fn add_next_occurrence(&mut self) {
        if self.selected.is_empty() {
            let r = self.word_range(self.cursor());
            self.set_selection(r, false);
            return;
        }
        let needle = self.selected_text().to_string();
        let taken: Vec<Range<usize>> = self.extra.iter().map(|c| c.range.clone()).chain(std::iter::once(self.selected.clone())).collect();
        let from = taken.iter().map(|r| r.end).max().unwrap_or(0);
        let found = self.text[from..]
            .match_indices(&needle)
            .map(|(i, _)| from + i)
            .chain(self.text[..from].match_indices(&needle).map(|(i, _)| i))
            .map(|i| i..i + needle.len())
            .find(|r| !taken.contains(r));
        if let Some(r) = found {
            let primary = self.take_primary();
            self.extra.push(primary);
            self.selected = r;
            self.reversed = false;
            self.normalize();
        }
    }

    // ⇧⌘L。選んだ文字と同じものをすべて選ぶ
    pub fn select_all_occurrences(&mut self) {
        if self.selected.is_empty() {
            let r = self.word_range(self.cursor());
            self.set_selection(r, false);
        }
        let needle = self.selected_text().to_string();
        if needle.is_empty() {
            return;
        }
        let ranges: Vec<Range<usize>> = self.text.match_indices(&needle).map(|(i, _)| i..i + needle.len()).collect();
        self.extra = ranges.into_iter().filter(|r| *r != self.selected).map(|range| Cursor { range, reversed: false, preferred_col: None }).collect();
        self.normalize();
    }

    // 範囲をまとめて置き換える（検索のすべて置換）。1回で取り消せる
    pub fn replace_all(&mut self, ranges: &[Range<usize>], with: &str) {
        if ranges.is_empty() {
            return;
        }
        self.group += 1;
        self.group_active = Some(self.group);
        let mut sorted = ranges.to_vec();
        sorted.sort_by_key(|r| std::cmp::Reverse(r.start));
        for r in sorted {
            self.replace(r, with);
        }
        self.group_active = None;
        self.extra.clear();
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
    fn 複数のカーソルで打った字は1回で取り消せる() {
        let mut b = buf("a\nb\nc", 1);
        b.add_cursor_vertical(1);
        b.add_cursor_vertical(1);
        assert_eq!(b.extra.len(), 2);
        b.each_edit(|b| b.insert("!"));
        assert_eq!(b.text(), "a!\nb!\nc!");
        b.each_edit(|b| b.backspace(false, false));
        assert_eq!(b.text(), "a\nb\nc");
        b.undo();
        assert_eq!(b.text(), "a!\nb!\nc!");
        b.undo();
        assert_eq!(b.text(), "a\nb\nc");
    }

    #[test]
    fn 同じ文字の次を選び足し_重なったカーソルはまとめる() {
        let mut b = buf("foo bar foo foo", 1);
        b.add_next_occurrence();
        assert_eq!(b.selected, 0..3);
        b.add_next_occurrence();
        b.add_next_occurrence();
        assert_eq!(b.extra.len(), 2);
        b.each_edit(|b| b.insert("x"));
        assert_eq!(b.text(), "x bar x x");
        b.each_motion(|b| b.doc_edge(false, false));
        assert!(b.extra.is_empty());
    }

    #[test]
    fn すべて置換は1回で取り消せる() {
        let mut b = buf("a-a-a", 0);
        b.replace_all(&[0..1, 2..3, 4..5], "bb");
        assert_eq!(b.text(), "bb-bb-bb");
        b.undo();
        assert_eq!(b.text(), "a-a-a");
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
