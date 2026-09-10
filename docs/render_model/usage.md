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

## Turntable GIF

One full spin around the model, looping.

- `Seconds per spin`: how long one complete rotation takes.
- `Smoothness`: frames per second. The frame count is worked out for you from the duration.
- `Camera height`: the angle the camera looks down from while it spins, in degrees.
- `Play while spinning`: pick any number of animations and they all play together underneath the rotation. This list is independent of the animation GIF section.
- `Match spin to animation length`: sets the spin duration to the longest animation you picked, so the rotation and the animation finish together and the loop is seamless.

## Animation GIFs

One looping GIF per animation, each as long as the animation itself. Frames come from stepping the timeline rather than recording playback, so the timing is exact.

- `Render these`: the base animations. You get one GIF for each, named after it.
- `Render all` / `Render none`: ticks or clears the list above.
- `Layer on top`: animations that play at the same time as every base animation. Idle, blinking, a breathing loop. These never get a GIF of their own.
- `Combine`: `One GIF per animation` gives a file for each base with the overlays on top. `One GIF, everything at once` collapses bases and overlays into a single file.
- `Smoothness`: frames per second for these GIFs, set separately from the turntable.
- `Camera angle`: a fixed camera for all of them.

For example, ticking `swim` and `swim_left` under Render these, with `idle` and a blink under Layer on top, writes `swim.gif` and `swim_left.gif`, each with idle and the blink playing over the top.

## Image size

Everything above is written once per size, so two sizes doubles the output.

- `Size`: 512, 1024, 2048 and 4096. Pick as many as you want.
- `Custom sizes`: anything else, comma separated. A bare number is square, or write `320x180` for a rectangle.
- `Smooth edges`: renders at four times the size and scales down. Leave it off for pixel art. The multiplier drops automatically at large sizes so no single render exceeds 4096.
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
| More than one size | the size is appended, as in `green_turtle_front_1024.png` |

The `animation.` prefix is stripped from animation names, so `animation.green_turtle.swim` becomes `swim`.

## Best practices

- Leave `Smooth edges` off for pixel art. It only softens what should be crisp.
- Render stills at 4096 if you need them, but keep GIFs at 512 or 1024. Large GIFs are impractical files.
- Set a background colour when a GIF needs clean edges or when the player reference should look half transparent.
- Return to edit mode before rendering stills if you do not want a posed model.

## Additional notes

GIF holds 256 colours and on-off transparency with nothing in between, so a half transparent pixel becomes fully solid or fully gone. Setting a background colour bakes the blend in and avoids it.

Animation selections are not remembered between sessions, because Blockbench identifies animations by an id unique to each project. Every other setting in the dialog persists.

Rendering animations switches Blockbench into animate mode, drives the timeline and switches back. Save your work before a long run.
