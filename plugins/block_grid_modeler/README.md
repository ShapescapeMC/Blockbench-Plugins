# Block Grid Modeler

A modelling tool for models built from whole blocks. Point at a face of the model and click to add a cube against it, or to cut one out of it, always snapped to the model's block grid.

- Add mode places a cube just outside the face you click. Cut out mode places one just inside it, inflated by 0.025 so it marks the part to remove.
- Cube size is picked in the tool bar: 4, 8, 16 (one block), 32 or 64 units.
- New cubes are named in capitals after what they do, `ADD` or `CUTOUT`, so a build script can find them. The names can be changed in the settings.
- A wire box shows where the next cube will go before you click.

[Learn More](https://blockbench-plugins.readthedocs.io/en/latest/block_grid_modeler/about.html)
