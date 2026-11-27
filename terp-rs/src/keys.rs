// キー入力を端末へ送るバイト列に直す。文字の入力は入力方式（IME）に任せ、ここでは扱わない。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mods {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub cmd: bool,
}

fn modifier_param(mods: Mods) -> u8 {
    1 + mods.shift as u8 + 2 * mods.alt as u8 + 4 * mods.ctrl as u8
}

fn cursor_key(letter: char, mods: Mods, app_cursor: bool) -> Vec<u8> {
    let param = modifier_param(mods);
    if param > 1 {
        format!("\x1b[1;{param}{letter}").into_bytes()
    } else if app_cursor {
        format!("\x1bO{letter}").into_bytes()
    } else {
        format!("\x1b[{letter}").into_bytes()
    }
}

fn tilde_key(code: u8, mods: Mods) -> Vec<u8> {
    let param = modifier_param(mods);
    if param > 1 { format!("\x1b[{code};{param}~").into_bytes() } else { format!("\x1b[{code}~").into_bytes() }
}

fn ctrl_byte(key: &str) -> Option<u8> {
    let mut chars = key.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return if key == "space" { Some(0) } else { None };
    }
    match c {
        'a'..='z' => Some(c as u8 - b'a' + 1),
        '@' | '2' | ' ' => Some(0),
        '[' | '3' => Some(0x1b),
        '\\' | '4' => Some(0x1c),
        ']' | '5' => Some(0x1d),
        '^' | '6' => Some(0x1e),
        '_' | '-' | '7' | '/' => Some(0x1f),
        '?' | '8' => Some(0x7f),
        _ => None,
    }
}

fn shifted(c: char) -> char {
    match c {
        'a'..='z' => c.to_ascii_uppercase(),
        '1' => '!',
        '2' => '@',
        '3' => '#',
        '4' => '$',
        '5' => '%',
        '6' => '^',
        '7' => '&',
        '8' => '*',
        '9' => '(',
        '0' => ')',
        '-' => '_',
        '=' => '+',
        '[' => '{',
        ']' => '}',
        '\\' => '|',
        ';' => ':',
        '\'' => '"',
        ',' => '<',
        '.' => '>',
        '/' => '?',
        '`' => '~',
        _ => c,
    }
}

