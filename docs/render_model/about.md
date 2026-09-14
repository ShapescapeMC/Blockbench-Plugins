# Render Model
This plugin renders the model you have open into finished images and GIFs, from preset camera angles, at one or more resolutions, in a single pass.

It produces still PNGs from the four sides, the top and bottom, the isometric corners or any number of views spaced around the model. It can record a looping turntable GIF, with animations playing underneath if you want them, and a looping GIF for each animation in the project. Animations can be layered, so an idle or a blink plays on top of a walk cycle. Views and animations can also be grouped into sheets: the isometric corners two over two, the sides and top and bottom together or apart, and every selected animation side by side in one GIF, each tile named above.

Rendering happens in an off-screen buffer, so your viewport is never moved and nothing has to be left alone while it works.

```{note}
Render Model replaces the old Batch Screenshot plugin. There is no configuration file and there are no job files. Every setting lives in the dialog and is remembered between sessions.
```
