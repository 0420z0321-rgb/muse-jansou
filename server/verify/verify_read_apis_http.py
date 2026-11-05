#!/usr/bin/env python3
"""Read-only HTTP smoke check for the Muse雀荘 two new APIs.

All credentials come from the environment; none is printed or placed on the
command line. Example:

    export JANSOU_BASE_URL='https://YOUR-WORKER.workers.dev'
    export JANSOU_ROOM_ID='YOUR-ROOM-ID'
    export JANSOU_PLAYER_TOKEN='...'
    export JANSOU_SPECTATOR_TOKEN='...'    # optional
    export JANSOU_MASTER_TOKEN='...'       # optional (room master, not global)
    python3 verify/verify_read_apis_http.py

Only GETs are sent. It does not create a room, join, claim, play or post cheers.
Do NOT use a live URL until the host has deployed the modified code for tests.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_RESPONSE_BYTES = 512 * 1024
ROOM_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
DIGEST_KEYS = {
    "revision", "latest_seq", "earliest_events_seq", "latest_events_seq",
    "events_cursor_expired", "own_decision", "decision_changed_at",
    "own_cheer_new_count", "cheers_latest_seq_for_seat", "cheers_deferred",
    "occupancy_revision", "server_time",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise AssertionError("Unexpected redirect (credentials must not be forwarded)")


opener = urllib.request.build_opener(NoRedirect())


def request(base: str, path: str, token: str | None) -> tuple[int, dict]:
    url = base + path
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        response = opener.open(req, timeout=20)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        data = response.read(MAX_RESPONSE_BYTES + 1)
        if len(data) > MAX_RESPONSE_BYTES:
            raise AssertionError("Response exceeds safe test size")
        if (response.headers.get("content-type") or "").split(";")[0].strip() != "application/json":
            raise AssertionError("Expected application/json")
        payload = json.loads(data.decode("utf-8"))
        if not isinstance(payload, dict):
            raise AssertionError("Response must be a JSON object")
        return response.status, payload


def require(value: bool, explanation: str) -> None:
    if not value:
        raise AssertionError(explanation)


def check_digest(data: dict) -> None:
    require(set(data) == DIGEST_KEYS, "watch-digest key list changed")
    for key in ("revision", "latest_seq", "earliest_events_seq", "latest_events_seq",
                "own_cheer_new_count", "occupancy_revision", "server_time"):
        require(type(data[key]) is int and data[key] >= 0, f"invalid {key}")
    require(data["latest_seq"] == data["latest_events_seq"], "latest seq aliases disagree")
    require(type(data["events_cursor_expired"]) is bool, "events_cursor_expired must be boolean")
    require(type(data["cheers_deferred"]) is bool, "cheers_deferred must be boolean")
    changed = data["decision_changed_at"]
    require(changed is None or (type(changed) is int and changed >= 0), "invalid decision_changed_at")
    own = data["own_decision"]
    require(own is None or (isinstance(own, dict) and set(own) == {"id", "deadline"}),
            "unexpected own_decision fields")
    if own is not None:
        require(isinstance(own["id"], str) and len(own["id"]) > 0, "invalid own_decision.id")
        deadline = own["deadline"]
        require(deadline is None or (type(deadline) is int and deadline > 0), "invalid deadline")
    watermark = data["cheers_latest_seq_for_seat"]
    require(watermark is None or (type(watermark) is int and watermark >= 0), "invalid cheer watermark")
    if data["cheers_deferred"]:
        require(data["own_cheer_new_count"] == 0 and watermark is None,
                "raw deferred must not deliver or advance cheer notifications")


def check_hand(data: dict) -> None:
    require(data.get("schema_version") == 1, "unknown finished hand schema")
    require(isinstance(data.get("match_key"), str), "missing match key")
    require(isinstance(data.get("hand_key"), str), "missing hand key")
    hands = data.get("final_hands")
    require(isinstance(hands, list) and len(hands) == 4 and all(isinstance(x, list) for x in hands),
            "final_hands must contain four finished tile lists")
    scores = data.get("final_scores")
    require(isinstance(scores, list) and len(scores) == 4 and all(type(x) is int for x in scores),
            "final_scores must contain four scores")
    result = data.get("result")
    require(result is None or isinstance(result, dict), "invalid result")
    changes = data.get("score_changes")
    before = data.get("scores_before")
    if changes is not None or before is not None:
        require(isinstance(before, list) and isinstance(changes, list) and
                len(before) == len(changes) == 4, "incomplete score baseline")
        require(all(type(x) is int for x in before + changes), "score baseline not numeric")
        require([v - a for v, a in zip(scores, before)] == changes, "score delta mismatch")
    require(type(data.get("revision")) is int and type(data.get("ended_at")) is int,
            "missing completed revision/timestamp")


def main() -> int:
    base = os.getenv("JANSOU_BASE_URL", "").rstrip("/")
    room = os.getenv("JANSOU_ROOM_ID", "")
    player = os.getenv("JANSOU_PLAYER_TOKEN", "")
    spectator = os.getenv("JANSOU_SPECTATOR_TOKEN")
    master = os.getenv("JANSOU_MASTER_TOKEN")
    if not base or not ROOM_RE.fullmatch(room) or not player:
        print("Set JANSOU_BASE_URL / JANSOU_ROOM_ID / JANSOU_PLAYER_TOKEN in the environment.", file=sys.stderr)
        return 2
    parsed = urllib.parse.urlparse(base)
    localhost = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    if (parsed.scheme != "https" and not (parsed.scheme == "http" and localhost)) or \
            not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment or \
            (parsed.path not in ("", "/")):
        print("JANSOU_BASE_URL must be an HTTPS origin (HTTP is allowed only for localhost).", file=sys.stderr)
        return 2
    prefix = "/rooms/" + room
    status, digest = request(base, prefix + "/watch-digest?after=0&cheers_after=0", player)
    require(status == 200, f"Player watch-digest returned HTTP {status}")
    check_digest(digest)
    print("OK Player watch-digest: min fields / no private tiles / watermarks")

    latest_seq = digest["latest_seq"]
    status, digest2 = request(base, prefix + f"/watch-digest?after={latest_seq}&cheers_after=0", player)
    require(status == 200, "watch-digest changed status when after=current")
    check_digest(digest2)
    status, body = request(base, prefix + "/watch-digest?after=-1", player)
    require(status == 400, "bad events cursor must return 400")
    status, body = request(base, prefix + "/watch-digest?cheers_after=invalid", player)
    require(status == 400, "bad cheers cursor must return 400")
    status, body = request(base, prefix + "/watch-digest", None)
    require(status == 401, "unauthenticated watch-digest must return 401")
    print("OK watch-digest: cursor validation / unauthenticated denied")

    for role, token in (("Spectator", spectator), ("Master", master)):
        if token:
            status, body = request(base, prefix + "/watch-digest", token)
            require(status == 403, f"{role} must not access watch-digest")
            print(f"OK watch-digest: {role} denied")

    status, body = request(base, prefix + "/hands/latest", None)
    require(status == 401, "unauthenticated hands/latest must return 401")
    seen = []
    for role, token in (("Player", player), ("Spectator", spectator), ("Master", master)):
        if not token:
            continue
        status, data = request(base, prefix + "/hands/latest", token)
        require(status in (200, 404), f"{role} hands/latest unexpected HTTP {status}")
        if status == 404:
            require(data.get("error") == "no_finished_hand", "expected safe no_finished_hand error")
            seen.append((role, status, None))
            print(f"OK {role} hands/latest: no provably finished hand (404)")
        else:
            check_hand(data)
            seen.append((role, status, data))
            print(f"OK {role} hands/latest: finished hand {data['hand_key']} / 4 final hands")
    require(len({code for _, code, _ in seen}) <= 1, "role-dependent finished-hand visibility mismatch")
    results = [data for _, code, data in seen if code == 200]
    if results:
        require(all(x == results[0] for x in results), "hand details should agree for all authorized roles")
    print("PASS: GET-only API contract smoke checks. No game action or deployment performed by this script.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (AssertionError, ValueError, OSError, urllib.error.URLError) as exc:
        # Do not log response bodies, URLs with tokens, or credential strings.
        print(f"FAIL: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
