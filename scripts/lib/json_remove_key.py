#!/usr/bin/env python3
"""json_remove_key.py — remove ONE key from a JSON file, leaving every other
byte exactly as it was (v1 gate G6, `myai uninstall`).

    json_remove_key.py <file> <dotted.path.to.key> [--check]

Exit codes: 0 removed (or, with --check, present), 1 not present, 2 the file
is not valid JSON (the file is never touched).

json.load + json.dump would re-format the whole file; another tool's config
must not change except for our own entry. So this scans the text, finds the
member's exact span, and splices it out together with one adjoining comma.
When the parent object is left empty, its inside becomes `{}`.
"""
import json
import sys

WS = " \t\r\n"


class Scanner:
    def __init__(self, text):
        self.t = text
        self.i = 0

    def ws(self):
        while self.i < len(self.t) and self.t[self.i] in WS:
            self.i += 1

    def string(self):
        assert self.t[self.i] == '"'
        start = self.i
        self.i += 1
        while True:
            c = self.t[self.i]
            if c == "\\":
                self.i += 2
                continue
            self.i += 1
            if c == '"':
                return json.loads(self.t[start:self.i])

    def value(self):
        """Skip one value; returns (start, end) of its text."""
        self.ws()
        start = self.i
        c = self.t[self.i]
        if c == '"':
            self.string()
        elif c == "{":
            self.object_members()
        elif c == "[":
            self.i += 1
            self.ws()
            if self.t[self.i] == "]":
                self.i += 1
            else:
                while True:
                    self.value()
                    self.ws()
                    if self.t[self.i] == ",":
                        self.i += 1
                        continue
                    self.i += 1  # ]
                    break
        else:
            while self.i < len(self.t) and self.t[self.i] not in ",]} \t\r\n":
                self.i += 1
        return start, self.i

    def object_members(self):
        """Scan an object at self.i; returns (open, close, members) where
        members = [(key, key_start, value_start, value_end)]."""
        open_at = self.i
        self.i += 1
        members = []
        self.ws()
        if self.t[self.i] == "}":
            self.i += 1
            return open_at, self.i - 1, members
        while True:
            self.ws()
            key_start = self.i
            key = self.string()
            self.ws()
            self.i += 1  # :
            vs, ve = self.value()
            members.append((key, key_start, vs, ve))
            self.ws()
            if self.t[self.i] == ",":
                self.i += 1
                continue
            self.i += 1  # }
            return open_at, self.i - 1, members


def find_object(text, path_keys):
    """Locate the object that holds the last key; returns (open, close, members)."""
    s = Scanner(text)
    s.ws()
    if s.t[s.i] != "{":
        return None
    obj = s.object_members()
    for k in path_keys[:-1]:
        hit = [m for m in obj[2] if m[0] == k]
        if not hit or text[hit[0][2]] != "{":
            return None
        s.i = hit[0][2]
        obj = s.object_members()
    return obj


def remove_key(text, dotted):
    keys = dotted.split(".")
    obj = find_object(text, keys)
    if obj is None:
        return None
    open_at, close_at, members = obj
    idx = [n for n, m in enumerate(members) if m[0] == keys[-1]]
    if not idx:
        return None
    n = idx[0]
    if len(members) == 1:
        return text[: open_at + 1] + text[close_at:]  # → {}
    if n < len(members) - 1:  # cut from this key to the next key
        return text[: members[n][1]] + text[members[n + 1][1]:]
    # last member: cut from the end of the previous value
    return text[: members[n - 1][3]] + text[members[n][3]:]


def main(argv):
    if len(argv) < 3:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    path, dotted, check = argv[1], argv[2], "--check" in argv[3:]
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
        json.loads(text)
    except (OSError, ValueError):
        return 2
    new = remove_key(text, dotted)
    if new is None:
        return 1
    if check:
        return 0
    json.loads(new)  # never write something that is not JSON
    with open(path, "w", encoding="utf-8") as f:
        f.write(new)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
