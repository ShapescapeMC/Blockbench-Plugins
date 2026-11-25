# Usage

Pick the `Block Grid Cube` tool in the Edit tab and move the mouse over the model. A wire box shows where the next cube will go: green in Add mode, red in Cut out mode. Click to place it. Each click is one undo step.

## Modes

- `Add`: the new cube goes just outside the face you point at, as if you were stacking a block onto it.
- `Cut out`: the new cube goes just inside the face you point at, filling the cell behind it, and is inflated by 0.025 so it sits slightly proud of the cubes it cuts into. It marks a part to remove; the cut itself is left to your build script.

## Cube size

`Cube size` sets how big the new cube is, in model units: 4, 8, 16 (one block), 32 or 64. Cubes snap to a grid of that size laid over the model's block grid, so a 16 cube always fills exactly one block, a 32 cube two blocks on each side, and an 8 cube a quarter of a block's face. On formats with a centred grid, such as Bedrock entities, blocks span -8 to 8 on the x and z axes, and the grid follows that.

## The new cubes

- They are named in capitals after what they do: `ADD` for added cubes and `CUTOUT` for cut-out cubes.
- They go into the same bone as the cube you clicked, with the same pivot, so they move with it.
- Every face gets the texture of the face you clicked, and the UV is laid out automatically, ready for a script to remap it.
- Clicking a spot that already has a cube of the same name and size does nothing.

## Settings

Open `Tools -> Block Grid Modeler Settings` to change:

- `Name for added cubes` and `Name for cut-out cubes`: what your build script looks for. Names are always written in capitals.
- `Cut-out inflate`: how much cut-out cubes are inflated, 0.025 by default.
