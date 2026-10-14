#!/bin/zsh
# Builds "Global Markets.app", a Mac app that shows the dashboard in a window
# of its own (see mac/GlobalMarkets.swift), and puts it in ~/Applications, or
# in the folder given. Needs the Xcode command line tools (xcode-select --install).
#
# The app records where this project is, so build it again after moving the
# project folder. Set PORT to build it for a server on a different port.

set -euo pipefail

DIR="${0:A:h:h}" # the project folder, one level above scripts/
DEST="${1:-$HOME/Applications}"
APP="$DEST/Global Markets.app"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

echo "Compiling…"
# Aimed at macOS 13 and later: left to itself the compiler targets the
# version of its SDK, which can be newer than the system it runs on.
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" -o "$BUILD/GlobalMarkets" "$DIR/mac/GlobalMarkets.swift" -framework Cocoa -framework WebKit

echo "Drawing the icon…"
swift "$DIR/mac/make-icon.swift" "$BUILD/icon.png"
mkdir "$BUILD/icon.iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size "$BUILD/icon.png" --out "$BUILD/icon.iconset/icon_${size}x${size}.png" > /dev/null
  sips -z $((size * 2)) $((size * 2)) "$BUILD/icon.png" --out "$BUILD/icon.iconset/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns "$BUILD/icon.iconset" -o "$BUILD/AppIcon.icns"

echo "Assembling $APP…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/GlobalMarkets" "$APP/Contents/MacOS/"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/"
plutil -create xml1 "$APP/Contents/Info.plist"
info() { plutil -insert "$1" -"$2" "$3" "$APP/Contents/Info.plist"; }
info CFBundleName string "Global Markets"
info CFBundleDisplayName string "Global Markets"
info CFBundleIdentifier string "local.global-dashboard.app"
info CFBundleExecutable string "GlobalMarkets"
info CFBundleIconFile string "AppIcon"
info CFBundlePackageType string "APPL"
info CFBundleShortVersionString string "1.0"
info CFBundleVersion string "1"
info LSMinimumSystemVersion string "13.0"
info LSApplicationCategoryType string "public.app-category.finance"
info NSHighResolutionCapable bool true
info DashboardFolder string "$DIR"
info DashboardPort string "${PORT:-5177}"
# The page is served over plain http from this computer.
info NSAppTransportSecurity json '{"NSAllowsLocalNetworking": true}'

# Signed for this computer only, which is all a locally built app needs.
codesign --force --sign - "$APP" > /dev/null 2>&1
# Tell Finder and the Dock about the new icon.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" > /dev/null 2>&1 || true

echo "Built: $APP"
