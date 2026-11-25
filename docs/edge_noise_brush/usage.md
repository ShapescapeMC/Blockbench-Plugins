# Usage

Switch to the Paint tab, pick the Edge Noise Brush from the paint toolbar, and paint over an edge between two tones. Brush size, shape, softness and opacity work as with the normal brush. Softness and opacity blend between the original pixel and the stepped result.

Painting away from any edge does nothing, since there is nothing to break up.

## Settings

Open `Tools -> Edge Noise Brush Settings`. Changes apply from the next stroke and are remembered between sessions.

- `Grow brush colour only`: on by default. Only pixels matching the colour selected in the colour panel spread, stepping out into the tone they border. Turn it off and both sides of every edge push into each other.
- `Colour tolerance`: how close a pixel has to be to the brush colour, per RGB channel out of 255, to count as that colour. Raise it if the colour you are growing has slight variation.
- `Roughness %`: the share of edge segments that move. 0 leaves edges untouched, 100 moves every segment.
- `Max step depth (px)`: the furthest a segment can move. Each moving segment picks a depth from 1 up to this value.
- `Max segment length (px)`: the length of the stretches along the edge that move together. Longer values give broader steps. Segments are sometimes split in two, so shorter steps still appear.
- `Horizontal edges` / `Vertical edges`: which edge directions to break up.
- `Edge threshold`: how different two neighbouring pixels must be in brightness to count as an edge. Raise it to skip soft shading and only affect strong contrasts.
- `Seed`: changes the random pattern. The same seed always gives the same steps on the same texture.

```{note}
Two colours with almost the same brightness may not be seen as an edge. Lower `Edge threshold` if a boundary is being ignored.
```
