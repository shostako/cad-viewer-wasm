"""Generate a colored STEP assembly for Phase 1 testing (run with backend venv).

Creates mini_mold.step: a plate (gray) + 2 core pins (red) + cavity block (blue),
assembled with locations — exercises XCAF colors, assembly tree, curved faces.

Usage: backend/.venv/bin/python testdata/make_step_assembly.py
"""
from pathlib import Path

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.gp import gp_Trsf, gp_Vec
from OCP.IFSelect import IFSelect_RetDone
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFDoc import XCAFDoc_ColorType, XCAFDoc_DocumentTool

OUT = Path(__file__).parent


def named(shape_tool, label, name):
    TDataStd_Name.Set_s(label, TCollection_ExtendedString(name))
    return label


def loc(x, y, z):
    t = gp_Trsf()
    t.SetTranslation(gp_Vec(x, y, z))
    return TopLoc_Location(t)


def main() -> None:
    doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())

    plate = BRepPrimAPI_MakeBox(100, 60, 15).Shape()
    pin = BRepPrimAPI_MakeCylinder(4, 25).Shape()
    cavity = BRepPrimAPI_MakeBox(40, 30, 20).Shape()

    l_plate = named(st, st.AddShape(plate, False), "plate")
    l_pin = named(st, st.AddShape(pin, False), "core_pin")
    l_cavity = named(st, st.AddShape(cavity, False), "cavity_block")

    gray = Quantity_Color(0.6, 0.6, 0.62, Quantity_TOC_RGB)
    red = Quantity_Color(0.8, 0.15, 0.1, Quantity_TOC_RGB)
    blue = Quantity_Color(0.15, 0.3, 0.75, Quantity_TOC_RGB)
    ct.SetColor(l_plate, gray, XCAFDoc_ColorType.XCAFDoc_ColorSurf)
    ct.SetColor(l_pin, red, XCAFDoc_ColorType.XCAFDoc_ColorSurf)
    ct.SetColor(l_cavity, blue, XCAFDoc_ColorType.XCAFDoc_ColorSurf)

    asm = st.NewShape()
    named(st, asm, "mini_mold")
    st.AddComponent(asm, l_plate, loc(0, 0, 0))
    st.AddComponent(asm, l_pin, loc(25, 30, 15))
    st.AddComponent(asm, l_pin, loc(75, 30, 15))
    st.AddComponent(asm, l_cavity, loc(30, 15, 15))
    st.UpdateAssemblies()

    writer = STEPCAFControl_Writer()
    writer.SetColorMode(True)
    writer.SetNameMode(True)
    writer.Transfer(doc, STEPControl_AsIs)
    path = str(OUT / "mini_mold.step")
    assert writer.Write(path) == IFSelect_RetDone
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
