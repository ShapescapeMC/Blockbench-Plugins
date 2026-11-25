# Usage

Switch to the Paint tab, click the small arrow on the Brush tool and pick `Edge Noise Brush`. Paint over an edge between two tones. Brush size, shape, softness and opacity work as with the normal brush, and softness and opacity blend between the original pixel and the stepped result.

Hold Alt to pick a colour from the texture, as with the normal brush.

`Grows`, at the top of the panel, decides which tone grows into its neighbour:

- `Brush colour`: the default. Only the brush colour grows, so pick it first, with Alt or from the colour panel.
- `Colour where the stroke starts`: whatever tone is under the brush when you start the stroke grows, whatever the brush colour. Start inside the tone you want to grow.
- `Both tones`: both sides push into each other.

Painting away from any edge does nothing, since there is nothing to break up.

Going back over a spot without letting go grows the brush colour another step each time, so scrubbing back and forth over an edge pushes it further. Each return also varies the steps, so the edge keeps breaking up rather than just getting thicker. A new stroke starts from what is on the texture again. `Max extra growth per stroke` in the settings caps how far one stroke can go, and `Grow on repeated passes` turns it off.

The direction you paint in picks which edges change: paint up or down along a vertical edge and only vertical edges break up, paint sideways along a horizontal edge and only horizontal edges do. That keeps a stroke along one edge from also roughening a corner it passes. Turn `Follow stroke direction` off in the settings to always break up both.

To go back to the normal brush, pick any other entry from the Brush tool's dropdown, such as `Pixel Brush`.

## The panel

While the Edge Noise Brush is active, its panel shows on the right in the Paint tab.

- The list at the top holds `Random steps` and every preset. Click one to use it.
- Below the list is the selected preset at full size, or a sample edge for random steps.
- At the bottom is the selected texture as it would look if you painted over all of it with the current preset, settings and colour. Use it to judge a preset before painting.

The buttons along the top add presets from PNG files, save a preset from the texture, make a new folder for presets, open the preset folder, reload the presets, and open the brush settings. Hover over a preset to delete it.

## Presets

A preset is a PNG with a bright side and a dark side that meet at the jagged edge you want.

The quickest way to make one is from a texture you already have. Use the selection tool in the UV editor to draw a box around an edge you like, then click the selection button in the panel. Only the selected area is saved. With nothing selected, the whole texture is saved.

You can also draw one from scratch, the way the finished edge should look:

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
- Leave a few rows of plain bright and plain dark on either side of the edge. Stray specks away from the edge are ignored: the edge is where the largest bright area meets the largest dark area.

The brush repeats the edge's shape along every edge you paint over, horizontal and vertical. With `Grow brush colour only` on, the edge is shifted so the colour you paint with only ever grows. When the brush colour is the brighter tone, the bright side of the preset grows into the dark one, and the other way round. With it off, both tones move, and the straight edge sits at the preset's middle line.

Presets are stored as PNG files in the `edge_noise_presets` folder in Blockbench's user data folder, with one folder per brush: `edges`, `highlights`, `shadows` and `noise`. Click the folder button in the panel to open the active brush's folder. You can copy PNGs straight into it and click reload. Edge presets from older versions, which sat loose in `edge_noise_presets`, are moved into `edges` automatically.

### Preset folders

Each brush's presets can be sorted into folders, such as `stone` and `wood` inside `shadows`, and folders inside those, up to four deep. In the panel, presets without a folder come first, then each folder as a group you can click to fold away.

- When you save a preset from the texture, a dialog asks for its name and its folder: an existing one, no folder, or `New folder…` with a name such as `stone` or `stone/rough`. The folder you used last is picked by default.
- Adding PNGs asks for the folder the same way.
- The new folder button in the panel makes an empty folder to fill later.
- You can also make and fill folders straight in the file browser and click reload.

Presets are remembered by their folder and name, so moving a preset to another folder makes it a new preset with default options.

### Preset options

Each preset keeps its own options, shown in the panel under the list when it is selected:

- `Depth`: scales how far the steps reach. At ×2 every step is twice as deep.
- `Length`: stretches the pattern along the edge. At ×2 every pixel of the preset covers two pixels of the edge.

## Settings

