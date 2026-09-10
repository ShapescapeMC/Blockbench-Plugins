# Old plugins

Plugins that are no longer maintained, kept here for reference.

They are not listed in the documentation and are not part of the published plugin set. Nothing here is expected to keep working against new Blockbench releases.

## Batch Screenshot

Replaced by [Render Model](../render_model). Batch Screenshot rendered a folder of models with nobody watching: you registered jobs ahead of time and processed them in one go, and its settings lived in a `.batch` folder in your home directory rather than in Blockbench.

Render Model covers the same output and more, but works on the model you have open rather than on registered jobs. The one thing it does not carry over is Batch Screenshot's texture layer combinations, which rendered every permutation of up to three folders of textures. That was built for spawn egg variants. If you need it, this is where to find the original.

Its own usage notes are kept alongside the plugin in [batch_screenshot/usage.md](./batch_screenshot/usage.md).
