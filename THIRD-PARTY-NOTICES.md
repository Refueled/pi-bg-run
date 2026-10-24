# Third-party notices

## pi-bg-bash

This extension's design follows [pi-bg-bash](https://github.com/gvanderclay/pi-bg-bash)
by Gage Vander Clay: the nonce-marked exit protocol on task logs, the task
registry kept on `globalThis` across `/reload`, completion delivered as a
steering message that starts a turn when the agent is idle, and the log
limits and cleanup policies. pi-bg-bash is licensed under the MIT License,
reproduced below. This repository reimplements those ideas for Windows
(`taskkill` process trees, Git Bash wrapper scripts) and adds the Herdr tab
layer; no code was copied verbatim.

```
MIT License

Copyright (c) 2026 Gage Vander Clay

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
