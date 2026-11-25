# Edge Noise Brush

Five modes for the normal Brush tool. The Edge Noise Brush breaks up straight edges between two tones into pixel steps. Where the brush passes over an edge, the edge is cut into steps using only the colours already on either side. No new colours are added.

- Pick `Edge Noise Brush` from the Brush tool's dropdown. Alt picks a colour, as with the normal brush.
- The steps are either random or follow a preset: a PNG with a bright side and a dark side meeting at the jagged edge you want. Select an area of a texture to save it as a preset. Presets live in their own folder in Blockbench's user data folder.
- A panel on the right shows the selected preset and the selected texture with the brush applied.
- By default only the selected paint colour grows, stepping outward into the neighbouring tone. Turn that off to push edges both ways.
- Going back over a spot without letting go grows the brush colour another step.
- The Highlight Brush and Shadow Brush draw a line of the brush colour along edges, following every step, with breaks and thickness from line presets. Each preset keeps its own thickness, distance from the edge, side and length.
- The Block Grid Brush fills whole block cells, 16, 32 or 64 pixels or the model's own block size, snapped to the model's block grid on each face.
- A Texture Reference panel shows saved areas of your textures zoomed in, to pick colours from with a click while you paint.
- The Noise Brush scatters the brush colour over any surface, densest in the middle of the brush, and fills in further as you scrub over it. Its specks are random or come from a noise preset, shown clump by clump.

[Learn More](https://blockbench-plugins.readthedocs.io/en/latest/edge_noise_brush/about.html)
