## Overview

Use Telegram for instant messaging within the editor interface. 

The plugin is based on the [telegram-react](https://github.com/evgeny-nadymov/telegram-react) app. The app uses the ReactJS JavaScript framework and TDLib (Telegram Database library) compiled to WebAssembly. 

The plugin is compatible with self-hosted and desktop versions of the editors. It can be added to editor instances manually. 

## How to use

1. Find the plugin in the Plugins tab.
2. Log in to your Telegram account. 

## How to install

Detailed instructions can be found in the [plugin installation guide](https://euro-office.github.io/documentation/configuration/plugins/).

## Configuration

By default, that plugin uses (https://evgeny-nadymov.github.io/telegram-react/). If you need to change it, open the `index.html` file and insert the new URL in the iframe `src field`.

## Known issues

* The plugin has no access to the camera and microphone, so you'll be unable to record voice and video messages. 
* The plugin doesn't work in the incognito mode. 
