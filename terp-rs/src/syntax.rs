// 編集の画面の色分け。言語ごとの注釈・文字列・数・予約語を、行ごとに見分ける。
// 複数行の注釈だけは前の行から状態を引き継ぐ
use std::ops::Range;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tok {
    Comment,
    Keyword,
    Str,
    Number,
    Type,
    Tag,
    Heading,
}

pub struct Lang {
    line_comment: &'static [&'static str],
    block_comment: Option<(&'static str, &'static str)>,
    quotes: &'static [char],
    keywords: &'static [&'static str],
    // 大文字で始まる語を型として塗る
    capital_types: bool,
    markdown: bool,
    markup: bool,
}

static RUST: Lang = Lang {
    line_comment: &["//"],
    block_comment: Some(("/*", "*/")),
    quotes: &['"'],
    keywords: &[
        "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop",
        "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while",
    ],
    capital_types: true,
    markdown: false,
    markup: false,
};

static JS: Lang = Lang {
    line_comment: &["//"],
    block_comment: Some(("/*", "*/")),
    quotes: &['"', '\'', '`'],
    keywords: &[
        "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete", "do", "else", "export", "extends", "false", "finally", "for",
        "from", "function", "if", "import", "in", "instanceof", "interface", "let", "new", "null", "of", "return", "static", "super", "switch", "this", "throw", "true",
        "try", "type", "typeof", "undefined", "var", "void", "while", "yield", "enum", "implements", "private", "protected", "public", "readonly",
    ],
    capital_types: true,
    markdown: false,
    markup: false,
};

static PYTHON: Lang = Lang {
    line_comment: &["#"],
    block_comment: None,
    quotes: &['"', '\''],
    keywords: &[
        "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "False", "finally", "for", "from", "global",
        "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield",
    ],
    capital_types: true,
    markdown: false,
    markup: false,
};

static GO: Lang = Lang {
    line_comment: &["//"],
    block_comment: Some(("/*", "*/")),
    quotes: &['"', '\'', '`'],
    keywords: &[
        "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "false", "for", "func", "go", "goto", "if", "import", "interface",
        "map", "nil", "package", "range", "return", "select", "struct", "switch", "true", "type", "var",
    ],
    capital_types: true,
    markdown: false,
    markup: false,
};

static SHELL: Lang = Lang {
    line_comment: &["#"],
    block_comment: None,
    quotes: &['"', '\''],
    keywords: &[
        "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function", "return", "local", "export", "set", "unset",
        "readonly", "source", "exit", "echo",
    ],
    capital_types: false,
    markdown: false,
    markup: false,
};

static DATA: Lang = Lang {
    line_comment: &["#"],
    block_comment: None,
    quotes: &['"', '\''],
    keywords: &["true", "false", "null", "yes", "no", "on", "off"],
    capital_types: false,
    markdown: false,
    markup: false,
};

static JSON: Lang = Lang { line_comment: &["//"], block_comment: Some(("/*", "*/")), quotes: &['"'], keywords: &["true", "false", "null"], capital_types: false, markdown: false, markup: false };

static CSS: Lang = Lang { line_comment: &[], block_comment: Some(("/*", "*/")), quotes: &['"', '\''], keywords: &["important"], capital_types: false, markdown: false, markup: false };

static SQL: Lang = Lang {
    line_comment: &["--"],
    block_comment: Some(("/*", "*/")),
    quotes: &['\''],
    keywords: &[
        "select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set", "delete", "create", "table", "alter", "drop", "join", "left",
        "right", "inner", "outer", "on", "group", "by", "order", "limit", "as", "null", "is", "in", "primary", "key", "index", "SELECT", "FROM", "WHERE", "AND", "OR",
        "NOT", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP",
        "BY", "ORDER", "LIMIT", "AS", "NULL", "IS", "IN", "PRIMARY", "KEY", "INDEX",
    ],
    capital_types: false,
    markdown: false,
    markup: false,
};

static HTML: Lang = Lang { line_comment: &[], block_comment: Some(("<!--", "-->")), quotes: &['"', '\''], keywords: &[], capital_types: false, markdown: false, markup: true };