Open `Tools -> Edge Noise Brush Settings`, or the settings button in the panel. Changes apply from the next stroke and are remembered between sessions.

- `Grows`: the same choice as at the top of the panel.
- `Grow on repeated passes`: on by default. Going back over a spot in the same stroke grows it another step.
- `Max extra growth per stroke`: how many extra steps one stroke can add by going back over a spot.
- `Colour tolerance`: how close a pixel has to be to the brush colour, per RGB channel out of 255, to count as that colour. It never goes past `Edge threshold`, so a close shade still counts as a different tone the brush can grow into.
- `Roughness %`, `Max step depth (px)`, `Max segment length (px)`: shape the random steps. They are ignored when a preset is selected.
- `Horizontal edges` / `Vertical edges`: which edge directions to break up.
- `Follow stroke direction`: on by default. Once a stroke has moved a few pixels, a stroke going mostly up or down only breaks up vertical edges, with the pattern turned to run along them, and a stroke going mostly sideways only breaks up horizontal edges. A single click, or the start of a stroke, breaks up both. The edge toggles above still apply, so with `Vertical edges` off an upward stroke does nothing.
- `Edge threshold`: how different two neighbouring pixels must be to count as an edge, as the largest difference in any of red, green and blue, out of 255. The default of 2 catches very close shades. Raise it to skip soft shading and only affect strong contrasts.
- `Seed`: changes the random pattern. With a preset, it shifts where the pattern starts along the edge.

```{note}
If the brush does nothing on an edge, check `Grows`: with `Brush colour`, the brush colour has to be one of the two tones. Two shades closer than `Edge threshold` are also seen as one tone; lower it if a boundary is being ignored.
```

## Noise Brush

The Noise Brush is a second mode in the Brush tool's dropdown, for surfaces rather than edges. It scatters the brush colour as single pixels or small clumps, densest in the middle of the brush and thinning out towards its edge. Use a big brush to start texture on a flat area, then scrub back and forth over the spots you want fuller. Each time the brush comes back over a spot without letting go, more of it fills in. A new stroke starts afresh.

It only ever places the brush colour, at the brush opacity. Hold Alt to pick the colour. While it is active, the Brush icon turns into a dotted circle and the panel on the right shows its presets and settings:

- `Density`: how full the middle of the brush gets on the first pass.
- `Falloff`: how much thinner the noise gets towards the edge of the brush. At 0 it is even across the whole brush.
- `Grain`: the size of the clumps of `Random noise` in pixels. 1 gives single pixels.
- `Seed`: changes the pattern.

The panel shows what one pass and three passes over the same spot look like in the current brush colour. Brush softness also thins out the edge of the brush, on top of `Falloff`.

### Noise presets

A noise preset is a PNG of the specks and clumps you want, drawn over a plain background. The noise is whichever tone there is less of, or everything that is not transparent on a transparent background. As with the other presets, the quickest way is to draw it on a texture, select it with the selection tool and click the selection button in the panel while the Noise Brush is active.

The preset is repeated across the texture, and the brush shows it clump by clump: pixels that touch side by side form one clump, and each clump appears whole or not at all, so the shapes you drew are never broken up. `Density` and `Falloff` decide how many clumps show, and at full density in the middle of the brush the whole pattern shows. Nothing outside the drawn clumps is ever painted.

Each noise preset has its own options:

- `Scale`: draws every pixel of the preset this many pixels wide and tall.
- `Shuffle`: on by default. Starts each repeat of the preset at a random point and mirrors some, so the repeat does not show as a grid.

## Highlight Brush and Shadow Brush

The Highlight Brush and the Shadow Brush are two more modes in the Brush tool's dropdown. They draw a line of the brush colour along the edges you brush over, following the edge's outline, steps and all. Break an edge up with the Edge Noise Brush first, then brush over it with these to add a highlight or a shadow that follows every step.

They work the same way and only differ in their starting options: highlights sit on the brighter side of the edge, shadows on the darker side. Pick the highlight or shadow colour as the brush colour, or hold Alt to pick it from the texture. Brush opacity applies. Going back over a spot in the same stroke does not thicken the line, so you can brush over it freely.

Without a preset, the line is a plain unbroken line, one pixel thick. A preset decides where the line breaks and how thick it gets.

### Line presets

