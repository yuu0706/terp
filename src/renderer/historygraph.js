// ブラウザに依存させず、ページを追加した後も同じ列の割り当てを再現する
export const GRAPH_COLORS = ['accent', 'yellow', 'red', 'blue', 'magenta', 'cyan', 'green', 'brightYellow', 'brightRed', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightGreen'];

export function buildHistoryGraph(commits) {
  const lanes = [];
  let nextColor = 0;
  let columns = 0;
  function colorAt(column) {
    const advance = () => { nextColor = nextColor % (GRAPH_COLORS.length - 1) + 1; };
    while ([lanes[column - 1], lanes[column + 1]].some((lane) => lane?.color === nextColor)) advance();
    const color = nextColor;
    advance();
    return color;
  }
  function vacant() {
    const empty = lanes.findIndex((lane) => !lane);
    return empty < 0 ? lanes.length : empty;
  }
  const rows = commits.map(({ hash, parents }) => {
    const waiting = [];
    lanes.forEach((lane, column) => { if (lane?.hash === hash) waiting.push(column); });
    const column = waiting.length ? waiting[0] : vacant();
    const color = waiting.length ? lanes[column].color : colorAt(column);
    const incoming = waiting.map((from) => ({ from, to: column, color: lanes[from].color }));
    const through = [];
    lanes.forEach((lane, index) => {
      if (lane && !waiting.includes(index)) through.push({ column: index, color: lane.color });
    });
    columns = Math.max(columns, lanes.length, column + 1);
    waiting.forEach((index) => { lanes[index] = null; });
    const outgoing = [];
    const uniqueParents = [...new Set(parents)];
    uniqueParents.forEach((parent, index) => {
      let target;
      if (index === 0) {
        target = column;
        lanes[target] = { hash: parent, color };
      } else {
        target = lanes.findIndex((lane) => lane?.hash === parent);
        if (target < 0) {
          target = vacant();
          lanes[target] = { hash: parent, color: colorAt(target) };
        }
      }
      outgoing.push({ from: column, to: target, color: lanes[target].color });
    });
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    columns = Math.max(columns, lanes.length);
    return { hash, node: { column, color, merge: parents.length > 1 }, through, incoming, outgoing };
  });
  return { rows, columns };
}
