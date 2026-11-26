// Markdown のプレビュー用に、文書を段落・見出し・箇条書きなどの塊に分ける。
// 画面に出す形（GPUI の要素）は editor.rs が作る
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::ops::Range;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Inline {
    pub text: String,
    pub spans: Vec<(Range<usize>, Mark)>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Mark {
    Bold,
    Italic,
    Code,
    Strike,
    Link(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Heading(u8, Inline),
    Para(Inline),
    Code(String),
    Quote(Vec<Block>),
    List { start: Option<u64>, items: Vec<Vec<Block>> },
    Table(Vec<Vec<Inline>>),
    Image { src: String, alt: String },
    Rule,
}

enum Frame {
    Root(Vec<Block>),
    Quote(Vec<Block>),
    List { start: Option<u64>, items: Vec<Vec<Block>> },
    Item(Vec<Block>),
    Table(Vec<Vec<Inline>>),
    Row(Vec<Inline>),
}

impl Frame {
    fn blocks(&mut self) -> Option<&mut Vec<Block>> {
        match self {
            Frame::Root(b) | Frame::Quote(b) | Frame::Item(b) => Some(b),
            _ => None,
        }
    }
}

struct Builder {
    stack: Vec<Frame>,
    inline: Option<Inline>,
    // 開いている飾り（太字など）の始まり
    open: Vec<(usize, Mark)>,
    heading: Option<u8>,
    code: Option<String>,
    image: Option<(String, String)>,
}

impl Builder {
    fn push_block(&mut self, block: Block) {
        for frame in self.stack.iter_mut().rev() {
            if let Some(blocks) = frame.blocks() {
                blocks.push(block);
                return;
            }
        }
    }

    fn text(&mut self, text: &str) {
        if let Some((_, alt)) = self.image.as_mut() {
            alt.push_str(text);
            return;
        }
        if let Some(code) = self.code.as_mut() {
            code.push_str(text);
            return;
        }
        self.inline.get_or_insert_with(Inline::default).text.push_str(text);
    }

    // 箇条書きの項目の中の、段落で囲まれない文を段落にする
    fn flush_inline(&mut self) {
        if let Some(inline) = self.inline.take().filter(|i| !i.text.trim().is_empty()) {
            match self.heading.take() {
                Some(level) => self.push_block(Block::Heading(level, inline)),
                None => self.push_block(Block::Para(inline)),
            }
        }
    }

    fn open_mark(&mut self, mark: Mark) {
        let at = self.inline.get_or_insert_with(Inline::default).text.len();
        self.open.push((at, mark));
    }

    fn close_mark(&mut self) {
        if let Some((start, mark)) = self.open.pop()
            && let Some(inline) = self.inline.as_mut()
            && inline.text.len() > start
        {
            inline.spans.push((start..inline.text.len(), mark));
        }
    }
}

pub fn parse(source: &str) -> Vec<Block> {
    let mut b = Builder { stack: vec![Frame::Root(Vec::new())], inline: None, open: Vec::new(), heading: None, code: None, image: None };
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    for event in Parser::new_ext(source, options) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => b.flush_inline(),
                Tag::Heading { level, .. } => {
                    b.flush_inline();
                    b.heading = Some(match level {
                        HeadingLevel::H1 => 1,
                        HeadingLevel::H2 => 2,
                        HeadingLevel::H3 => 3,
                        HeadingLevel::H4 => 4,
                        HeadingLevel::H5 => 5,
                        HeadingLevel::H6 => 6,
                    });
                }
                Tag::BlockQuote(_) => {
                    b.flush_inline();
                    b.stack.push(Frame::Quote(Vec::new()));
                }
                Tag::CodeBlock(kind) => {
                    b.flush_inline();
                    let _ = matches!(kind, CodeBlockKind::Fenced(_));
                    b.code = Some(String::new());
                }
                Tag::List(start) => {
                    b.flush_inline();
                    b.stack.push(Frame::List { start, items: Vec::new() });
                }
                Tag::Item => {
                    b.flush_inline();
                    b.stack.push(Frame::Item(Vec::new()));
                }
                Tag::Table(_) => {
                    b.flush_inline();
                    b.stack.push(Frame::Table(Vec::new()));
                }
                Tag::TableHead | Tag::TableRow => b.stack.push(Frame::Row(Vec::new())),
                Tag::TableCell => b.inline = Some(Inline::default()),
                Tag::Emphasis => b.open_mark(Mark::Italic),
                Tag::Strong => b.open_mark(Mark::Bold),
                Tag::Strikethrough => b.open_mark(Mark::Strike),
                Tag::Link { dest_url, .. } => b.open_mark(Mark::Link(dest_url.to_string())),
                Tag::Image { dest_url, .. } => {
                    b.flush_inline();
                    b.image = Some((dest_url.to_string(), String::new()));
                }
                _ => {}
            },
            Event::End(end) => match end {
                TagEnd::Paragraph | TagEnd::Heading(_) => b.flush_inline(),
                TagEnd::BlockQuote(_) => {
                    b.flush_inline();
                    if let Some(Frame::Quote(blocks)) = b.stack.pop() {
                        b.push_block(Block::Quote(blocks));
                    }
                }
                TagEnd::CodeBlock => {
                    if let Some(code) = b.code.take() {
                        b.push_block(Block::Code(code.trim_end_matches('\n').to_string()));
                    }
                }
                TagEnd::Item => {
                    b.flush_inline();
                    if let Some(Frame::Item(blocks)) = b.stack.pop()
                        && let Some(Frame::List { items, .. }) = b.stack.last_mut()
                    {
                        items.push(blocks);
                    }
                }
                TagEnd::List(_) => {
                    if let Some(Frame::List { start, items }) = b.stack.pop() {
                        b.push_block(Block::List { start, items });
                    }
                }
                TagEnd::TableCell => {
                    let cell = b.inline.take().unwrap_or_default();
                    if let Some(Frame::Row(cells)) = b.stack.last_mut() {
                        cells.push(cell);
                    }
                }
                TagEnd::TableHead | TagEnd::TableRow => {
                    if let Some(Frame::Row(cells)) = b.stack.pop()
                        && let Some(Frame::Table(rows)) = b.stack.last_mut()
                    {
                        rows.push(cells);
                    }
                }
                TagEnd::Table => {
                    if let Some(Frame::Table(rows)) = b.stack.pop() {
                        b.push_block(Block::Table(rows));
                    }
                }
                TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link => b.close_mark(),
                TagEnd::Image => {
                    if let Some((src, alt)) = b.image.take() {
                        b.push_block(Block::Image { src, alt });
                    }
                }
                _ => {}
            },
            Event::Text(text) => b.text(&text),
            Event::Code(text) => {
                b.open_mark(Mark::Code);
                b.text(&text);
                b.close_mark();
            }
            Event::SoftBreak => b.text(" "),
            Event::HardBreak => b.text("\n"),
            Event::Rule => {
                b.flush_inline();
                b.push_block(Block::Rule);
            }
            Event::TaskListMarker(done) => b.text(if done { "☑ " } else { "☐ " }),
            Event::Html(html) | Event::InlineHtml(html) => b.text(&html),
            _ => {}
        }
    }
    b.flush_inline();
    match b.stack.into_iter().next() {
        Some(Frame::Root(blocks)) => blocks,
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(text: &str) -> Inline {
        Inline { text: text.into(), spans: Vec::new() }
    }

    #[test]
    fn 見出し_段落_飾り() {
        let blocks = parse("# 題\n\n本文の **太字** と `code`。");
        assert_eq!(blocks[0], Block::Heading(1, plain("題")));
        let Block::Para(p) = &blocks[1] else { panic!("段落になる") };
        assert_eq!(p.text, "本文の 太字 と code。");
        assert_eq!(&p.text[p.spans[0].0.clone()], "太字");
        assert_eq!(p.spans[0].1, Mark::Bold);
        assert_eq!(p.spans[1].1, Mark::Code);
    }

    #[test]
    fn 箇条書きの入れ子とコードの囲み() {
        let blocks = parse("1. a\n   - b\n2. c\n\n```rs\nfn x() {}\n```\n");
        let Block::List { start, items } = &blocks[0] else { panic!("箇条書き") };
        assert_eq!(*start, Some(1));
        assert_eq!(items.len(), 2);
        assert!(matches!(items[0][1], Block::List { start: None, .. }));
        assert_eq!(blocks[1], Block::Code("fn x() {}".into()));
    }

    #[test]
    fn 表と引用と区切り() {
        let blocks = parse("| a | b |\n|---|---|\n| 1 | 2 |\n\n> q\n\n---\n");
        let Block::Table(rows) = &blocks[0] else { panic!("表") };
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1][1].text, "2");
        assert_eq!(blocks[1], Block::Quote(vec![Block::Para(plain("q"))]));
        assert_eq!(blocks[2], Block::Rule);
    }

    #[test]
    fn リンクは行き先を持つ() {
        let blocks = parse("[terp](https://example.com)");
        let Block::Para(p) = &blocks[0] else { panic!("段落") };
        assert_eq!(p.spans, vec![(0..4, Mark::Link("https://example.com".into()))]);
    }
}
