// claude の許可の画面を画面の文字から読み、右下のカードから答えられるようにする。
use regex::Regex;
use std::sync::LazyLock;

static RULE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[╭┌├]?[─━═]{3,}").unwrap());
static OPTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([❯›>])?\s*(\d)\.\s+(.+?)\s*$").unwrap());
static QUESTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)do you want|would you like|しますか").unwrap());

#[derive(Debug, Clone, PartialEq)]
pub struct Prompt {
    pub question: String,
    pub detail: Vec<String>,
    pub options: Vec<String>,
    pub cursor: usize,
}

impl Prompt {
    // 同じ許可の画面かどうか（押す直前に読み直して、変わっていたら送らない）
    pub fn signature(&self) -> String {
        serde_json::json!([self.question, self.detail, self.options]).to_string()
    }
}

// 「Do you want …?」の下に番号付きの選択肢が並び、❯ が今の選び。選択肢が2つ以上で ❯ の位置が分かるときだけ返す
pub fn parse(text: &str) -> Option<Prompt> {
    let raw: Vec<&str> = text.split('\n').collect();
    let lines: Vec<String> = raw.iter().map(|l| l.replace(['│', '┃'], " ").trim_end().to_string()).collect();
    let q = (0..lines.len()).rev().find(|&i| QUESTION.is_match(&lines[i]) && (lines[i].contains('?') || lines[i].contains('？')))?;
    let mut options: Vec<String> = Vec::new();
    let mut cursor = None;
    let mut pending: Vec<String> = Vec::new();
    for line in lines.iter().skip(q + 1).take(16) {
        if let Some(m) = OPTION.captures(line)
            && m.get(2).and_then(|n| n.as_str().parse::<usize>().ok()) == Some(options.len() + 1)
        {
            if let Some(last) = options.last_mut()
                && !pending.is_empty()
            {
                last.push(' ');
                last.push_str(&pending.join(" "));
            }
            pending.clear();
            if m.get(1).is_some() {
                cursor = Some(options.len());
            }
            options.push(m.get(3).map(|x| x.as_str().to_string()).unwrap_or_default());
        } else if !options.is_empty() && !line.trim().is_empty() {
            pending.push(line.trim().to_string());
        } else if !options.is_empty() {
            pending.clear();
        }
    }
    let cursor = cursor?;
    if options.len() < 2 {
        return None;
    }
    // 何を許可するかは、問いの上から区切りの線（または10行）までの文字
    let mut top = q as isize - 1;
    while top >= 0 && (q as isize - top) <= 10 && !RULE.is_match(raw[top as usize]) {
        top -= 1;
    }
    let detail = lines[(top + 1) as usize..q].iter().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).take(6).collect();
    Some(Prompt { question: lines[q].trim().to_string(), detail, options, cursor })
}

// 今の選びから目当てまで矢印で動かして Enter。番号のキーの扱いは版で違うため使わない
pub fn keys(cursor: usize, target: usize) -> String {
    let step = if target > cursor { "\x1b[B" } else { "\x1b[A" };
    step.repeat(cursor.abs_diff(target)) + "\r"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 許可の画面を読む() {
        let screen = "────────────\n Bash command\n   rm -rf build\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n      for rm\n   3. No, and tell Claude what to do differently\n";
        let p = parse(screen).unwrap();
        assert_eq!(p.cursor, 0);
        assert_eq!(p.options.len(), 3);
        assert_eq!(p.options[1], "Yes, and don't ask again for rm");
        assert_eq!(p.detail, vec!["Bash command", "rm -rf build"]);
    }

    #[test]
    fn 矢印で動かして決める() {
        assert_eq!(keys(0, 2), "\x1b[B\x1b[B\r");
        assert_eq!(keys(1, 0), "\x1b[A\r");
    }

    #[test]
    fn 選びの印が無ければ読まない() {
        assert!(parse("Do you want to proceed?\n 1. Yes\n 2. No").is_none());
    }
}
