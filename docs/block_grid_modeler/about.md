# Block Grid Modeler
This plugin adds a tool for building models out of whole blocks. Point at a face of the model and click: in Add mode a new cube is placed against that face, and in Cut out mode a cube is placed just inside it, slightly inflated, to mark the part to cut away.

New cubes always sit on the model's block grid, at the size picked in the tool bar, so the model keeps clean block steps. They are named in capitals after what they do, `ADD` or `CUTOUT`, so a build script that remaps UVs, cuts out or hollows cubes, or merges them can tell them apart from the rest of the model.
