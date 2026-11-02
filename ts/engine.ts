/**
 * jansou_engine.py のうち server.py が使う部分の移植。
 * 牌は 0-33 の整数（0-8=萬子1-9, 9-17=筒子1-9, 18-26=索子1-9,
 * 27-33=東南西北白發中）。
 */
export const HONOR_NAMES = ["東", "南", "西", "北", "白", "發", "中"];

export function tileName(t: number): string {
  if (t < 9) return `${t + 1}m`;
  if (t < 18) return `${t - 8}p`;
  if (t < 27) return `${t - 17}s`;
  return HONOR_NAMES[t - 27];
}

export function countsOf(hand: readonly number[]): number[] {
  const c = new Array<number>(34).fill(0);
  for (const t of hand) c[t] += 1;
  return c;
}

/** ダミー打牌用の単純な牌効率スコア（play_bots 用）。 */
export function connScore(c: readonly number[], t: number): number {
  let s = 3.0 * (c[t] - 1);
  if (t < 27) {
    const pos = t % 9;
    if (pos > 0) s += c[t - 1];
    if (pos < 8) s += c[t + 1];
    if (pos > 1) s += 0.5 * c[t - 2];
    if (pos < 7) s += 0.5 * c[t + 2];
  }
  return s;
}

/** Python の list.remove（最初の一致を1つ削除）。無ければ例外相当で false。 */
export function removeOne(arr: number[], v: number): boolean {
  const i = arr.indexOf(v);
  if (i < 0) return false;
  arr.splice(i, 1);
  return true;
}
