import type { DevicePlatform, VpnClientId } from "../types";

export const PLATFORMS: { id: DevicePlatform; label: string }[] = [
  { id: "android", label: "Android" },
  { id: "ios", label: "iOS" },
  { id: "windows", label: "Windows" },
  { id: "mac", label: "macOS" },
];

export const CLIENTS: { id: VpnClientId; label: string }[] = [
  { id: "happ", label: "Happ" },
  { id: "v2raytun", label: "v2rayTun" },
  { id: "hiddify", label: "Hiddify" },
];

const INSTALL: Record<VpnClientId, Record<DevicePlatform, string>> = {
  hiddify: {
    android:
      "https://play.google.com/store/apps/details?id=app.hiddify.com",
    ios: "https://apps.apple.com/app/hiddify-proxy-vpn/id6596777532",
    windows: "https://github.com/hiddify/hiddify-app/releases/latest",
    mac: "https://github.com/hiddify/hiddify-app/releases/latest",
  },
  v2raytun: {
    android:
      "https://play.google.com/store/apps/details?id=com.v2raytun.android",
    ios: "https://apps.apple.com/app/v2raytun/id6476628951",
    windows: "https://github.com/2dust/v2rayN/releases/latest",
    mac: "https://github.com/yanue/V2rayU/releases/latest",
  },
  happ: {
    android: "https://github.com/Happ-proxy/happ-android/releases/latest",
    ios: "https://testflight.apple.com/join/otxMae4P",
    windows: "https://github.com/Happ-proxy/happ-desktop/releases/latest",
    mac: "https://github.com/Happ-proxy/happ-desktop/releases/latest",
  },
};

export function installUrl(
  client: VpnClientId,
  platform: DevicePlatform
): string {
  return INSTALL[client][platform];
}
