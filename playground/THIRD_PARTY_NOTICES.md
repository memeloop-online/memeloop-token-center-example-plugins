# Third-party notices

## MemeLoop React UI message display primitives

Package: `@memeloop/react-ui@0.2.10` (MIT).
Source: https://github.com/memeloop-online/memeloop/tree/main/packages/memeloop-react-ui
Registry: https://www.npmjs.com/package/@memeloop/react-ui/v/0.2.10

The plugin bundles the official `@memeloop/react-ui/chat/core` message display
projection and truncation metadata functions. Display projections keep long
replies manageable while the conversation retains its complete message text.
The installed package is tree-shaken into the single browser module; its MUI,
assistant-ui and React component implementations are not included.

The display primitives use `memeloop@0.3.9` (MIT) for message metadata validation.
Registry: https://www.npmjs.com/package/memeloop/v/0.3.9
This package complements the separately pinned orchestration script below;
it does not replace that script's agent execution loop. Both npm packages
declare the MIT license, whose terms are reproduced below. The package lock,
bundle metadata and package evidence record the resolved dependency versions
and the inputs that contribute bytes to the shipped browser module.

## MemeLoop agent/tool orchestration script

Source: https://github.com/memeloop-online/memeloop/blob/7e9aec265a8870ec45cd186112d65108fb6b606d/packages/memeloop/src/loops/agent-tool-loop/default.mjs

Pinned revision: `7e9aec265a8870ec45cd186112d65108fb6b606d`.
The upstream `memeloop` package declares the MIT license. The upstream repository does not provide a root LICENSE file at this revision. The unchanged script is preserved in `playground/memeloop-runtime/default.mjs` and included in the self-contained browser bundle. See the adjacent source integration README for the adapter boundary.

The host supplies React and Fluent UI through its component package contract; they are not redistributed by this plugin. The remaining plugin sources are covered by the repository's Apache-2.0 license.

MIT license terms (the dependency's declared license):

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