// key は GPUI の名前（"enter"・"left"・"a" など）。None なら文字の入力として入力方式へ回す
pub fn to_bytes(key: &str, mods: Mods, app_cursor: bool) -> Option<Vec<u8>> {
    let plain = !mods.ctrl && !mods.alt && !mods.cmd;
    if mods.cmd {
        // ⌘ の組み合わせはメニューの操作に使う。行の編集の3つだけ端末へ送る
        if mods.ctrl || mods.alt {
            return None;
        }
        return match key {
            "left" => Some(vec![0x01]),
            "right" => Some(vec![0x05]),
            "backspace" => Some(vec![0x15]),
            _ => None,
        };
    }
    let esc_prefix = |mut bytes: Vec<u8>| {
        if mods.alt {
            bytes.insert(0, 0x1b);
        }
        bytes
    };
    let bytes = match key {
        // claude の改行。VS Code の /terminal-setup と同じく ESC + CR を送る
        "enter" if mods.shift && plain => vec![0x1b, b'\r'],
        "enter" => esc_prefix(vec![b'\r']),
        "backspace" if mods.ctrl => esc_prefix(vec![0x08]),
        "backspace" => esc_prefix(vec![0x7f]),
        "tab" if mods.shift => b"\x1b[Z".to_vec(),
        "tab" => esc_prefix(vec![b'\t']),
        "escape" => esc_prefix(vec![0x1b]),
        "left" if mods.alt && !mods.ctrl && !mods.shift => b"\x1bb".to_vec(),
        "right" if mods.alt && !mods.ctrl && !mods.shift => b"\x1bf".to_vec(),
        "up" => cursor_key('A', mods, app_cursor),
        "down" => cursor_key('B', mods, app_cursor),
        "right" => cursor_key('C', mods, app_cursor),
        "left" => cursor_key('D', mods, app_cursor),
        "home" => cursor_key('H', mods, app_cursor),
        "end" => cursor_key('F', mods, app_cursor),
        "insert" => tilde_key(2, mods),
        "delete" => tilde_key(3, mods),
        "pageup" => tilde_key(5, mods),
        "pagedown" => tilde_key(6, mods),
        "f1" | "f2" | "f3" | "f4" => {
            let letter = (b'P' + key[1..].parse::<u8>().ok()? - 1) as char;
            let param = modifier_param(mods);
            if param > 1 { format!("\x1b[1;{param}{letter}").into_bytes() } else { format!("\x1bO{letter}").into_bytes() }
        }
        _ if key.starts_with('f') && key.len() > 1 && key[1..].chars().all(|c| c.is_ascii_digit()) => {
            let code = match key[1..].parse::<u8>().ok()? {
                5 => 15,
                6 => 17,
                7 => 18,
                8 => 19,
                9 => 20,
                10 => 21,
                11 => 23,
                12 => 24,
                _ => return None,
            };
            tilde_key(code, mods)
        }
        _ if mods.ctrl => esc_prefix(vec![ctrl_byte(key)?]),
        // ⌥ は常に Meta として扱う（⌥ で打つ記号より、シェルの単語操作を優先する）
        _ if mods.alt => {
            let c = if key == "space" { ' ' } else {
                let mut chars = key.chars();
                let c = chars.next()?;
                if chars.next().is_some() {
                    return None;
                }
                c
            };
            let c = if mods.shift { shifted(c) } else { c };
            let mut bytes = vec![0x1b];
            bytes.extend(c.to_string().as_bytes());
            bytes
        }
        _ => return None,
    };
    Some(bytes)
}

