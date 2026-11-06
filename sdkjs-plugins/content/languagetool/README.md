## Overview

Find and correct grammar and style mistakes.

The plugin uses [LanguageTool](https://languagetool.org/), multilingual grammar and style checker.

It is compatible with self-hosted and desktop versions of the editors. It can be added to editor instances manually.

## How to use

1. Open the Plugins tab and click on LanguageTool.
2. Select the text you want to be checked.
3. Choose your language (it can be detected automatically or set manually). 
4. Alternatively, you can insert text for correction manually. To do so, type new text in the field on left panel or edit already selected text (this will only affect the translation, the original text will remain unchanged). Click Check.
5. Choose the corrections to be applied to your text. They will appear in the text in the field on the left panel. 
6. To replace the selected text in your document with the corrected text from the field, click Replace.

## How to install

Detailed instructions can be found in the [plugin installation guide](https://euro-office.github.io/documentation/configuration/plugins/).

## Using your service

You can install LanguageTool to your own server and send requests to it. 

To do so, you need to change the url address of the `serviceUrl` variable in the `./scripts/langTool.js` file.
