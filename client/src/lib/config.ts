// EXPO_PUBLIC_* values are inlined at build time: from .env locally, from
// Cloudflare build variables for the web build, and from EAS environment
// variables for native builds. All of these are public (client-side) values.
export const API_BASE = (
  process.env.EXPO_PUBLIC_API_BASE ?? "https://cost-comparison-tool.onrender.com"
).replace(/\/$/, "");

export const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";

export const POSTHOG_KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY ?? "";
export const POSTHOG_HOST = process.env.EXPO_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

export const OFFICEBASICS_PORTAL_URL = "https://supplies.officebasics.com/";
