#!/usr/bin/env bash
set -euo pipefail

workspace="$1"
build_root="$workspace/.runtime/libmpv-build"
source_root="$build_root/sources"
prefix="$build_root/prefix"
ffmpeg_source="$source_root/ffmpeg-8.1.2"
mpv_source="$source_root/mpv-0.41.0"
ffmpeg_build="$ffmpeg_source"
mpv_build="$build_root/mpv-build"
jobs="${SEEING_STONE_BUILD_JOBS:-8}"
ffmpeg_config_stamp="$ffmpeg_build/.seeing-stone-ffmpeg-8.1.2-v2"

export SOURCE_DATE_EPOCH=1766361600
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig:/ucrt64/lib/pkgconfig"
export PATH="$prefix/bin:/ucrt64/bin:/usr/bin"

if [[ ! -f "$ffmpeg_config_stamp" ]]; then
  mkdir -p "$ffmpeg_build" "$prefix"
  cd "$ffmpeg_build"
  ./configure \
    --prefix="$prefix" \
    --arch=x86_64 \
    --target-os=mingw32 \
    --enable-shared \
    --disable-static \
    --disable-programs \
    --disable-doc \
    --disable-debug \
    --disable-autodetect \
    --enable-network \
    --enable-schannel \
    --enable-zlib \
    --enable-d3d11va \
    --enable-dxva2 \
    --enable-hwaccels \
    --extra-cflags="-O2" \
    --extra-ldflags="-Wl,--dynamicbase,--nxcompat"
  touch "$ffmpeg_config_stamp"
fi

make -C "$ffmpeg_build" -j"$jobs"
make -C "$ffmpeg_build" install

if [[ ! -f "$mpv_build/build.ninja" ]]; then
  meson setup "$mpv_build" "$mpv_source" \
    --prefix="$prefix" \
    --buildtype=release \
    --default-library=shared \
    -Db_lto=true \
    -Db_ndebug=true \
    -Dbuild-date=false \
    -Dtests=true \
    -Dlibmpv=true \
    -Dcplayer=true \
    -Djavascript=disabled \
    -Dlua=disabled \
    -Dcdda=disabled \
    -Ddvbin=disabled \
    -Ddvdnav=disabled \
    -Djpeg=disabled \
    -Dlcms2=disabled \
    -Dlibarchive=disabled \
    -Dlibavdevice=enabled \
    -Dlibbluray=disabled \
    -Drubberband=disabled \
    -Duchardet=disabled \
    -Dvapoursynth=disabled \
    -Dzimg=disabled \
    -Dopenal=disabled \
    -Dsdl2-audio=disabled \
    -Dsdl2-video=disabled \
    -Dsdl2-gamepad=disabled \
    -Dplain-gl=enabled \
    -Dgl=enabled \
    -Dgl-win32=enabled \
    -Degl=disabled \
    -Degl-angle=enabled \
    -Degl-angle-lib=disabled \
    -Degl-angle-win32=disabled \
    -Dd3d11=enabled \
    -Dd3d-hwaccel=enabled \
    -Dd3d9-hwaccel=enabled \
    -Dvulkan=disabled \
    -Dsixel=disabled \
    -Dhtml-build=disabled \
    -Dmanpage-build=disabled \
    -Dpdf-build=disabled \
    -Dc_args="-O2"
fi

meson compile -C "$mpv_build" -j "$jobs"
meson test -C "$mpv_build" --no-rebuild --print-errorlogs
meson install -C "$mpv_build"
