#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LOCK="$ROOT/vendor/sources.lock.json"
BUILD="$ROOT/.build/vendor"
DOWNLOADS="$BUILD/downloads"
SOURCES="$BUILD/sources"
WORK="$BUILD/work"

[[ $(uname -s) == Darwin ]] || { echo "vendor build requires native macOS" >&2; exit 1; }
case $(uname -m) in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "unsupported native architecture: $(uname -m)" >&2; exit 1 ;;
esac
[[ -z ${RECORDS_MAC_ARCH:-} || $RECORDS_MAC_ARCH == "$ARCH" ]] || {
  echo "runner architecture $ARCH does not match RECORDS_MAC_ARCH=$RECORDS_MAC_ARCH" >&2
  exit 1
}

TARGET=$(node -p "require('$LOCK').deploymentTarget")
PREFIX="$WORK/$ARCH/prefix"
STAGE="$ROOT/vendor/mac-$ARCH"
JOBS=$(sysctl -n hw.logicalcpu)
export MACOSX_DEPLOYMENT_TARGET="$TARGET"
export CFLAGS="-O2 -mmacosx-version-min=$TARGET"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-mmacosx-version-min=$TARGET"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig"
export PATH="$PREFIX/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

component_field() {
  node -e 'const l=require(process.argv[1]);const c=l.components.find(x=>x.name===process.argv[2]);if(!c)process.exit(2);process.stdout.write(String(c[process.argv[3]]))' "$LOCK" "$1" "$2"
}

archive_name() {
  node -e 'const c=require(process.argv[1]).components.find(x=>x.name===process.argv[2]);const p=new URL(c.url).pathname.split("/").filter(Boolean);process.stdout.write(p.at(-1)==="download"?p.at(-2):p.at(-1))' "$LOCK" "$1"
}

extract_source() {
  local name=$1 directory archive destination
  directory=$(component_field "$name" directory)
  archive=$(archive_name "$name")
  destination="$SOURCES/$directory"
  if [[ ! -d $destination ]]; then
    mkdir -p "$SOURCES"
    tar -xf "$DOWNLOADS/$archive" -C "$SOURCES"
  fi
  printf '%s' "$destination"
}

cmake_build() {
  local name=$1 linkage=$2; shift 2
  local source build
  source=$(extract_source "$name")
  build="$WORK/$ARCH/build-$name"
  cmake -S "$source" -B "$build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$TARGET" \
    -DBUILD_SHARED_LIBS="$linkage" "$@"
  cmake --build "$build" --parallel "$JOBS"
  cmake --install "$build"
}

cmake_static() {
  local name=$1; shift
  cmake_build "$name" OFF "$@"
}