static MARKDOWN: Lang = Lang { line_comment: &[], block_comment: None, quotes: &[], keywords: &[], capital_types: false, markdown: true, markup: false };

pub fn lang_for(path: &Path) -> Option<&'static Lang> {
    let name = path.file_name()?.to_str()?.to_lowercase();
    if matches!(name.as_str(), "dockerfile" | "makefile" | ".zshrc" | ".bashrc" | ".gitignore" | ".env") {
        return Some(&SHELL);
    }
    let ext = path.extension()?.to_str()?.to_lowercase();
    Some(match ext.as_str() {
        "rs" => &RUST,
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "mts" | "cts" | "java" | "kt" | "swift" | "c" | "h" | "cc" | "cpp" | "hpp" | "cs" | "dart" | "scala" | "php" => &JS,
        "py" | "rb" => &PYTHON,
        "go" => &GO,
        "sh" | "bash" | "zsh" | "fish" => &SHELL,
        "yml" | "yaml" | "toml" | "ini" | "conf" | "properties" => &DATA,
        "json" | "jsonc" | "json5" => &JSON,
        "css" | "scss" | "less" => &CSS,
        "sql" => &SQL,
        "html" | "htm" | "xml" | "svg" | "vue" | "svelte" => &HTML,
        "md" | "markdown" | "mdx" => &MARKDOWN,
        _ => return None,
    })
}

