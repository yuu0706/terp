// 端末の中の文字を探す。打った文字をそのまま探し、大文字を含まなければ大文字小文字を区別しない。
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Direction, Line, Point};
use alacritty_terminal::term::Term;
use alacritty_terminal::term::search::{Match, RegexIter, RegexSearch};

// 履歴が長いと数えきれないため、上限で打ち切る
const LIMIT: usize = 2000;

pub fn escape(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for c in query.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

pub fn find_all<T>(term: &Term<T>, query: &str) -> Vec<Match> {
    if query.is_empty() {
        return Vec::new();
    }
    let Ok(mut regex) = RegexSearch::new(&escape(query)) else { return Vec::new() };
    let start = Point::new(term.topmost_line(), Column(0));
    let end = Point::new(term.bottommost_line(), term.last_column());
    RegexIter::new(start, end, Direction::Right, term, &mut regex).take(LIMIT).collect()
}

// 打ち始めは、表示している範囲の最初の当たりを選ぶ。範囲の中に無ければ、最も新しい当たり
pub fn first_visible(matches: &[Match], top: Line) -> Option<usize> {
    if matches.is_empty() {
        return None;
    }
    Some(matches.iter().position(|m| m.start().line >= top).unwrap_or(matches.len() - 1))
}

pub fn step(index: Option<usize>, len: usize, forward: bool) -> Option<usize> {
    if len == 0 {
        return None;
    }
    Some(match (index, forward) {
        (None, true) => 0,
        (None, false) => len - 1,
        (Some(i), true) => (i + 1) % len,
        (Some(i), false) => (i + len - 1) % len,
    })
}

pub fn count_label(index: Option<usize>, count: usize, query: &str) -> String {
    if query.is_empty() {
        return String::new();
    }
    match (count, index) {
        (0, _) => "0件".into(),
        (_, Some(i)) => format!("{}/{count}", i + 1),
        (_, None) => format!("{count}件"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::term::{Config, test::TermSize};
    use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};

    fn term_with(text: &str) -> Term<VoidListener> {
        let mut term = Term::new(Config::default(), &TermSize::new(40, 5), VoidListener);
        let mut parser: Processor<StdSyncHandler> = Processor::new();
        parser.advance(&mut term, text.as_bytes());
        term
    }

    #[test]
    fn 記号はそのまま探す() {
        let term = term_with("a.b axb\r\n(x) a.b");
        assert_eq!(find_all(&term, "a.b").len(), 2);
        assert_eq!(find_all(&term, "(x)").len(), 1);
    }

    #[test]
    fn 小文字だけなら大文字小文字を区別しない() {
        let term = term_with("Error error ERROR");
        assert_eq!(find_all(&term, "error").len(), 3);
        assert_eq!(find_all(&term, "Error").len(), 1);
    }

    #[test]
    fn 前後の移動は端で回る() {
        assert_eq!(step(Some(2), 3, true), Some(0));
        assert_eq!(step(Some(0), 3, false), Some(2));
        assert_eq!(step(None, 0, true), None);
    }

    #[test]
    fn 件数の表示() {
        assert_eq!(count_label(None, 0, ""), "");
        assert_eq!(count_label(None, 0, "x"), "0件");
        assert_eq!(count_label(Some(1), 5, "x"), "2/5");
    }
}
