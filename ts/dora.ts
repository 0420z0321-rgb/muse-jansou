/**
 * jansou_dora.py の移植（ドラ計算。役とは分離）。
 * 表示牌→ドラ種は循環：数牌は同色の次（9→1）、風牌は東南西北、三元は白發中。
 * 同じ表示牌が複数ある場合は倍率として数える。赤ドラは未対応（Python 版と同じ）。
 */
export function doraFromIndicator(t: number): number {
  if (0 <= t && t <= 26) {
    const base = Math.floor(t / 9) * 9;
    return base + ((t - base + 1) % 9);
  }
  if (27 <= t && t <= 30) {
    return 27 + ((t - 27 + 1) % 4);
  }
  if (31 <= t && t <= 33) {
    return 31 + ((t - 31 + 1) % 3);
  }
  throw new Error(`invalid tile id: ${t}`);
}

/** tiles（種類IDのリスト）の中のドラ枚数。表示牌の重複は倍率。 */
export function countDora(
  tiles: readonly number[],
  indicators: readonly number[],
): number {
  const tileCounts = new Map<number, number>();
  for (const t of tiles) tileCounts.set(t, (tileCounts.get(t) ?? 0) + 1);
  const doraCounts = new Map<number, number>();
  for (const i of indicators) {
    const d = doraFromIndicator(i);
    doraCounts.set(d, (doraCounts.get(d) ?? 0) + 1);
  }
  let sum = 0;
  for (const [t, m] of doraCounts) sum += (tileCounts.get(t) ?? 0) * m;
  return sum;
}
