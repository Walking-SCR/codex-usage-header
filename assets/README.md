# Icon assets

The refresh, database, and clock icons are adapted from the MIT-licensed
[Heroicons](https://heroicons.com/) outline set. They are packaged as real
assets and injected as data URLs so the `app://` renderer does not depend on
network access.

`reset-credit.png` is the compact reset-credit ticket artwork used by the
reset-credit cards. It is resized to 128×128 and kept below 100KB so it can be
embedded as a local data URL without adding network dependencies.