// Electron の書き方（"Command+Shift+["）を GPUI の書き方（"cmd-shift-["）に直す。読めなければ None
pub fn accelerator_to_gpui(value: &str) -> Option<String> {
    if value.is_empty() || value.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    let mut parts: Vec<&str> = value.split('+').collect();
    // "Command++" のように + 自体を書いた場合
    if value.ends_with("++") {
        parts.truncate(parts.len() - 2);
        parts.push("+");
    }
    if parts.len() < 2 || parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    let raw_key = parts.pop()?;
    let (mut ctrl, mut alt, mut shift, mut cmd) = (false, false, false, false);
    for part in parts {
        match part.to_ascii_lowercase().as_str() {
            "command" | "cmd" | "commandorcontrol" | "cmdorctrl" | "super" | "meta" => cmd = true,
            "control" | "ctrl" => ctrl = true,
            "alt" | "option" | "altgr" => alt = true,
            "shift" => shift = true,
            _ => return None,
        }
    }
    let lower = raw_key.to_ascii_lowercase();
    let key = match lower.as_str() {
        "plus" => "+".to_string(),
        "return" | "enter" => "enter".into(),
        "esc" | "escape" => "escape".into(),
        "left" | "right" | "up" | "down" | "home" | "end" | "tab" | "space" | "backspace" | "delete" | "insert" => lower.clone(),
        "pageup" | "pagedown" => lower.clone(),
        _ if lower.starts_with('f') && lower.len() > 1 && lower[1..].chars().all(|c| c.is_ascii_digit()) => lower.clone(),
        _ if raw_key.chars().count() == 1 => {
            let c = raw_key.chars().next()?;
            // 記号の上段は、⇧ と下段のキーで書く
            const BASE: &str = "`1234567890-=[]\\;',./";
            const UPPER: &str = "~!@#$%^&*()_+{}|:\"<>?";
            if let Some(index) = UPPER.chars().position(|u| u == c) {
                shift = true;
                BASE.chars().nth(index)?.to_string()
            } else if c.is_ascii_alphanumeric() || BASE.contains(c) {
                c.to_ascii_lowercase().to_string()
            } else {
                return None;
            }
        }
        _ => return None,
    };
    let mut out = String::new();
    for (on, name) in [(ctrl, "ctrl-"), (alt, "alt-"), (shift, "shift-"), (cmd, "cmd-")] {
        if on {
            out.push_str(name);
        }
    }
    out.push_str(&key);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Mods = Mods { ctrl: false, alt: false, shift: false, cmd: false };

    fn m(ctrl: bool, alt: bool, shift: bool, cmd: bool) -> Mods {
        Mods { ctrl, alt, shift, cmd }
    }

    #[test]
    fn 文字は入力方式へ回す() {
        assert_eq!(to_bytes("a", NONE, false), None);
        assert_eq!(to_bytes("a", m(false, false, true, false), false), None);
        assert_eq!(to_bytes("space", NONE, false), None);
    }

    #[test]
    fn 改行と_shift_enter() {
        assert_eq!(to_bytes("enter", NONE, false), Some(b"\r".to_vec()));
        assert_eq!(to_bytes("enter", m(false, false, true, false), false), Some(b"\x1b\r".to_vec()));
    }

    #[test]
    fn 矢印はカーソルのモードで変わる() {
        assert_eq!(to_bytes("up", NONE, false), Some(b"\x1b[A".to_vec()));
        assert_eq!(to_bytes("up", NONE, true), Some(b"\x1bOA".to_vec()));
        assert_eq!(to_bytes("up", m(true, false, true, false), true), Some(b"\x1b[1;6A".to_vec()));
    }

    #[test]
    fn 行の編集の近道() {
        assert_eq!(to_bytes("left", m(false, true, false, false), false), Some(b"\x1bb".to_vec()));
        assert_eq!(to_bytes("right", m(false, true, false, false), false), Some(b"\x1bf".to_vec()));
        assert_eq!(to_bytes("left", m(false, false, false, true), false), Some(vec![0x01]));
        assert_eq!(to_bytes("backspace", m(false, false, false, true), false), Some(vec![0x15]));
        assert_eq!(to_bytes("t", m(false, false, false, true), false), None);
    }

    #[test]
    fn control_と_option() {
        assert_eq!(to_bytes("c", m(true, false, false, false), false), Some(vec![3]));
        assert_eq!(to_bytes("space", m(true, false, false, false), false), Some(vec![0]));
        assert_eq!(to_bytes("x", m(false, true, false, false), false), Some(b"\x1bx".to_vec()));
        assert_eq!(to_bytes("x", m(false, true, true, false), false), Some(b"\x1bX".to_vec()));
        assert_eq!(to_bytes("backspace", m(false, true, false, false), false), Some(b"\x1b\x7f".to_vec()));
    }

    #[test]
    fn ファンクションキー() {
        assert_eq!(to_bytes("f1", NONE, false), Some(b"\x1bOP".to_vec()));
        assert_eq!(to_bytes("f5", NONE, false), Some(b"\x1b[15~".to_vec()));
        assert_eq!(to_bytes("pagedown", m(false, false, true, false), false), Some(b"\x1b[6;2~".to_vec()));
    }

    #[test]
    fn electron_の書き方を直す() {
        assert_eq!(accelerator_to_gpui("Command+T").as_deref(), Some("cmd-t"));
        assert_eq!(accelerator_to_gpui("Control+Command+]").as_deref(), Some("ctrl-cmd-]"));
        assert_eq!(accelerator_to_gpui("Command+Shift+[").as_deref(), Some("shift-cmd-["));
        assert_eq!(accelerator_to_gpui("Command+{").as_deref(), Some("shift-cmd-["));
        assert_eq!(accelerator_to_gpui("Command+Plus").as_deref(), Some("cmd-+"));
        assert_eq!(accelerator_to_gpui("Control+Tab").as_deref(), Some("ctrl-tab"));
        assert_eq!(accelerator_to_gpui("Command+Alt+Left").as_deref(), Some("alt-cmd-left"));
        assert_eq!(accelerator_to_gpui("T"), None);
        assert_eq!(accelerator_to_gpui("Hyper+T"), None);
    }
}