A line preset is a PNG of a line drawn over a plain background, the way the finished highlight or shadow should look if the edge were straight:

```
................
.####..###.#####
.##.....#...##..
................
```

- Draw the line with the gaps and changes in thickness you want. The top row of the line is the row against the edge, and thicker parts grow away from it.
- The line can be drawn running across or up and down.
- The line is whichever tone there is less of, so a light line on a dark background and a dark line on a light background both work. On a transparent background, the line is everything that is not transparent.
- The width of the image is the length of the pattern before it repeats.

As with edge presets, the quickest way is to draw the line on a texture, select it with the selection tool and click the selection button in the panel. It is saved to the brush you have active.

### Line options

Each line preset, and the plain line, keeps its own options in the panel:

- `Thickness`: scales how thick the line is drawn. At ×2 every pixel of the preset is two pixels deep. Use it to keep shadows heavier than highlights.
- `Distance`: how many pixels between the edge and the line. At 0 the line touches the edge.
- `Side`: whether the line sits on the brighter or the darker side of the edge.
- `Flip`: puts the bottom of the preset against the edge instead of the top.
- `Length`: stretches the pattern along the edge.

Lines drawn earlier are taken into account. A highlight counts as part of the brighter side of its edge and a shadow as part of the darker side, so a shadow brushed over a highlight lands right under it rather than around it, and brushing over a line again leaves it as it is. This works for lines up to 8 pixels thick that are brighter or darker than both tones they sit between.

The `Horizontal edges`, `Vertical edges` and `Edge threshold` settings apply to these brushes too. `Follow stroke direction` does not: the line always follows both the flat runs and the steps of an edge, so it stays joined up.

## Texture Reference panel

The Texture Reference panel is a second, zoomed view of your texture to pick colours from while you paint. It shows in the Paint tab whichever brush you use, and like any panel it can be moved, docked on either side, or floated.

- `Whole texture` shows the selected texture.
- To save a part of a texture as a reference, select it with the selection tool in the UV editor and click the add button in the panel. With nothing selected, the whole texture is saved. References are listed along the top of the panel; click one to show it.
- Click a pixel to pick its colour as the brush colour, and right-click to pick it as the secondary colour. Transparent pixels are skipped.
- Scroll to zoom in and out around the cursor, drag to move around, and double-click or use the fit button to go back to the saved area. The saved area is outlined so you can find it again, and a pixel grid shows when zoomed in far.
- The line at the bottom shows the position and colour of the pixel under the cursor.
- The view updates after every stroke, so it always shows the texture as it is now.

References are remembered between sessions. A reference keeps working while its texture is open in a project; otherwise the panel says so.

## Block Grid Brush

The Block Grid Brush is another mode in the Brush tool's dropdown. It fills whole block cells with the brush colour, snapped to the model's block grid, for blocking out colour per block on models built from whole blocks.

Paint on the model in the viewport. On each cube face the brush works out where the model's block edges fall, every 16 units, and lines the cells up with them, whatever the face's position on the texture. A face that starts halfway into a block gets a half cell first. On formats with a centred grid, such as Bedrock entities, block edges sit at ±8 on the x and z axes, and the brush follows that. Paint stays inside the face you are painting.

The panel has two settings:

- `Block size`: how big one cell is in texture pixels: 8, 16, 32, 64 or 128. `Auto` uses the size of one block on the face you are painting, from its UV, so it matches the model exactly even if faces differ in texture density.
- `Snap to model`: on by default. Turn it off, or paint in the UV editor, and the cells start at the top left corner of the texture instead.
- `Show grid`: on by default. While the Block Grid Brush is active and the Brush tool is selected, the cells are drawn on the model in red, on every cube face, exactly where the brush will fill them. They follow `Block size`, update as you edit the model, and disappear when you pick another tool or brush. With `Snap to model` off there is no grid on the model, since the cells then follow the texture rather than the blocks.

Brush size decides how many cells one dab covers: at size 1 it fills the cell under the cursor. Brush opacity applies once per cell in each stroke, so going over a cell again in the same stroke does not darken it further. Hold Alt to pick a colour, as with the normal brush.

```{note}
Cells line up with the model on faces with their UV turned by 0 or 180 degrees. On faces turned by 90 or 270 degrees, the cells start at the face's corner on the texture instead.
```