stage_dylib() {
  local stem=$1 destination=$2
  local -a matches=()
  while IFS= read -r file; do matches+=("$file"); done < <(find "$PREFIX/lib" -maxdepth 1 -type f -name "$stem*.dylib" -print)
  [[ ${#matches[@]} -eq 1 ]] || {
    printf 'expected one regular %s dylib, found %s\n' "$stem" "${#matches[@]}" >&2
    exit 1
  }
  cp "${matches[0]}" "$destination"
}

rewrite_matching_dependency() {
  local binary=$1 pattern=$2 replacement=$3 dependency found=false
  while IFS= read -r dependency; do
    if [[ $(basename "$dependency") == $pattern ]]; then
      install_name_tool -change "$dependency" "$replacement" "$binary"
      found=true
    fi
  done < <(otool -L "$binary" | tail -n +2 | while read -r dependency _; do printf '%s\n' "$dependency"; done)
  [[ $found == true ]] || { echo "$binary does not link $pattern" >&2; exit 1; }
}

rm -rf "$SOURCES" "$WORK/$ARCH" "$STAGE"
mkdir -p "$PREFIX" "$STAGE" "$WORK/$ARCH"
node "$ROOT/scripts/vendor/fetch.mjs"

X264=$(extract_source x264)
(cd "$X264" && ./configure --prefix="$PREFIX" --host="$(uname -m)-apple-darwin" --enable-static --disable-cli --disable-opencl && make -j"$JOBS" && make install)

cmake_static libjpeg-turbo -DENABLE_SHARED=OFF -DWITH_TURBOJPEG=OFF -DWITH_TESTS=OFF
cmake_static libpng -DPNG_SHARED=OFF -DPNG_STATIC=ON -DPNG_TESTS=OFF -DPNG_TOOLS=OFF
cmake_static libtiff -Dtiff-tools=OFF -Dtiff-tests=OFF -Dtiff-contrib=OFF -Dtiff-docs=OFF -Djpeg=ON -Djbig=OFF -Dlerc=OFF -Dlzma=OFF -Dwebp=OFF -Dzstd=OFF
cmake_static libwebp -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_EXTRAS=OFF -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=OFF
cmake_build libde265 ON -DENABLE_SDL=OFF -DENABLE_DEC265=OFF -DENABLE_ENCODER=OFF

DAV1D=$(extract_source dav1d)
meson setup "$WORK/$ARCH/build-dav1d" "$DAV1D" --prefix="$PREFIX" --buildtype=release --default-library=static -Denable_tools=false -Denable_tests=false
meson compile -C "$WORK/$ARCH/build-dav1d"
meson install -C "$WORK/$ARCH/build-dav1d"

cmake_build libheif ON \
  -DCMAKE_DISABLE_FIND_PACKAGE_TIFF=TRUE \
  -DENABLE_PLUGIN_LOADING=OFF \
  -DWITH_LIBDE265=ON -DWITH_LIBDE265_PLUGIN=OFF \
  -DWITH_DAV1D=ON -DWITH_DAV1D_PLUGIN=OFF \
  -DWITH_X265=OFF -DWITH_KVAZAAR=OFF -DWITH_UVG266=OFF \
  -DWITH_VVDEC=OFF -DWITH_VVENC=OFF -DWITH_OpenH264_DECODER=OFF \
  -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF \
  -DWITH_SvtEnc=OFF -DWITH_RAV1E=OFF \
  -DWITH_JPEG_DECODER=OFF -DWITH_JPEG_ENCODER=OFF \
  -DWITH_OpenJPEG_DECODER=OFF -DWITH_OpenJPEG_ENCODER=OFF \
  -DWITH_FFMPEG_DECODER=OFF -DWITH_OPENJPH_ENCODER=OFF \
  -DWITH_LIBSHARPYUV=OFF -DWITH_UNCOMPRESSED_CODEC=OFF \
  -DWITH_GDK_PIXBUF=OFF -DWITH_EXAMPLES=OFF -DBUILD_TESTING=OFF

IM=$(extract_source imagemagick)
(cd "$IM" && WEBP_CFLAGS="$(pkg-config --cflags libwebp)" WEBP_LIBS="$(pkg-config --static --libs libwebp)" ./configure --prefix="$PREFIX" --disable-shared --enable-static --without-modules --without-x --without-gslib --without-djvu --without-fftw --without-fontconfig --without-freetype --without-lcms --without-openjp2 --without-raw --without-xml && make -j"$JOBS" && make install)

FFMPEG=$(extract_source ffmpeg)
(cd "$FFMPEG" && ./configure --prefix="$PREFIX" --pkg-config-flags=--static --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib" --enable-gpl --enable-libx264 --enable-videotoolbox --disable-shared --enable-static --disable-doc --disable-debug --disable-ffplay --disable-network && make -j"$JOBS" && make install)

PERL=$(extract_source perl)
(cd "$PERL" && ./Configure -des -Dprefix="$PREFIX/perl" -Duserelocatableinc -Duseshrplib=false -Duseithreads=false -Dman1dir=none -Dman3dir=none && make -j"$JOBS" && make install)

EXIFTOOL=$(extract_source exiftool)
mkdir -p "$STAGE/bin" "$STAGE/lib" "$STAGE/exiftool" "$STAGE/etc/ImageMagick-7" "$STAGE/licenses"
cp "$PREFIX/bin/ffmpeg" "$PREFIX/bin/ffprobe" "$PREFIX/bin/magick" "$STAGE/bin/"
stage_dylib libde265 "$STAGE/lib/libde265.dylib"
stage_dylib libheif "$STAGE/lib/libheif.dylib"
install_name_tool -id @rpath/libde265.dylib "$STAGE/lib/libde265.dylib"
install_name_tool -id @rpath/libheif.dylib "$STAGE/lib/libheif.dylib"
rewrite_matching_dependency "$STAGE/lib/libheif.dylib" 'libde265*.dylib' @loader_path/libde265.dylib
rewrite_matching_dependency "$STAGE/bin/magick" 'libheif*.dylib' @executable_path/../lib/libheif.dylib
install_name_tool -add_rpath @loader_path "$STAGE/lib/libheif.dylib"
install_name_tool -add_rpath @executable_path/../lib "$STAGE/bin/magick"
cp -R "$PREFIX/perl" "$STAGE/perl"
cp "$EXIFTOOL/exiftool" "$STAGE/exiftool/"
cp -R "$EXIFTOOL/lib" "$STAGE/exiftool/lib"
cp "$ROOT/scripts/vendor/policy.xml" "$STAGE/etc/ImageMagick-7/policy.xml"

while IFS=$'\t' read -r name license; do
  source=$(extract_source "$name")
  mkdir -p "$STAGE/licenses/$name"
  cp "$source/$license" "$STAGE/licenses/$name/$(basename "$license")"
done < <(node -e 'for(const c of require(process.argv[1]).components)for(const f of c.licenseFiles)console.log(`${c.name}\t${f}`)' "$LOCK")
cp "$LOCK" "$STAGE/sources.lock.json"

"$STAGE/bin/ffmpeg" -hide_banner -buildconf > "$STAGE/ffmpeg-buildconf.txt" 2>&1
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({architecture:process.argv[2],deploymentTarget:process.argv[3],xcode:process.argv[4],sourceLock:"vendor/sources.lock.json"},null,2)+"\n")' "$STAGE/build-info.json" "$ARCH" "$TARGET" "$(xcodebuild -version | tr '\n' ' ')"
chmod 0755 "$STAGE/bin/ffmpeg" "$STAGE/bin/ffprobe" "$STAGE/bin/magick" "$STAGE/perl/bin/perl" "$STAGE/exiftool/exiftool"
node "$ROOT/scripts/vendor/validate.mjs" staged "$STAGE"
