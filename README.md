[![License](https://img.shields.io/badge/License-Apache_2.0-green.svg)](https://www.apache.org/licenses/LICENSE-2.0)

## Overview

This repository contains the editor plugins shipped with Euro-Office, together with the files and resources needed to set up and manage them.

## Repository Structure

* [**sdkjs-plugins**](sdkjs-plugins): This directory contains the stylesheets and CSS files used for plugin customization and styling. It also contains the code and resources of all plugins.
* [**store**](store): This directory contains the code and resources for the Plugins Manager. It includes the necessary scripts and configurations to manage plugins within the editors.
* [**external.json**](external.json): Plugins developed in their own `Euro-Office/plugin-<name>` repositories, pinned to a release tag.

## Plugins in their own repositories

New plugins live in their own repository, created from `Euro-Office/plugin-template`, with their own tests and releases. This repository distributes them:

1. The plugin repository tags `v<version>` and attaches `<name>.plugin` to the GitHub release.
2. An entry in [external.json](external.json) pins that tag: `{ "name": "<name>", "repo": "Euro-Office/plugin-<name>", "tag": "v<version>" }`.
3. [scripts/fetch-external.sh](scripts/fetch-external.sh) unpacks each release into `sdkjs-plugins/content/<name>` before packing, so bundle, releases and store handle it like the plugins kept here.

A plugin is either kept here or listed in `external.json`, never both.

## Contributing

Contributions are welcome. To add your own plugin, please follow these [guidelines](store#how-to-build-and-add-your-own-plugin). We appreciate your contributions and will review them as soon as possible.

## License

This repository is licensed under the Apache License, version 2.0. See [LICENSE](LICENSE) for more information. It is based on [ONLYOFFICE/onlyoffice.github.io](https://github.com/ONLYOFFICE/onlyoffice.github.io).

## User Feedback and Support

If you encounter any issues or have any questions regarding the plugins, please [open an issue](https://github.com/Euro-Office/plugins/issues) in this repository.

## Acknowledgments

We would like to thank all the contributors and developers who have worked on these plugins.
