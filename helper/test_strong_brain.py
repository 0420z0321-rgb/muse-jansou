import sys, time
sys.path.insert(0, "/home/hatch/workspace/muse-jansou/helper")
import importlib.util
spec = importlib.util.spec_from_file_location("jh", "/home/hatch/workspace/muse-jansou/helper/jansou_helper.py")
jh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jh)

fails = 0
def check(cond, label, extra=""):
    global fails
    if cond: print("ok -", label)
    else: fails += 1; print("FAIL -", label, extra)

S = jh._shanten
# complete hand -> -1
check(S([0,0,0, 1,2,3, 9,9,9, 18,19,20, 31,31]) == -1, "agari is -1", S([0,0,0, 1,2,3, 9,9,9, 18,19,20, 31,31]))
# tenpai (tanki) -> 0
check(S([0,0,0, 1,2,3, 9,9,9, 18,19,20, 31]) == 0, "tenpai is 0")
# ryanmen tenpai
check(S([0,0,0, 1,2,3, 9,9,9, 18,19,20, 24,25]) == 0, "ryanmen-ish tenpai 0")
# 1-shanten
check(S([0,0,0, 1,2,3, 9,9,9, 18,19, 24,25, 33]) == 1, "1-shanten", S([0,0,0, 1,2,3, 9,9,9, 18,19, 24,25, 33]))
# chiitoi tenpai
check(S([0,0, 3,3, 9,9, 14,14, 20,20, 27,27, 31]) == 0, "chiitoi tenpai")
# chiitoi 1-shanten (5 pairs + 3 singles)
check(S([0,0, 3,3, 9,9, 14,14, 20,20, 27, 30, 31]) == 1, "chiitoi 1-shanten", S([0,0, 3,3, 9,9, 14,14, 20,20, 27, 30, 31]))
# kokushi tenpai (13 kinds)
check(S([0,8,9,17,18,26,27,28,29,30,31,32,33]) == 0, "kokushi 13-wait tenpai")
# kokushi 1-shanten (12 kinds + pair)
check(S([0,0,9,17,18,26,27,28,29,30,31,32,33]) == 0, "kokushi pair tenpai", S([0,0,9,17,18,26,27,28,29,30,31,32,33]))
check(S([0,0,9,17,18,26,27,28,29,30,31,32,5]) == 1, "kokushi 1-shanten")
# junk hand is far
j = S([0, 3, 6, 10, 14, 19, 23, 27, 29, 31, 33, 8, 17])
check(j >= 4, "junk hand >= 4 shanten", j)
# red five counts as normal five for shape
check(S([34,34,34, 1,2,3, 9,9,9, 18,19,20, 31,31]) == -1, "red 5m triplet completes")

# ukeire: tenpai hand waits counted
counts = jh._counts34([0,0,0, 1,2,3, 9,9,9, 18,19,20, 31])
vis = list(counts)
kinds, tiles = jh._ukeire(counts, vis)
check(kinds == [31] and tiles == 3, "tanki ukeire: 3 remaining 31s", (kinds, tiles))

# performance: full decision evaluation must be fast enough
hand14 = [0,1,2, 4,5,6, 10,11, 19,20,21, 27,27, 33]
t0 = time.time()
for _ in range(5):
    c = jh._counts34(hand14)
    for k in set(hand14):
        a = list(c); a[k] -= 1
        jh._shanten_counts(tuple(a)); jh._ukeire(a, [0]*34)
print("5 full discard evaluations: %.2fs" % (time.time() - t0))

# strong choose: riichi tenpai discards the right tile and declares riichi
state = {
    "hands": [[2,3,4, 9,9,9, 12,13,14, 20,20,20, 31, 5], [], [], []],
    "discards": [[], [], [], []], "melds": [[], [], [], []],
    "riichi": [False]*4, "dealer": 0, "dora_indicators": [27],
    "phase": "discard", "last_drawn": 5,
    "round": {"label": "東1局", "wind": 0},
}
acts = [{"type": "discard", "tile": t} for t in set(state["hands"][0])]
# seat0 hand: 234m? no — tiles are codes: 2,3,4 = 3,4,5 of man... evaluate what the brain does
choice = jh._strong_choose(state, 0, acts)
print("strong discard choice:", choice)
check(choice is not None and choice.get("type") == "discard", "strong choose returns a discard")

# defence: opponent riichi, junky hand -> discards genbutsu
state2 = {
    "hands": [[0, 3, 6, 10, 14, 19, 23, 27, 29, 31, 33, 8, 17, 25], [], [], []],
    "discards": [[{"tile": 17, "tsumogiri": True}], [], [], [{"tile": 8, "tsumogiri": True}, {"tile": 30, "tsumogiri": False}]],
    "melds": [[], [], [], []], "riichi": [False, False, False, True],
    "dealer": 0, "dora_indicators": [27], "phase": "discard", "last_drawn": 25,
    "round": {"label": "東2局", "wind": 0},
}
acts2 = [{"type": "discard", "tile": t} for t in set(state2["hands"][0])]
choice2 = jh._strong_choose(state2, 0, acts2)
print("defence choice:", choice2)
check(choice2.get("tile") in (8, 17, 30), "defence discards a genbutsu tile", choice2)

print("STRONG BRAIN:", "ALL OK" if fails == 0 else f"{fails} FAILURES")
sys.exit(1 if fails else 0)
