// 画面の分割。枠（pane）ごとにタブの並びを持ち、枠を縦横の入れ子で並べる。
use serde::{Deserialize, Serialize};
pub const MAX_PANES: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Axis {
    // 左右に並べる
    Row,
    // 上下に並べる
    Column,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Left,
    Right,
    Up,
    Down,
}

// タブを落とす位置。端の25%はその側へ分割し、真ん中は枠のタブに足す
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
    Top,
    Bottom,
    Center,
}

// x・y は枠の中の位置を 0〜1 の割合で表したもの
pub fn drop_side(x: f32, y: f32) -> Side {
    let mut sides = [(Side::Left, x), (Side::Right, 1.0 - x), (Side::Top, y), (Side::Bottom, 1.0 - y)];
    sides.sort_by(|a, b| a.1.total_cmp(&b.1));
    if sides[0].1 < 0.25 { sides[0].0 } else { Side::Center }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Node {
    Leaf(u64),
    Split { axis: Axis, children: Vec<Node>, sizes: Vec<f32> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pane {
    pub id: u64,
    pub tabs: Vec<u64>,
    pub active: Option<u64>,
    // 固定した枠は、一覧から選んでも中身を差し替えない
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layout {
    pub root: Node,
    pub panes: Vec<Pane>,
    pub active_pane: u64,
    next_pane: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Default for Layout {
    fn default() -> Self {
        Layout { root: Node::Leaf(1), panes: vec![Pane { id: 1, tabs: Vec::new(), active: None, locked: false }], active_pane: 1, next_pane: 2 }
    }
}

impl Layout {
    pub fn pane(&self, id: u64) -> Option<&Pane> {
        self.panes.iter().find(|p| p.id == id)
    }

    fn pane_mut(&mut self, id: u64) -> Option<&mut Pane> {
        self.panes.iter_mut().find(|p| p.id == id)
    }

    pub fn active(&self) -> &Pane {
        self.pane(self.active_pane).unwrap_or(&self.panes[0])
    }

    pub fn active_tab(&self) -> Option<u64> {
        self.active().active
    }

    pub fn pane_of(&self, tab: u64) -> Option<u64> {
        self.panes.iter().find(|p| p.tabs.contains(&tab)).map(|p| p.id)
    }

    // タブの番号を付け替える（開き直したときの番号へ）。対応の無いタブは除き、空いた枠は畳む
    pub fn map_tabs(&self, map: impl Fn(u64) -> Option<u64>) -> Layout {
        let mut l = self.clone();
        for p in &mut l.panes {
            p.tabs = p.tabs.iter().filter_map(|t| map(*t)).collect();
            p.tabs.dedup();
            p.active = p.active.and_then(&map).filter(|a| p.tabs.contains(a)).or_else(|| p.tabs.last().copied());
        }
        let empty: Vec<u64> = l.panes.iter().filter(|p| p.tabs.is_empty()).map(|p| p.id).collect();
        for id in empty {
            l.collapse_empty(Some(id));
        }
        if l.pane(l.active_pane).is_none() {
            l.active_pane = l.panes[0].id;
        }
        l.next_pane = l.panes.iter().map(|p| p.id).max().unwrap_or(0) + 1;
        l
    }

    pub fn all_tabs(&self) -> Vec<u64> {
        self.panes.iter().flat_map(|p| p.tabs.iter().copied()).collect()
    }

    // 枠に表示中のタブ
    pub fn visible(&self) -> Vec<u64> {
        self.panes.iter().filter_map(|p| p.active).collect()
    }

    pub fn add_tab(&mut self, tab: u64) {
        let pane = self.active_pane;
        if let Some(p) = self.pane_mut(pane) {
            p.tabs.push(tab);
            p.active = Some(tab);
        }
    }

    pub fn select(&mut self, tab: u64) -> bool {
        let Some(pane) = self.pane_of(tab) else { return false };
        self.active_pane = pane;
        if let Some(p) = self.pane_mut(pane) {
            p.active = Some(tab);
        }
        true
    }

    // 枠に無いタブを出す。操作中の枠が固定なら、固定していない枠の並びの先に出し、
    // 全部固定なら右に枠を足す（6枠ならそのまま操作中の枠に出す）
    pub fn show_tab(&mut self, tab: u64) {
        if self.select(tab) {
            return;
        }
        if !self.active().locked {
            self.add_tab(tab);
            return;
        }
        let free = self.leaf_order().into_iter().find(|id| self.pane(*id).is_some_and(|p| !p.locked));
        match free {
            Some(pane) => {
                self.active_pane = pane;
                self.add_tab(tab);
            }
            None => {
                if !self.split(Axis::Row, tab) {
                    self.add_tab(tab);
                }
            }
        }
    }

    pub fn toggle_lock(&mut self, pane: u64) {
        if let Some(p) = self.pane_mut(pane) {
            p.locked = !p.locked;
        }
    }

    pub fn focus_pane(&mut self, pane: u64) {
        if self.pane(pane).is_some() {
            self.active_pane = pane;
        }
    }

    // 今の枠の右（または下）に枠を足し、tab をそこへ置く。枠が上限なら false
    pub fn split(&mut self, axis: Axis, tab: u64) -> bool {
        if self.panes.len() >= MAX_PANES {
            return false;
        }
        let id = self.next_pane;
        self.next_pane += 1;
        let target = self.active_pane;
        insert_after(&mut self.root, target, id, axis);
        self.panes.push(Pane { id, tabs: vec![tab], active: Some(tab), locked: false });
        self.active_pane = id;
        true
    }

    // タブを外す。空になった枠は、最後の1つでなければ畳む。表示中のタブだった枠では、fallback を優先して次を選ぶ
    pub fn remove_tab(&mut self, tab: u64, recent: &[u64]) {
        let Some(pane_id) = self.pane_of(tab) else { return };
        let pane = self.pane_mut(pane_id).expect("枠がある");
        let index = pane.tabs.iter().position(|t| *t == tab).unwrap_or(0);
        pane.tabs.retain(|t| *t != tab);
        if pane.active == Some(tab) {
            let next = recent.iter().rev().find(|r| pane.tabs.contains(r)).copied();
            pane.active = next.or_else(|| pane.tabs.get(index.min(pane.tabs.len().saturating_sub(1))).copied());
        }
        if pane.tabs.is_empty() && self.panes.len() > 1 {
            self.panes.retain(|p| p.id != pane_id);
            remove_leaf(&mut self.root, pane_id);
            collapse(&mut self.root);
            if self.active_pane == pane_id {
                self.active_pane = self.leaf_order().first().copied().unwrap_or(self.panes[0].id);
            }
        }
    }

    pub fn leaf_order(&self) -> Vec<u64> {
        let mut out = Vec::new();
        leaves(&self.root, &mut out);
        out
    }

    pub fn rects(&self) -> Vec<(u64, Rect)> {
        let mut out = Vec::new();
        layout_rects(&self.root, Rect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, &mut out);
        out
    }

    // 今の枠から、指定の向きにある最も近い枠
    pub fn neighbor(&self, direction: Direction) -> Option<u64> {
        let rects = self.rects();
        let (_, from) = rects.iter().find(|(id, _)| *id == self.active_pane)?;
        let (cx, cy) = (from.x + from.w / 2.0, from.y + from.h / 2.0);
        let eps = 1e-4;
        rects
            .iter()
            .filter(|(id, _)| *id != self.active_pane)
            .filter(|(_, r)| match direction {
                Direction::Left => r.x + r.w <= from.x + eps && overlaps(r.y, r.h, from.y, from.h),
                Direction::Right => r.x >= from.x + from.w - eps && overlaps(r.y, r.h, from.y, from.h),
                Direction::Up => r.y + r.h <= from.y + eps && overlaps(r.x, r.w, from.x, from.w),
                Direction::Down => r.y >= from.y + from.h - eps && overlaps(r.x, r.w, from.x, from.w),
            })
            .min_by(|(_, a), (_, b)| {
                let d = |r: &Rect| ((r.x + r.w / 2.0 - cx).powi(2) + (r.y + r.h / 2.0 - cy).powi(2)).sqrt();
                d(a).total_cmp(&d(b))
            })
            .map(|(id, _)| *id)
    }

    // タブを枠へ動かす。端なら新しい枠を作る。動かした結果、タブの無くなった枠が残れば（自分の枠の端へ落としたとき）その枠を返す
    pub fn move_tab(&mut self, tab: u64, target: u64, side: Side) -> Option<u64> {
        let source = self.pane_of(tab);
        let side = if self.panes.len() >= MAX_PANES && source.is_none_or(|s| s != target || self.pane(s).is_some_and(|p| p.tabs.len() > 1)) {
            Side::Center
        } else {
            side
        };
        if side == Side::Center {
            if source == Some(target) {
                self.select(tab);
                return None;
            }
            self.detach(tab);
            if let Some(p) = self.pane_mut(target) {
                p.tabs.push(tab);
                p.active = Some(tab);
            }
            self.active_pane = target;
            self.collapse_empty(source);
            return None;
        }
        if self.pane(target).is_none() {
            return None;
        }
        self.detach(tab);
        let id = self.next_pane;
        self.next_pane += 1;
        let (axis, before) = match side {
            Side::Left => (Axis::Row, true),
            Side::Right => (Axis::Row, false),
            Side::Top => (Axis::Column, true),
            _ => (Axis::Column, false),
        };
        insert_beside(&mut self.root, target, id, axis, before);
        self.panes.push(Pane { id, tabs: vec![tab], active: Some(tab), locked: false });
        self.active_pane = id;
        let left_empty = source.filter(|s| self.pane(*s).is_some_and(|p| p.tabs.is_empty()));
        if left_empty == Some(target) {
            return left_empty;
        }
        self.collapse_empty(source);
        None
    }

    // 枠からタブを外すだけ。枠は畳まない
    fn detach(&mut self, tab: u64) {
        let Some(pane) = self.pane_of(tab) else { return };
        let p = self.pane_mut(pane).expect("枠がある");
        p.tabs.retain(|t| *t != tab);
        if p.active == Some(tab) {
            p.active = p.tabs.last().copied();
        }
    }

    fn collapse_empty(&mut self, pane: Option<u64>) {
        let Some(pane) = pane else { return };
        if self.panes.len() > 1 && self.pane(pane).is_some_and(|p| p.tabs.is_empty()) {
            self.panes.retain(|p| p.id != pane);
            remove_leaf(&mut self.root, pane);
            collapse(&mut self.root);
            if self.active_pane == pane {
                self.active_pane = self.leaf_order().first().copied().unwrap_or(self.panes[0].id);
            }
        }
    }

    // 枠の中のタブの並びを変える。to は落とした先のタブの位置
    pub fn reorder(&mut self, tab: u64, before: u64) {
        let Some(pane) = self.pane_of(before) else { return };
        if self.pane_of(tab) != Some(pane) {
            self.move_tab(tab, pane, Side::Center);
        }
        let p = self.pane_mut(pane).expect("枠がある");
        p.tabs.retain(|t| *t != tab);
        let at = p.tabs.iter().position(|t| *t == before).unwrap_or(p.tabs.len());
        p.tabs.insert(at, tab);
        p.active = Some(tab);
        self.active_pane = pane;
    }

    // 隣り合う枠を半分ずつに戻す
    pub fn equalize(&mut self, path: &[usize]) {
        if let Some(Node::Split { sizes, .. }) = node_at_mut(&mut self.root, path) {
            let n = sizes.len() as f32;
            sizes.iter_mut().for_each(|s| *s = 1.0 / n);
        }
    }

    // path は根から分割を辿る子の番号。index と index+1 の境目を delta（割合）だけ動かす
    pub fn resize(&mut self, path: &[usize], index: usize, delta: f32) {
        let Some(Node::Split { sizes, .. }) = node_at_mut(&mut self.root, path) else { return };
        if index + 1 >= sizes.len() {
            return;
        }
        const MIN: f32 = 0.1;
        let total = sizes[index] + sizes[index + 1];
        let a = (sizes[index] + delta).clamp(MIN, total - MIN);
        sizes[index] = a;
        sizes[index + 1] = total - a;
    }
}

fn overlaps(a: f32, alen: f32, b: f32, blen: f32) -> bool {
    a < b + blen - 1e-4 && b < a + alen - 1e-4
}

fn insert_after(node: &mut Node, target: u64, new: u64, axis: Axis) -> bool {
    let done = insert_beside(node, target, new, axis, false);
    // ⌘\ の分割は、並びを等分する
    equalize_parent(node, new);
    done
}

fn equalize_parent(node: &mut Node, leaf: u64) {
    if let Node::Split { children, sizes, .. } = node {
        if children.iter().any(|c| matches!(c, Node::Leaf(id) if *id == leaf)) {
            let n = sizes.len() as f32;
            sizes.iter_mut().for_each(|s| *s = 1.0 / n);
            return;
        }
        children.iter_mut().for_each(|c| equalize_parent(c, leaf));
    }
}

fn insert_beside(node: &mut Node, target: u64, new: u64, axis: Axis, before: bool) -> bool {
    match node {
        Node::Leaf(id) if *id == target => {
            let pair = if before { vec![Node::Leaf(new), Node::Leaf(target)] } else { vec![Node::Leaf(target), Node::Leaf(new)] };
            *node = Node::Split { axis, children: pair, sizes: vec![0.5, 0.5] };
            true
        }
        Node::Leaf(_) => false,
        Node::Split { axis: own, children, sizes } => {
            let Some(i) = children.iter().position(|c| contains_leaf(c, target)) else { return false };
            if *own == axis && matches!(children[i], Node::Leaf(_)) {
                // 落とした枠の幅を半分ずつに分ける
                let half = sizes[i] / 2.0;
                sizes[i] = half;
                let at = if before { i } else { i + 1 };
                children.insert(at, Node::Leaf(new));
                sizes.insert(at, half);
                true
            } else {
                insert_beside(&mut children[i], target, new, axis, before)
            }
        }
    }
}

fn contains_leaf(node: &Node, target: u64) -> bool {
    match node {
        Node::Leaf(id) => *id == target,
        Node::Split { children, .. } => children.iter().any(|c| contains_leaf(c, target)),
    }
}

fn remove_leaf(node: &mut Node, target: u64) {
    if let Node::Split { children, sizes, .. } = node {
        if let Some(i) = children.iter().position(|c| matches!(c, Node::Leaf(id) if *id == target)) {
            let freed = sizes.remove(i);
            children.remove(i);
            // 空いた幅は隣の枠に渡す
            if !sizes.is_empty() {
                let j = i.min(sizes.len() - 1);
                sizes[j] += freed;
            }
            return;
        }
        for child in children.iter_mut() {
            remove_leaf(child, target);
        }
    }
}

// 子が1つだけになった分割は、その子に置き換える
fn collapse(node: &mut Node) {
    if let Node::Split { children, .. } = node {
        for child in children.iter_mut() {
            collapse(child);
        }
        if children.len() == 1 {
            *node = children.remove(0);
        }
    }
}

fn leaves(node: &Node, out: &mut Vec<u64>) {
    match node {
        Node::Leaf(id) => out.push(*id),
        Node::Split { children, .. } => children.iter().for_each(|c| leaves(c, out)),
    }
}

fn layout_rects(node: &Node, rect: Rect, out: &mut Vec<(u64, Rect)>) {
    match node {
        Node::Leaf(id) => out.push((*id, rect)),
        Node::Split { axis, children, sizes } => {
            let mut offset = 0.0;
            for (child, size) in children.iter().zip(sizes) {
                let r = match axis {
                    Axis::Row => Rect { x: rect.x + rect.w * offset, y: rect.y, w: rect.w * size, h: rect.h },
                    Axis::Column => Rect { x: rect.x, y: rect.y + rect.h * offset, w: rect.w, h: rect.h * size },
                };
                layout_rects(child, r, out);
                offset += size;
            }
        }
    }
}

fn node_at_mut<'a>(node: &'a mut Node, path: &[usize]) -> Option<&'a mut Node> {
    match path.split_first() {
        None => Some(node),
        Some((i, rest)) => match node {
            Node::Split { children, .. } => node_at_mut(children.get_mut(*i)?, rest),
            Node::Leaf(_) => None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout_with(tabs: &[u64]) -> Layout {
        let mut l = Layout::default();
        for t in tabs {
            l.add_tab(*t);
        }
        l
    }

    #[test]
    fn 右に分割して新しい枠へ移る() {
        let mut l = layout_with(&[10, 11]);
        assert!(l.split(Axis::Row, 12));
        assert_eq!(l.panes.len(), 2);
        assert_eq!(l.active_tab(), Some(12));
        assert_eq!(l.visible(), vec![11, 12]);
        assert_eq!(l.neighbor(Direction::Left), Some(1));
        assert_eq!(l.neighbor(Direction::Right), None);
    }

    #[test]
    fn 同じ向きの分割は並びに足して等分する() {
        let mut l = layout_with(&[10]);
        l.split(Axis::Row, 11);
        l.split(Axis::Row, 12);
        let Node::Split { children, sizes, .. } = &l.root else { panic!() };
        assert_eq!(children.len(), 3);
        assert!(sizes.iter().all(|s| (s - 1.0 / 3.0).abs() < 1e-6));
    }

    #[test]
    fn 枠は六つまで() {
        let mut l = layout_with(&[1]);
        for t in 2..=6 {
            assert!(l.split(Axis::Row, t));
        }
        assert!(!l.split(Axis::Row, 7));
    }

    #[test]
    fn 最後のタブを閉じた枠は畳む() {
        let mut l = layout_with(&[10]);
        l.split(Axis::Row, 11);
        l.remove_tab(11, &[]);
        assert_eq!(l.panes.len(), 1);
        assert_eq!(l.root, Node::Leaf(1));
        assert_eq!(l.active_tab(), Some(10));
    }

    #[test]
    fn 閉じたら直前に見ていたタブへ戻る() {
        let mut l = layout_with(&[10, 11, 12]);
        l.select(12);
        l.remove_tab(12, &[10]);
        assert_eq!(l.active_tab(), Some(10));
    }

    #[test]
    fn 上下の隣を見つける() {
        let mut l = layout_with(&[10]);
        l.split(Axis::Column, 11);
        assert_eq!(l.neighbor(Direction::Up), Some(1));
        l.focus_pane(1);
        assert_eq!(l.neighbor(Direction::Down), Some(2));
    }

    #[test]
    fn 端の四分の一で分割の向きを決める() {
        assert_eq!(drop_side(0.1, 0.5), Side::Left);
        assert_eq!(drop_side(0.5, 0.9), Side::Bottom);
        assert_eq!(drop_side(0.5, 0.5), Side::Center);
        assert_eq!(drop_side(0.05, 0.2), Side::Left);
    }

    #[test]
    fn 別の枠の端へ落とすと新しい枠になり元の空の枠は畳む() {
        let mut l = layout_with(&[10]);
        l.split(Axis::Row, 11);
        assert_eq!(l.move_tab(11, 1, Side::Top), None);
        assert_eq!(l.panes.len(), 2);
        let Node::Split { axis, children, .. } = &l.root else { panic!() };
        assert_eq!(*axis, Axis::Column);
        assert_eq!(children[1], Node::Leaf(1));
        assert_eq!(l.active_tab(), Some(11));
    }

    #[test]
    fn 真ん中へ落とすとその枠のタブに足す() {
        let mut l = layout_with(&[10]);
        l.split(Axis::Row, 11);
        l.move_tab(11, 1, Side::Center);
        assert_eq!(l.panes.len(), 1);
        assert_eq!(l.pane(1).unwrap().tabs, vec![10, 11]);
        assert_eq!(l.active_tab(), Some(11));
    }

    #[test]
    fn 一つだけのタブを自分の枠の端へ落とすと空の枠を返す() {
        let mut l = layout_with(&[10]);
        assert_eq!(l.move_tab(10, 1, Side::Right), Some(1));
        assert_eq!(l.panes.len(), 2);
        assert_eq!(l.visible(), vec![10]);
    }

    #[test]
    fn 開き直しで番号を付け替え消えたタブの枠は畳む() {
        let mut l = layout_with(&[10]);
        l.split(Axis::Row, 11);
        let m = l.map_tabs(|t| (t == 10).then_some(100));
        assert_eq!(m.panes.len(), 1);
        assert_eq!(m.active_tab(), Some(100));
        assert_eq!(m.root, Node::Leaf(1));
    }

    #[test]
    fn 固定した枠には出さず固定していない枠へ出す() {
        let mut l = layout_with(&[10]);
        l.split(Axis::Row, 11);
        l.focus_pane(2);
        l.toggle_lock(2);
        l.show_tab(12);
        assert_eq!(l.pane(1).unwrap().tabs, vec![10, 12]);
        assert_eq!(l.pane(2).unwrap().tabs, vec![11]);
    }

    #[test]
    fn 全部固定なら右に枠を足す() {
        let mut l = layout_with(&[10]);
        l.toggle_lock(1);
        l.show_tab(11);
        assert_eq!(l.panes.len(), 2);
        assert_eq!(l.active_tab(), Some(11));
    }

    #[test]
    fn タブの並びを変える() {
        let mut l = layout_with(&[10, 11, 12]);
        l.reorder(12, 10);
        assert_eq!(l.pane(1).unwrap().tabs, vec![12, 10, 11]);
    }

    #[test]
    fn 境目を動かしても最小幅を保つ() {
        let mut l = layout_with(&[10]);
        l.split(Axis::Row, 11);
        l.resize(&[], 0, 0.9);
        let Node::Split { sizes, .. } = &l.root else { panic!() };
        assert!((sizes[0] - 0.9).abs() < 1e-6 && (sizes[1] - 0.1).abs() < 1e-6);
    }
}
