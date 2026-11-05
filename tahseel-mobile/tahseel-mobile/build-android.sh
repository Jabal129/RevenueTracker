#!/usr/bin/env bash
# يبني ملف APK للتجربة. المتطلبات: Node 22+ و JDK 21 و Android SDK (يأتي مع Android Studio).
set -euo pipefail
cd "$(dirname "$0")"
npm install
[ -d android ] || npx cap add android
M=android/app/src/main/AndroidManifest.xml
for p in CAMERA; do   # للتقاط صور الإيصالات (إذن الإشعارات يضيفه المكوّن نفسه)
  grep -q "android.permission.$p" "$M" || \
    perl -0pi -e "s#<application#<uses-permission android:name=\"android.permission.$p\" />\n    <application#" "$M"
done
npx cap sync android
( cd android && chmod +x gradlew && ./gradlew assembleDebug )
echo
echo "APK: $(pwd)/android/app/build/outputs/apk/debug/app-debug.apk"
