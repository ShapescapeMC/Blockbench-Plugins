# Edge Noise Brush

A mode of the normal Brush tool that breaks up straight edges between two tones into pixel steps. Where the brush passes over an edge, the edge is cut into steps using only the colours already on either side. No new colours are added.

- Pick `Edge Noise Brush` from the Brush tool's dropdown. Alt picks a colour, as with the normal brush.
- The steps are either random or follow a preset: a PNG with a bright side and a dark side meeting at the jagged edge you want. Presets live in their own folder in Blockbench's user data folder.
- A panel on the right shows the selected preset and the selected texture with the brush applied.
- By default only the selected paint colour grows, stepping outward into the neighbouring tone. Turn that off to push edges both ways.
- Going over a spot twice in one stroke does not stack.

[Learn More](https://blockbench-plugins.readthedocs.io/en/latest/edge_noise_brush/about.html)
