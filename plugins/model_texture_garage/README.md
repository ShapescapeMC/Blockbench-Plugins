# Model & Texture Garage

Tools for pixel art models built from blocks, in one plugin.

**Texturing**, as modes of the Brush tool's dropdown (Alt picks a colour with all of them):

- **Edge Noise Brush**: breaks straight edges between two tones into pixel steps, using only the colours on either side, randomly or from presets made from your own textures. Can work only along the seams between blocks.
- **Highlight Brush** and **Shadow Brush**: draw lines along edges, following every step, with breaks and thickness from line presets.
- **Noise Brush**: scatters the brush colour over a surface, densest in the middle of the brush, from clump presets or random.
- **Block Grid Brush**: fills whole block cells on the model's block grid, and shows the grid on the model.
- **Texture Reference** panel: saved areas of your textures, zoomed in, to pick colours from with a click.

**Modelling**, in the Edit tab:

- **Block Grid Cube** tool: click a face to add a cube on the block grid, cut one out or mark one hollow, at 4 to 64 units. New cubes are named `ADD`, `CUTOUT` or `HOLLOW`.
- **BlockPatcher**: turns those cubes into real geometry, merges cubes, drops hidden faces and lays out the UV again, in a preview tab where you mark what went wrong and Confirm restores it.
- **Organize UV**: lays out the whole UV again, bone by bone, without changing the model.

Presets can be sorted into folders, each with its own options, and live in their own folder in Blockbench's user data folder.

[Learn More](https://blockbench-plugins.readthedocs.io/en/latest/model_texture_garage/about.html)
