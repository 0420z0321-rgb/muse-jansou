/**
 * CPython の random.Random（MT19937）と互換の乱数。
 *
 * Python 参照実装の _start_hand は Random(seed).shuffle で山を作り、
 * fixture の遷移 snapshot には次局のツモ牌（last_drawn）まで含まれる。
 * そのため TS 側でも Python と同一の牌順を再現できる必要がある。
 * 実装は CPython の Modules/_randommodule.c と同じ手順：
 * init_by_array による種付け、genrand_uint32、getrandbits、
 * _randbelow、shuffle（Fisher-Yates を末尾から）。
 */
export class PythonRandom {
  private mt = new Uint32Array(624);
  private index = 624;

  constructor(seed?: number | null) {
    if (seed === undefined || seed === null) {
      // Python の Random(None)：システムエントロピー。本用途では時刻で代用。
      this.seedInt(Date.now() % 4294967296);
    } else {
      this.seedInt(seed);
    }
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) {
      const prev = mt[i - 1];
      mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.index = 624;
  }

  seedInt(seed: number): void {
    // CPython: int 種は abs 値を 32bit リトルエンディアンの語列にする（0 は [0]）
    let n = Math.abs(Math.floor(seed));
    const key: number[] = [];
    if (n === 0) key.push(0);
    while (n > 0) {
      key.push(n % 4294967296);
      n = Math.floor(n / 4294967296);
    }
    this.initGenrand(19650218);
    const mt = this.mt;
    let i = 1;
    let j = 0;
    let k = Math.max(624, key.length);
    for (; k > 0; k--) {
      const prev = mt[i - 1];
      mt[i] =
        ((mt[i] ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + key[j] + j) >>>
        0;
      i++;
      j++;
      if (i >= 624) {
        mt[0] = mt[623];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (k = 623; k > 0; k--) {
      const prev = mt[i - 1];
      mt[i] =
        ((mt[i] ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) {
        mt[0] = mt[623];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
    this.index = 624;
  }

  private genrandUint32(): number {
    const mt = this.mt;
    if (this.index >= 624) {
      let kk = 0;
      for (; kk < 227; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + 397] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      for (; kk < 623; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk - 227] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      const y = (mt[623] & 0x80000000) | (mt[0] & 0x7fffffff);
      mt[623] = mt[396] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      this.index = 0;
    }
    let y = mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** CPython getrandbits(k)。k<=32 のみ（本用途は k<=8）。 */
  getrandbits(k: number): number {
    if (k === 0) return 0;
    if (k > 32) throw new Error("getrandbits: k > 32 not supported");
    return this.genrandUint32() >>> (32 - k);
  }

  randbelow(n: number): number {
    const k = n.toString(2).length; // bit_length
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  /** CPython random() と同じ 53bit 浮動小数。 */
  random(): number {
    const a = this.genrandUint32() >>> 5;
    const b = this.genrandUint32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  shuffle(arr: number[]): void {
    for (let i = arr.length - 1; i >= 1; i--) {
      const j = this.randbelow(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }
}
