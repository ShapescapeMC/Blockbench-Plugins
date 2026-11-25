# Edge Noise Brush
This plugin adds a mode to the normal Brush tool that breaks up straight edges between two tones into pixel steps, the kind of hand-placed jaggedness that makes a hard line between two colours look less mechanical.

Where the brush passes over an edge, the edge is pushed into the neighbouring tone in steps. It only ever copies colours that are already on either side of the edge, so the texture's palette stays exactly as it was.

The steps come from one of two places:

- **Random steps.** The edge is cut into segments of random length, and a share of them is pushed in by one or more pixels. Roughness, depth and segment length are set in the brush settings.
- **A preset.** A small PNG with a bright side and a dark side that meet at the jagged edge you want. The brush learns the shape of that edge and repeats it along every edge you paint over, so you can keep a consistent look across textures.

By default only the colour selected in the colour panel grows, stepping outward into whatever it borders, and never gets eaten into. With that option off, both tones push into each other.

Sliding the brush along an edge breaks it up once. Going back over it without letting go grows the brush colour another step each time, so you can push an edge further by scrubbing.

The Highlight Brush and the Shadow Brush draw a line of the brush colour along the edges you brush over, following every step of them, with breaks and thickness taken from your own line presets. Break an edge up first, then brush over it to add a highlight or a shadow.

The plugin also adds a Noise Brush, which scatters the brush colour over any surface, densest in the middle of the brush and thinning out towards its edge. Scrubbing over a spot fills it in further. It is meant for starting texture on a flat area with a big brush.
