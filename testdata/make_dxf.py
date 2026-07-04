"""Generate a test DXF drawing with known coordinates (run with backend venv).

plate_drawing.dxf: 200x100 rectangle outline + 2 holes (r=10) at (50,50), (150,50)
+ centerline. All in mm.
"""
from pathlib import Path

import ezdxf

OUT = Path(__file__).parent


def main() -> None:
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()

    # outline 200x100
    msp.add_lwpolyline([(0, 0), (200, 0), (200, 100), (0, 100)], close=True)
    # holes
    msp.add_circle((50, 50), radius=10)
    msp.add_circle((150, 50), radius=10)
    # centerline
    msp.add_line((0, 50), (200, 50), dxfattribs={"linetype": "CENTER"})

    path = OUT / "plate_drawing.dxf"
    doc.saveas(path)
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
