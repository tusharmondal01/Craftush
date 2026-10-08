# Bundled video engine

These assets are redistributed without changes to their JavaScript or WebAssembly contents.

| Component | Version | License | Published package |
| --- | --- | --- | --- |
| `@ffmpeg/ffmpeg` browser wrapper | 0.12.15 | MIT, Copyright (c) 2019 Jerome Wu | https://registry.npmjs.org/@ffmpeg/ffmpeg/-/ffmpeg-0.12.15.tgz |
| `@ffmpeg/core` single-thread engine | 0.12.10 | GPL-2.0-or-later, including FFmpeg and the configured external libraries | https://registry.npmjs.org/@ffmpeg/core/-/core-0.12.10.tgz |

The wrapper license is reproduced in `LICENSE-wrapper.txt`. The GNU GPL version 2 is reproduced in `LICENSE-GPL-2.0.txt`. The engine's upstream licensing explanation is https://ffmpegwasm.netlify.app/docs/faq/ . The wrapper license does not replace the engine or codec licenses.

The exact core release's build source is included in this ZIP at `references/ffmpeg-core-build-source.tar.gz`, from upstream commit `71aa99d37c02a7b4c435275ca9ef50e612f6efa1` (the release commit for core 0.12.10):

- Build source and scripts: https://github.com/ffmpegwasm/ffmpeg.wasm/tree/71aa99d37c02a7b4c435275ca9ef50e612f6efa1
- Source archive: https://codeload.github.com/ffmpegwasm/ffmpeg.wasm/tar.gz/71aa99d37c02a7b4c435275ca9ef50e612f6efa1
- FFmpeg source, pinned by that Dockerfile to n5.1.4: https://github.com/FFmpeg/FFmpeg/tree/n5.1.4
- FFmpeg source archive: https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/refs/tags/n5.1.4

The included Dockerfile and build scripts specify Emscripten 3.1.40, compiler flags, bindings and all external library source locations. Those configured library sources are listed below, with their upstream license files in their source trees. The complete build can be reconstructed from the included build source and these sources using the upstream Docker instructions.

| Configured library source | Revision selected by the build |
| --- | --- |
| https://github.com/ffmpegwasm/x264 | `4-cores` |
| https://github.com/ffmpegwasm/x265 | `3.4` |
| https://github.com/ffmpegwasm/libvpx | `v1.13.1` |
| https://github.com/ffmpegwasm/lame | `master` |
| https://github.com/ffmpegwasm/Ogg | `v1.3.4` |
| https://github.com/ffmpegwasm/theora | `v1.1.1` |
| https://github.com/ffmpegwasm/opus | `v1.3.1` |
| https://github.com/ffmpegwasm/vorbis | `v1.3.3` |
| https://github.com/ffmpegwasm/zlib | `v1.2.11` |
| https://github.com/ffmpegwasm/libwebp | `v1.3.2` |
| https://github.com/ffmpegwasm/freetype2 | `VER-2-10-4` |
| https://github.com/fribidi/fribidi | `v1.0.9` |
| https://github.com/harfbuzz/harfbuzz | `5.2.0` |
| https://github.com/libass/libass | `0.15.0` |
| https://github.com/sekrit-twc/zimg | `release-3.0.5` |

The FFmpeg binaries are free software under their applicable licenses, without warranty. Preserve the notices and corresponding source information when redistributing these assets. `asset-sha256.json` records the bundled file hashes.