// 各行の始まりで、複数行の注釈の中にいるか
pub fn block_states<'a>(lines: impl Iterator<Item = &'a str>, lang: &Lang) -> Vec<bool> {
    let mut states = Vec::new();
    let mut inside = false;
    for line in lines {
        states.push(inside);
        if lang.block_comment.is_some() {
            highlight_line(line, lang, &mut inside);
        } else if lang.markdown && line.trim_start().starts_with("```") {
            inside = !inside;
        }
    }
    states
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

// 1行の色の範囲（バイトの位置）。inside は複数行の注釈（Markdown はコードの囲み）の中か
pub fn highlight_line(line: &str, lang: &Lang, inside: &mut bool) -> Vec<(Range<usize>, Tok)> {
    if lang.markdown {
        return markdown_line(line, inside);
    }
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    if *inside {
        let (_, close) = lang.block_comment.expect("注釈の中にいるのは複数行の注釈がある言語だけ");
        match line.find(close) {
            Some(end) => {
                out.push((0..end + close.len(), Tok::Comment));
                i = end + close.len();
                *inside = false;
            }
            None => return vec![(0..line.len(), Tok::Comment)],
        }
    }
    while i < line.len() {
        let rest = &line[i..];
        if let Some((open, close)) = lang.block_comment
            && rest.starts_with(open)
        {
            match rest[open.len()..].find(close) {
                Some(end) => {
                    let to = i + open.len() + end + close.len();
                    out.push((i..to, Tok::Comment));
                    i = to;
                    continue;
                }
                None => {
                    out.push((i..line.len(), Tok::Comment));
                    *inside = true;
                    break;
                }
            }
        }
        if lang.line_comment.iter().any(|m| rest.starts_with(m)) && (i == 0 || !lang.line_comment.contains(&"#") || bytes[i - 1].is_ascii_whitespace()) {
            out.push((i..line.len(), Tok::Comment));
            break;
        }
        let c = rest.chars().next().expect("範囲の中");
        if lang.quotes.contains(&c) {
            let body = i + c.len_utf8();
            let mut escaped = false;
            let mut closed = None;
            for (k, d) in line[body..].char_indices() {
                if escaped {
                    escaped = false;
                } else if d == '\\' {
                    escaped = true;
                } else if d == c {
                    closed = Some(body + k + d.len_utf8());
                    break;
                }
            }
            let to = closed.unwrap_or(line.len());
            out.push((i..to, Tok::Str));
            i = to;
            continue;
        }
        if lang.markup && c == '<' {
            let to = rest.find(|x: char| x.is_whitespace() || x == '>').map(|n| i + n).unwrap_or(line.len());
            if to > i + 1 {
                out.push((i..to, Tok::Tag));
                i = to;
                continue;
            }
        }
        if c.is_ascii_digit() && (i == 0 || !is_ident(line[..i].chars().next_back().unwrap_or(' '))) {
            let to = rest.find(|x: char| !(x.is_ascii_alphanumeric() || x == '.' || x == '_')).map(|n| i + n).unwrap_or(line.len());
            out.push((i..to, Tok::Number));
            i = to;
            continue;
        }
        if is_ident(c) {
            let to = rest.find(|x: char| !is_ident(x)).map(|n| i + n).unwrap_or(line.len());
            let word = &line[i..to];
            if lang.keywords.contains(&word) {
                out.push((i..to, Tok::Keyword));
            } else if lang.capital_types && word.chars().next().is_some_and(|f| f.is_uppercase()) && word.chars().any(|x| x.is_lowercase()) {
                out.push((i..to, Tok::Type));
            }
            i = to;
            continue;
        }
        i += c.len_utf8();
    }
    out
}

fn markdown_line(line: &str, in_code: &mut bool) -> Vec<(Range<usize>, Tok)> {
    let trimmed = line.trim_start();
    if trimmed.starts_with("```") {
        *in_code = !*in_code;
        return vec![(0..line.len(), Tok::Str)];
    }
    if *in_code {
        return vec![(0..line.len(), Tok::Str)];
    }
    if trimmed.starts_with('#') {
        return vec![(0..line.len(), Tok::Heading)];
    }
    let mut out = Vec::new();
    let indent = line.len() - trimmed.len();
    if let Some(marker) = ["- ", "* ", "+ ", "> "].iter().find(|m| trimmed.starts_with(**m)) {
        out.push((indent..indent + marker.len() - 1, Tok::Tag));
    } else if let Some(dot) = trimmed.find(". ").filter(|n| *n > 0 && trimmed[..*n].chars().all(|c| c.is_ascii_digit())) {
        out.push((indent..indent + dot + 1, Tok::Tag));
    }
    let mut from = 0;
    while let Some(a) = line[from..].find('`') {
        let a = from + a;
        let Some(b) = line[a + 1..].find('`') else { break };
        let b = a + 1 + b + 1;
        out.push((a..b, Tok::Str));
        from = b;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks<'a>(line: &'a str, lang: &Lang) -> Vec<(&'a str, Tok)> {
        let mut inside = false;
        highlight_line(line, lang, &mut inside).into_iter().map(|(r, t)| (&line[r], t)).collect()
    }

    #[test]
    fn rust_の予約語_文字列_数_注釈_型() {
        assert_eq!(
            toks(r#"let s: String = "a\"b" + 12; // c"#, &RUST),
            vec![("let", Tok::Keyword), ("String", Tok::Type), (r#""a\"b""#, Tok::Str), ("12", Tok::Number), ("// c", Tok::Comment)]
        );
    }

    #[test]
    fn 複数行の注釈は次の行へ引き継ぐ() {
        let lines = ["a /* b", "c", "d */ let"];
        let states = block_states(lines.iter().copied(), &JS);
        assert_eq!(states, vec![false, true, true]);
        let mut inside = true;
        let last = highlight_line(lines[2], &JS, &mut inside);
        assert_eq!(last, vec![(0..4, Tok::Comment), (5..8, Tok::Keyword)]);
        assert!(!inside);
    }

    #[test]
    fn シェルの井桁は語の途中では注釈にしない() {
        assert_eq!(toks("echo a#b # c", &SHELL), vec![("echo", Tok::Keyword), ("# c", Tok::Comment)]);
    }

    #[test]
    fn markdown_の見出し_箇条書き_コード() {
        assert_eq!(toks("## 見出し", &MARKDOWN), vec![("## 見出し", Tok::Heading)]);
        assert_eq!(toks("- `a` b", &MARKDOWN), vec![("-", Tok::Tag), ("`a`", Tok::Str)]);
        let states = block_states(["```", "x", "```", "y"].into_iter(), &MARKDOWN);
        assert_eq!(states, vec![false, true, true, false]);
    }

    #[test]
    fn 拡張子から言語を選ぶ() {
        assert!(lang_for(Path::new("a/b.rs")).is_some_and(|l| std::ptr::eq(l, &RUST)));
        assert!(lang_for(Path::new("README.md")).is_some_and(|l| l.markdown));
        assert!(lang_for(Path::new("x.unknown")).is_none());
    }
}
