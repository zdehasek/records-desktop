import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json")))
const fallback = {
  "@protomaps/basemaps": `Copyright 2019-2023 Protomaps LLC, Kelso Cartography

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

The Protomaps basemap visual design is CC0. Some icons are derived from Mapzen icons under MIT. The tile schema is adapted from Tilezen. See https://github.com/protomaps/basemaps/blob/main/LICENSE.md.`,
  pmtiles: `The BSD-3-Clause license applies to the reference implementation. The PMTiles specification is public domain, or CC0 where applicable.

Copyright 2021 Protomaps LLC

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  "murmurhash-js": `Copyright (c) 2011 Gary Court

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`
}

const notices = []
for (const [packagePath, entry] of Object.entries(lock.packages)) {
  if (!packagePath.startsWith("node_modules/") || entry.dev) continue
  const directory = path.join(root, packagePath)
  if (!fs.existsSync(directory)) continue
  const metadata = JSON.parse(
    fs.readFileSync(path.join(directory, "package.json"), "utf8")
  )
  const licenseFile = fs
    .readdirSync(directory)
    .find((name) => /^(license|licence|copying)(\..*)?$/i.test(name))
  const text = licenseFile
    ? fs.readFileSync(path.join(directory, licenseFile), "utf8").trim()
    : fallback[metadata.name]
  if (!text) throw new Error(`No license notice found for ${metadata.name}`)
  notices.push({ name: metadata.name, version: metadata.version, text })
}
notices.sort((a, b) => a.name.localeCompare(b.name))

const output = [
  "# Third-Party Notices",
  "",
  "Records distributes compiled or vendored portions of the packages below. Their licenses follow. Map data is attributed to OpenStreetMap contributors in the interface; Protomaps supplies the basemap style, tiles, and glyphs.",
  "",
  ...notices.flatMap(({ name, version, text }) => [
    `## ${name} ${version}`,
    "",
    "```text",
    text,
    "```",
    ""
  ])
].join("\n")

fs.writeFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), output)
