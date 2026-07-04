"""Generate test models (run with backend venv python).

Usage: backend/.venv/bin/python testdata/make_testdata.py
"""
from pathlib import Path

import trimesh
from trimesh.transformations import translation_matrix as T

OUT = Path(__file__).parent


def ribbed_plate() -> trimesh.Trimesh:
    """80x50x2 plate + 3 ribs (1.2t x 8h) + 2 bosses — injection-molding-ish."""
    parts = [trimesh.creation.box(extents=(80, 50, 2), transform=T((0, 0, 1)))]
    for x in (-25, 0, 25):
        parts.append(trimesh.creation.box(extents=(1.2, 46, 8), transform=T((x, 0, 6))))
    for x in (-30, 30):
        parts.append(trimesh.creation.cylinder(radius=3, height=10, transform=T((x, 18, 7))))
    return trimesh.util.concatenate(parts)


if __name__ == "__main__":
    mesh = ribbed_plate()
    path = OUT / "ribbed_plate.stl"
    mesh.export(path)
    print(f"wrote {path} ({len(mesh.faces)} tris)")
