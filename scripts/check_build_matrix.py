#!/usr/bin/env python3
"""Sanity-check build.yaml before CI spends time compiling."""

import pathlib
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]

# Shields provided by upstream ZMK or by the zmk-dongle-display module.
EXTERNAL_SHIELDS = {
    "settings_reset",
    "dongle_display",
    "lily58_left",
    "lily58_right",
}


def main() -> int:
    matrix = yaml.safe_load((ROOT / "build.yaml").read_text())["include"]
    local_shields = {p.name for p in (ROOT / "boards" / "shields").iterdir() if p.is_dir()}

    errors = []
    artifact_names = {}

    for entry in matrix:
        board = entry.get("board", "")
        shields = entry.get("shield", "").split()
        for shield in shields:
            if shield not in local_shields and shield not in EXTERNAL_SHIELDS:
                errors.append(f"{board}: unknown shield {shield!r}")

        # ZMK names the artifact after artifact-name, or after shield and board.
        name = entry.get("artifact-name") or f"{'-'.join(shields)}-{board}"
        artifact_names[name] = artifact_names.get(name, 0) + 1

    for name, count in artifact_names.items():
        if count > 1:
            errors.append(f"duplicate artifact {name!r} used by {count} builds")

    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1

    print(f"build.yaml OK: {len(matrix)} builds, {len(local_shields)} local shields")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
