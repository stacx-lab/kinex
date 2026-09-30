#!/usr/bin/env python3
"""Generate a printable calibration target (ChArUco or checkerboard) as a PNG.

Print at 100% scale on rigid backing, then MEASURE one printed square with a
ruler — the measured size is what every calibration command must use.

Output: one JSON object on stdout ({"ok": true, "path": ..., ...}).
"""

import argparse
import json
import sys


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="board.png")
    parser.add_argument("--board", choices=["charuco", "checkerboard"], default="charuco")
    parser.add_argument("--squares-x", type=int, default=7)
    parser.add_argument("--squares-y", type=int, default=5)
    parser.add_argument("--square-mm", type=float, default=30.0)
    parser.add_argument("--marker-mm", type=float, default=22.0, help="charuco marker side (must be < square)")
    parser.add_argument("--dict", dest="dictionary", default="DICT_4X4_50")
    parser.add_argument("--dpi", type=int, default=300)
    args = parser.parse_args()

    try:
        import cv2
        import numpy as np
    except ImportError:
        fail('missing deps — python3 -m pip install "opencv-python>=4.7" numpy')

    px_per_mm = args.dpi / 25.4
    width_px = int(args.squares_x * args.square_mm * px_per_mm)
    height_px = int(args.squares_y * args.square_mm * px_per_mm)

    if args.board == "charuco":
        if args.marker_mm >= args.square_mm:
            fail("--marker-mm must be smaller than --square-mm")
        try:
            dictionary = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, args.dictionary))
        except AttributeError:
            fail(f"unknown aruco dictionary {args.dictionary}")
        board = cv2.aruco.CharucoBoard(
            (args.squares_x, args.squares_y), args.square_mm / 1000.0, args.marker_mm / 1000.0, dictionary
        )
        image = board.generateImage((width_px, height_px), marginSize=int(px_per_mm * 10))
    else:
        image = np.full((height_px, width_px), 255, dtype=np.uint8)
        square_px = int(args.square_mm * px_per_mm)
        for row in range(args.squares_y):
            for col in range(args.squares_x):
                if (row + col) % 2 == 0:
                    image[row * square_px : (row + 1) * square_px, col * square_px : (col + 1) * square_px] = 0

    if not cv2.imwrite(args.out, image):
        fail(f"could not write {args.out}")
    print(
        json.dumps(
            {
                "ok": True,
                "path": args.out,
                "board": args.board,
                "squares": [args.squares_x, args.squares_y],
                "square_mm_nominal": args.square_mm,
                "note": "print at 100% and MEASURE a printed square; use the measured size downstream",
            }
        )
    )


if __name__ == "__main__":
    main()
