// 編集の画面の見た目の行。折り返すときは、1行を画面の幅で区切った行に分ける。
// 等幅の文字の幅（全角は2、タブは4）で数え、空白の後ろで区切れるならそこで区切る
use unicode_width::UnicodeWidthChar;

pub const TAB_WIDTH: usize = 4;

pub fn char_width(c: char) -> usize {
    if c == '\t' { TAB_WIDTH } else { c.width().unwrap_or(0).max(1) }
}

// 1行を幅 cols で区切った、バイトの範囲の並び。空の行も1つの見た目の行にする
pub fn wrap_line(line: &str, cols: usize) -> Vec<(usize, usize)> {
    let cols = cols.max(8);
    let mut rows = Vec::new();
    let mut start = 0;
    let mut width = 0;
    let mut last_space: Option<usize> = None;
    for (i, c) in line.char_indices() {
        let w = char_width(c);
        if width + w > cols && i > start {
            let cut = match last_space {
                Some(s) if s > start => s,
                _ => i,
            };
            rows.push((start, cut));
            width = line[cut..i].chars().map(char_width).sum();
            start = cut;
            last_space = None;
        }
        width += w;
        if c == ' ' || c == '\t' {
            last_space = Some(i + c.len_utf8());
        }
    }
    rows.push((start, line.len()));
    rows
}

pub struct RowMap {
    // 見た目の行ごとの（元の行, 始まり, 終わり）。位置は行の中のバイト
    pub rows: Vec<(usize, usize, usize)>,
    first_row: Vec<usize>,
}

impl RowMap {
    pub fn build<'a>(lines: impl Iterator<Item = &'a str>, cols: usize) -> Self {
        let mut rows = Vec::new();
        let mut first_row = Vec::new();
        for (n, line) in lines.enumerate() {
            first_row.push(rows.len());
            rows.extend(wrap_line(line, cols).into_iter().map(|(a, b)| (n, a, b)));
        }
        RowMap { rows, first_row }
    }

    // 元の行と行の中の位置から、見た目の行。区切りの位置は次の行の頭とする（行の最後の区切りを除く）
    pub fn row_of(&self, line: usize, offset: usize) -> usize {
        let first = self.first_row[line.min(self.first_row.len() - 1)];
        let mut row = first;
        while row + 1 < self.rows.len() && self.rows[row + 1].0 == line && self.rows[row + 1].1 <= offset {
            row += 1;
        }
        row
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空白の後ろで区切り_無ければ幅で区切る() {
        assert_eq!(wrap_line("aaaa bbbb cccc", 10), vec![(0, 10), (10, 14)]);
        assert_eq!(wrap_line("abcdefghijkl", 8), vec![(0, 8), (8, 12)]);
        assert_eq!(wrap_line("", 8), vec![(0, 0)]);
    }

    #[test]
    fn 全角は幅2で数える() {
        let line = "あいうえおかきく";
        assert_eq!(wrap_line(line, 8), vec![(0, 12), (12, 24)]);
    }

    #[test]
    fn 見た目の行を引ける() {
        let map = RowMap::build(["aaaa bbbb cccc", "x"].into_iter(), 10);
        assert_eq!(map.rows, vec![(0, 0, 10), (0, 10, 14), (1, 0, 1)]);
        assert_eq!(map.row_of(0, 3), 0);
        assert_eq!(map.row_of(0, 10), 1);
        assert_eq!(map.row_of(0, 14), 1);
        assert_eq!(map.row_of(1, 0), 2);
    }
}
