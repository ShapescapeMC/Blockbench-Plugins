# Usage

Open the model you want to render, then go to `View -> Render Model...`.

Everything is set in one dialog. The line at the bottom always states what the current settings will produce, so read it before pressing confirm.

## Still images

One PNG per angle you tick.

- `Four sides`: front, back, left and right, straight on and orthographic. Front is derived from the model format's forward direction, so it is the creature's front rather than a fixed world axis.
- `Top and bottom`: directly above and directly below.
- `Isometric corners`: the four diagonal views, tilted down at the true isometric angle. This is the game icon look.
- `Current view`: copies whatever your viewport shows, including a perspective camera. Frame the shot before opening the dialog.
- `Views around model`: a numbered ring of stills. Eight gives one every 45 degrees. Enable it with the checkbox at the end of the row.
- `Camera height`: how far above the model that ring sits, in degrees. Zero is level with it, 90 is directly overhead, negative looks up from below.
- `Export as`: `Separate images` writes one PNG per view, as above. `Sheets` groups the views into sheets instead, and `Both` writes the separate images and the sheets. Views around the model and the current view are always separate images.
- `Sheet layout`: shown when both `Four sides` and `Top and bottom` are ticked. `Sides, top/bottom apart` writes two sheets, and `All six together` writes one.

### Sheets

A sheet is one PNG with several views on it, each with its name above. Every tile is the size you picked, so a 512 sheet keeps each view at 512, and every tile shares the run's scale, so the model is the same size in all of them. Four views always sit two over two.

```
Isometric            Sides              Top and bottom
┌──────┬──────┐     ┌──────┬──────┐     ┌──────┬──────┐
│F left│F rght│     │Front │Right │     │ Top  │Bottom│
├──────┼──────┤     ├──────┼──────┤     └──────┴──────┘
│B left│B rght│     │ Back │ Left │
└──────┴──────┘     └──────┴──────┘

All six together
┌──────┬──────┬──────┐
│Front │Right │ Top  │
├──────┼──────┼──────┤
│ Back │ Left │Bottom│
└──────┴──────┴──────┘
```

The sides read as one rotation, front, right, back, left.

## Turntable GIF

One full spin around the model, looping.

- `Seconds per spin`: how long one complete rotation takes.
- `Smoothness`: frames per second. The frame count is worked out for you from the duration.
- `Camera height`: the angle the camera looks down from while it spins, in degrees.
- `Play while spinning`: pick any number of animations and they all play together underneath the rotation. This list is independent of the animation GIF section.
- `Match spin to animation length`: sets the spin duration to the longest animation you picked, so the rotation and the animation finish together and the loop is seamless.

## Animation GIFs

One looping GIF per animation, each as long as the animation itself. Frames come from stepping the timeline rather than recording playback, so the timing is exact.

Only animations loaded into the open project can be rendered. If the model's animation file has not been imported, this section says so instead of showing any options. Import the file in Blockbench, or load it with the System Template File Loader, and open the dialog again.

- `Render these`: the base animations. You get one GIF for each, named after it.
- `Render all` / `Render none`: ticks or clears the list above.
- `Layer on top`: animations that play at the same time as every base animation. Idle, blinking, a breathing loop. These never get a GIF of their own.
- `Export as`: `Separate GIFs` gives a file for each base with the overlays on top. `One GIF, played together` plays the bases and overlays at the same time on the one model, in a single file. `One sheet, side by side` puts every base animation next to each other in a single GIF, each named above, and `Separate GIFs and a sheet` writes both. A sentence under the dropdown describes exactly what the current choice will make, using the animations you ticked.
- `Smoothness`: frames per second for these GIFs, set separately from the turntable.
- `Camera angle`: a fixed camera for all of them.
- `Endless animation length`: how many seconds to record an animation that has no length of its own. It only appears when the project has one.

### Animations driven by Molang

An animation built from Molang expressions rather than keyframes has no length. The motion comes from maths evaluated against the timeline, so it runs forever, and Blockbench stores its length as zero.

There is no length to read, so the plugin records these for `Endless animation length` seconds, three by default. The line under `Export as` names any animation this applies to. If a group mixes an endless animation with a keyframed one, the keyframed length wins and the endless one simply keeps playing underneath.

The same length applies to endless animations picked under `Play while spinning` in the turntable section.

