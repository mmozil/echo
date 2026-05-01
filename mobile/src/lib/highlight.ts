// Mesma técnica de highlight do web Echo: 1 path SVG com sub-paths round-rect
// por linha da frase atual

export type Word = { word: string; x0: number; y0: number; x1: number; y1: number };

export function roundRectPath(x0: number, y0: number, x1: number, y1: number, r: number): string {
  const w = x1 - x0, h = y1 - y0;
  const rr = Math.min(r, w / 2, h / 2);
  return `M ${x0+rr},${y0} L ${x1-rr},${y0} Q ${x1},${y0},${x1},${y0+rr} L ${x1},${y1-rr} Q ${x1},${y1},${x1-rr},${y1} L ${x0+rr},${y1} Q ${x0},${y1},${x0},${y1-rr} L ${x0},${y0+rr} Q ${x0},${y0},${x0+rr},${y0} Z`;
}

export function groupLines(words: Word[], fromIdx: number, toIdx: number) {
  const Y_TOL = 0.006;
  const lines: { x0: number; y0: number; x1: number; y1: number; yMid: number }[] = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    const w = words[i];
    if (!w) continue;
    const last = lines[lines.length - 1];
    const yMid = (w.y0 + w.y1) / 2;
    if (last && Math.abs(yMid - last.yMid) < Y_TOL) {
      last.x0 = Math.min(last.x0, w.x0);
      last.x1 = Math.max(last.x1, w.x1);
      last.y0 = Math.min(last.y0, w.y0);
      last.y1 = Math.max(last.y1, w.y1);
    } else {
      lines.push({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, yMid });
    }
  }
  return lines;
}

export function buildSentenceD(
  words: Word[], sentStart: number, sentEnd: number,
  padX = 0.003, padY = 0.002, radius = 8
): string {
  const lines = groupLines(words, sentStart, sentEnd);
  if (!lines.length) return '';
  return lines.map(r => roundRectPath(
    (r.x0 - padX) * 1000,
    (r.y0 - padY) * 1000,
    (r.x1 + padX) * 1000,
    (r.y1 + padY) * 1000,
    radius
  )).join(' ');
}

const STOP = /[.!?;]$/;

// Encontra início e fim da frase contendo a palavra `idx`
export function sentenceRange(words: Word[], idx: number): [number, number] {
  let start = idx, end = idx;
  for (let i = idx - 1; i >= 0; i--) {
    if (STOP.test(words[i].word)) break;
    start = i;
  }
  for (let i = idx; i < words.length; i++) {
    end = i;
    if (STOP.test(words[i].word)) break;
  }
  return [start, end];
}

// Acha palavra mais próxima das coords relativas (0-1)
// Estratégia "linha-primeiro": filtra palavras onde Y bate com o toque, depois
// pega a mais próxima em X. Bem mais preciso que distância 2D ponderada.
export function findNearestWord(words: Word[], relX: number, relY: number): number {
  if (!words.length) return 0;
  // Tolerância vertical pra clicks ligeiramente acima/abaixo (1% da altura)
  const Y_PAD = 0.012;
  const onLine: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (relY >= w.y0 - Y_PAD && relY <= w.y1 + Y_PAD) onLine.push(i);
  }
  if (onLine.length) {
    // Entre palavras da mesma linha, a mais próxima em X
    let best = onLine[0], bestDx = Infinity;
    for (const i of onLine) {
      const w = words[i];
      const wxm = (w.x0 + w.x1) / 2;
      const dx = Math.abs(wxm - relX);
      if (dx < bestDx) { bestDx = dx; best = i; }
    }
    return best;
  }
  // Fallback: distância 2D pura (sem peso) quando o clique cai entre linhas
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const wxm = (w.x0 + w.x1) / 2;
    const wym = (w.y0 + w.y1) / 2;
    const dx = wxm - relX, dy = wym - relY;
    const d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

// Match por sequência no .text dos boundaries do TTS (mesma lógica do web)
const clean = (s: string) => (s || '').toLowerCase().replace(/[.,;:!?"'()\[\]\-]/g, '').trim();

export function findBoundaryByWordSequenceScored(
  contextWords: string[],
  boundaries: Array<{ text: string }>
): { idx: number; score: number } {
  if (!boundaries.length) return { idx: -1, score: 0 };
  const context = contextWords.map(clean).filter(Boolean).slice(0, 10);
  if (!context.length) return { idx: -1, score: 0 };
  let bestScore = 0, bestIdx = -1;
  for (let bi = 0; bi < boundaries.length; bi++) {
    let score = 0, off = 0;
    for (let ci = 0; ci < context.length && bi + off < boundaries.length; ci++) {
      const bt = clean(boundaries[bi + off].text);
      if (bt === context[ci]) { score += 3; off++; }
      else if (bt.startsWith(context[ci]) || context[ci].startsWith(bt)) { score += 1; off++; }
      else {
        if (bi + off + 1 < boundaries.length) {
          const bt2 = clean(boundaries[bi + off + 1].text);
          if (bt2 === context[ci]) { score += 2; off += 2; }
          else off++;
        } else off++;
      }
    }
    if (score > bestScore) { bestScore = score; bestIdx = bi; }
  }
  return { idx: bestIdx, score: bestScore };
}

// Compat: retorna só o índice (mantém API antiga)
export function findBoundaryByWordSequence(
  contextWords: string[],
  boundaries: Array<{ text: string }>
): number {
  return findBoundaryByWordSequenceScored(contextWords, boundaries).idx;
}
