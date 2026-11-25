# Edge Noise Brush
This plugin adds a paint tool that breaks up straight edges between two tones into pixel steps, the kind of hand-placed jaggedness that makes a hard line between two colours look less mechanical.

Where the brush passes over an edge, the edge is cut into segments of random length, and a share of those segments is pushed into the neighbouring tone by one or more pixels. It only ever copies colours that are already on either side of the edge, so the texture's palette stays exactly as it was.

By default only the colour selected in the colour panel grows, stepping outward into whatever it borders, and never gets eaten into. With that option off, both tones push into each other.

The pattern is worked out once from a snapshot of the texture when the stroke starts, and every pixel's result comes from a fixed seed. Painting over the same spot again in one stroke changes nothing further, and changing the seed gives a different pattern.
