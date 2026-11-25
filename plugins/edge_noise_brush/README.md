# Edge Noise Brush

A paint tool that breaks up straight edges between two tones into pixel steps. Where the brush passes over an edge, the edge is cut into segments of random length and segments are pushed in or out by a pixel or more, using only the colours already on either side. No new colours are added.

- By default only the selected paint colour grows, stepping outward into the neighbouring tone. Turn that off to push edges both ways.
- The result is worked out from a snapshot taken when the stroke starts and is the same for every pixel each time, so going over a spot twice in one stroke does not stack.
- Settings live under `Tools -> Edge Noise Brush Settings` and are remembered between sessions.

[Learn More](https://blockbench-plugins.readthedocs.io/en/latest/edge_noise_brush/about.html)
