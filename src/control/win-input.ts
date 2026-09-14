// Compatibility shim for earlier M3.1 imports. The Windows backend now lives
// in win-native.ts, where one persistent helper process owns the Win32/C#
// bridge instead of recompiling Add-Type for every action.
export * from "./win-native.js";