For example, ticking `swim` and `swim_left` under Render these, with `idle` and a blink under Layer on top, writes `swim.gif` and `swim_left.gif`, each with idle and the blink playing over the top.

### Animation sheet

The sheet uses the most compact grid for the number of animations: up to three in a row, four as two over two, then close to square, with a short last row centred. Overlays play in every tile.

The sheet runs as long as its longest animation, and shorter ones loop inside it. A short animation can jump back to its start when the GIF restarts. Choosing `Separate GIFs and a sheet` renders everything in one pass, and each animation's own GIF still stops at its own length.

## Image size

Everything above is written once per size, so two sizes doubles the output.

- `Size`: 512, 1024, 2048 and 4096. Pick as many as you want.
- `Custom sizes`: anything else, comma separated. A bare number is square, or write `320x180` for a rectangle.
- `Smooth edges`: renders at four times the size and scales down. Leave it off for pixel art. The multiplier drops automatically at large sizes so no single render exceeds 4096.
- `Sheet labels`: shown when any sheet is being made. The name above each tile, dark text on a light band. Untick it for sheets without names.
- `Shading`: Blockbench's per-face brightness. Off gives flat texture colours.
- `Player for scale`: a half transparent, player-proportioned figure standing to one side, feet level with the model's lowest point.
- `Background`: off means transparent. A solid colour also gives GIFs cleaner edges.

## Framing

- `Fit to frame`: on by default. The model is measured across every angle and every pose in the run, and one scale that contains all of it is used for everything.
- `Padding %`: the margin left around the model.
- `Frame height`: shown when fitting is off. A fixed frame height in model units, where 16 units is one block. Use it when relative size between different models matters more than filling the frame.

```{note}
Blockbench derives its orthographic zoom from the render size, so a fixed zoom frames a model differently at 512 than at 4096. Measuring per angle instead would make the model appear to change size between the front view and the side view. One shared scale avoids both.
```

## Output

- `Save into`: the parent folder.
- `File prefix`: the name every file starts with. It defaults to the project name.

Each run creates its own folder inside the parent, named after the prefix. A second run of the same model becomes `green_turtle_1`, then `green_turtle_2`. An existing folder is never written into.

| What you ticked | Files |
| --- | --- |
| Four sides | `green_turtle_front.png`, and `_back`, `_left`, `_right` |
| Top and bottom | `green_turtle_top.png`, `green_turtle_bottom.png` |
| Isometric corners | `green_turtle_iso_front_right.png`, and the other three corners |
| Current view | `green_turtle_view.png` |
| Views around model, 8 | `green_turtle_turn_0.png` through `turn_7` |
| Turntable GIF | `green_turtle_turntable.gif` |
| Animation GIF | `green_turtle_swim.gif`, one per base animation |
| Everything at once | `green_turtle_animations.gif` |
| Isometric sheet | `green_turtle_sheet_isometric.png` |
| Sides sheet | `green_turtle_sheet_sides.png` |
| Top and bottom sheet | `green_turtle_sheet_top_bottom.png` |
| All six together | `green_turtle_sheet_all_views.png` |
| Animation sheet | `green_turtle_sheet_animations.gif` |
| More than one size | the size is appended, as in `green_turtle_front_1024.png` |

The `animation.` prefix is stripped from animation names, so `animation.green_turtle.swim` becomes `swim`.

## Best practices

- Leave `Smooth edges` off for pixel art. It only softens what should be crisp.
- Render stills at 4096 if you need them, but keep GIFs at 512 or 1024. Large GIFs are impractical files.
- Keep animation sheets small. Nine animations at 2048 per tile make a GIF over 6000 pixels wide, and the summary line warns you once a sheet passes 4096.
- Set a background colour when a GIF needs clean edges or when the player reference should look half transparent.
- Return to edit mode before rendering stills if you do not want a posed model.

## Additional notes

GIF holds 256 colours and on-off transparency with nothing in between, so a half transparent pixel becomes fully solid or fully gone. Setting a background colour bakes the blend in and avoids it.

Sheets are never shrunk to fit. The one exception is a sheet too large for Blockbench to draw at all, which only happens with many animations at 4096. The summary line says so in bold and the run stops before writing anything.

Animation selections are not remembered between sessions, because Blockbench identifies animations by an id unique to each project. Every other setting in the dialog persists.

Rendering animations switches Blockbench into animate mode, drives the timeline and switches back. Save your work before a long run.
