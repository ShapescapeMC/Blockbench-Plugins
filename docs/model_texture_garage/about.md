# Model & Texture Garage
This plugin gathers tools for pixel art models built from blocks: brushes for edges, highlights, shadows, noise and block cells, a reference panel to pick colours from, a tool to add and cut out cubes on the block grid, and BlockPatcher to turn those into real geometry.

## Texturing

The brushes are modes of Blockbench's own Brush tool, picked from its dropdown, so Alt picks a colour with all of them as with the normal brush.

- **Edge Noise Brush** breaks up straight edges between two tones into pixel steps, using only the colours already on either side. The steps are random or follow presets you make from areas of your own textures. It can also work only along the seams between blocks.
- **Highlight Brush** and **Shadow Brush** draw a line of the brush colour along the edges you brush over, following every step, with breaks and thickness from line presets. Break an edge up first, then brush over it to add a highlight or a shadow.
- **Noise Brush** scatters the brush colour over a surface, densest in the middle of the brush, from presets of clumps you draw or as random noise.
- **Block Grid Brush** fills whole block cells, snapped to the model's block grid on each face, and can show that grid on the model.

Every preset keeps its own options, such as thickness, depth or scale, and presets can be sorted into folders. The **Texture Reference** panel shows saved areas of your textures zoomed in, to pick colours from with a click.

## Modelling

The **Block Grid Cube** tool adds a cube against the face you click, or cuts one out of it, always on the model's block grid at 4 to 64 units. New cubes are named in capitals after what they do, `ADD`, `CUTOUT` or `HOLLOW`.

**BlockPatcher** applies those cubes: it carves the cut-outs, joins the added cubes to the model, makes hollows see-through, merges cubes, drops faces nobody can see and lays out the UV again. The result opens in a preview tab, where you can mark parts that went wrong and restore them before confirming.
