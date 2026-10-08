[![License](https://img.shields.io/badge/License-Apache_2.0-green.svg)](https://www.apache.org/licenses/LICENSE-2.0)

## Overview

This repository contains the editor plugins shipped with Euro-Office, together with the files and resources needed to set up and manage them.

## Repository Structure

* [**sdkjs-plugins**](sdkjs-plugins): This directory contains the stylesheets and CSS files used for plugin customization and styling. It also contains the code and resources of all plugins.
* [**store**](store): This directory contains the code and resources for the Plugins Manager. It includes the necessary scripts and configurations to manage plugins within the editors.

## Contributing

Contributions are welcome. To add your own plugin, please follow these [guidelines](store#how-to-build-and-add-your-own-plugin). We appreciate your contributions and will review them as soon as possible.

## License

This repository is licensed under the Apache License, version 2.0. See [LICENSE](LICENSE) for more information. It is based on [ONLYOFFICE/onlyoffice.github.io](https://github.com/ONLYOFFICE/onlyoffice.github.io).

## User Feedback and Support

If you encounter any issues or have any questions regarding the plugins, please [open an issue](https://github.com/Euro-Office/plugins/issues) in this repository.

## Acknowledgments

We would like to thank all the contributors and developers who have worked on these plugins.

## Bundling

`bundle.txt` lists the plugin folders (one per line) that ship with Euro-Office DocumentServer.
`scripts/bundle.sh <dest>` builds the `sdkjs-plugins` directory for the image from it:

- copies `sdkjs-plugins/v1/{plugins.js,plugins-ui.js,plugins.css}` to `<dest>/v1`
- copies each listed plugin to `<dest>/<name>` without dev and build files (`.dev`, `node_modules`, `deploy`, `src` of prebuilt plugins, source maps)
- rewrites `https://onlyoffice.github.io/sdkjs-plugins/` in HTML files to a relative path pointing at `<dest>/v1`

`scripts/check-bundle.sh <dest>` fails if a bundled plugin loads external scripts, stylesheets or fonts on open, or declares a system or background variation. CI runs both on every push and pull request.
