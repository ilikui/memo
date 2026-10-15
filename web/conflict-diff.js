export function buildLineDiff(localText, serverText, maxCells = 40000) {
  const localLines = String(localText).split("\n");
  const serverLines = String(serverText).split("\n");
  if (localLines.length * serverLines.length > maxCells) {
    return { fallback: true, localLines, serverLines, lines: [] };
  }

  const rows = localLines.length + 1;
  const cols = serverLines.length + 1;
  const lcs = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = localLines.length - 1; i >= 0; i--) {
    for (let j = serverLines.length - 1; j >= 0; j--) {
      lcs[i][j] = localLines[i] === serverLines[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines = [];
  let i = 0;
  let j = 0;
  while (i < localLines.length || j < serverLines.length) {
    if (i < localLines.length && j < serverLines.length && localLines[i] === serverLines[j]) {
      lines.push({ kind: "same", marker: " ", text: localLines[i], lineNumber: i + 1 });
      i++; j++;
    } else if (i < localLines.length && (j >= serverLines.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      lines.push({ kind: "removed", marker: "−", text: localLines[i], lineNumber: i + 1 });
      i++;
    } else {
      lines.push({ kind: "added", marker: "+", text: serverLines[j], lineNumber: j + 1 });
      j++;
    }
  }
  return { fallback: false, localLines, serverLines, lines };
}
