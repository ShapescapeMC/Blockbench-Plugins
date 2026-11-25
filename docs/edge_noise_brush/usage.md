# Usage

Switch to the Paint tab, click the small arrow on the Brush tool and pick `Edge Noise Brush`. Paint over an edge between two tones. Brush size, shape, softness and opacity work as with the normal brush, and softness and opacity blend between the original pixel and the stepped result.

Hold Alt to pick a colour from the texture, as with the normal brush. With `Grow brush colour only` on, that is the colour that grows.

Painting away from any edge does nothing, since there is nothing to break up.

The direction you paint in picks which edges change: paint up or down along a vertical edge and only vertical edges break up, paint sideways along a horizontal edge and only horizontal edges do. That keeps a stroke along one edge from also roughening a corner it passes. Turn `Follow stroke direction` off in the settings to always break up both.

To go back to the normal brush, pick any other entry from the Brush tool's dropdown, such as `Pixel Brush`.

## The panel

While the Edge Noise Brush is active, its panel shows on the right in the Paint tab.

- The list at the top holds `Random steps` and every preset. Click one to use it.
- Below the list is the selected preset at full size, or a sample edge for random steps.
- At the bottom is the selected texture as it would look if you painted over all of it with the current preset, settings and colour. Use it to judge a preset before painting.

The buttons along the top add presets from PNG files, save the selected texture as a preset, open the preset folder, reload the presets, and open the brush settings. Hover over a preset to delete it.

## Presets

A preset is a PNG with a bright side and a dark side that meet at the jagged edge you want. Draw it the way the finished edge should look:

```
################
######..########
##..#....###..##
.......#........
................
```

- The edge can run across or up and down, and either side can be the bright one. The brush works that out.
- Two flat colours are clearest, but any two tones work: the pixels are split into the brighter and darker half. Transparent pixels count as the dark side.
- The width of the image is the length of the repeating pattern. Make it as long as the stretch you want before it repeats.
- Leave a few rows of plain bright and plain dark on either side of the edge.

The brush repeats the edge's shape along every edge you paint over, horizontal and vertical. With `Grow brush colour only` on, the edge is shifted so the colour you paint with only ever grows. When the brush colour is the brighter tone, the bright side of the preset grows into the dark one, and the other way round. With it off, both tones move, and the straight edge sits at the preset's middle line.

Presets are stored as PNG files in the `edge_noise_presets` folder in Blockbench's user data folder. Click the folder button in the panel to open it. You can copy PNGs straight into the folder and click reload.

## Settings

Open `Tools -> Edge Noise Brush Settings`, or the settings button in the panel. Changes apply from the next stroke and are remembered between sessions.

- `Grow brush colour only`: on by default. Only pixels matching the brush colour spread into the tone they border. Turn it off and both sides of every edge push into each other.
- `Colour tolerance`: how close a pixel has to be to the brush colour, per RGB channel out of 255, to count as that colour.
- `Roughness %`, `Max step depth (px)`, `Max segment length (px)`: shape the random steps. They are ignored when a preset is selected.
- `Horizontal edges` / `Vertical edges`: which edge directions to break up.
- `Follow stroke direction`: on by default. Once a stroke has moved a few pixels, a stroke going mostly up or down only breaks up vertical edges, with the pattern turned to run along them, and a stroke going mostly sideways only breaks up horizontal edges. A single click, or the start of a stroke, breaks up both. The edge toggles above still apply, so with `Vertical edges` off an upward stroke does nothing.
- `Edge threshold`: how different two neighbouring pixels must be in brightness to count as an edge. Raise it to skip soft shading and only affect strong contrasts.
- `Seed`: changes the random pattern. With a preset, it shifts where the pattern starts along the edge.

```{note}
Two colours with almost the same brightness may not be seen as an edge. Lower `Edge threshold` if a boundary is being ignored.
```
