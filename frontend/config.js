// Where the API lives (no trailing slash).
// The backend serves this page itself (Render, your own domain pointed at
// Render, or `uvicorn` locally), so by default the API is on the same address
// as the page: "" means "this site". Two other cases need the backend's full
// address: a separate static host (Cloudflare Workers/Pages) and the iOS/Android
// app, which ships these files inside the app and talks to your server.
const STATIC_HOST_API = "https://cost-comparison-tool.onrender.com";
// The server the mobile apps use. Set this to your own domain before building them.
const NATIVE_APP_API = "https://cost-comparison-tool.onrender.com";
// Capacitor (the iOS/Android shell) serves the app from https://localhost.
const IN_NATIVE_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
window.IN_NATIVE_APP = IN_NATIVE_APP;
window.API_BASE = IN_NATIVE_APP ? NATIVE_APP_API : /\.(workers|pages)\.dev$/.test(location.hostname) ? STATIC_HOST_API : "";

// Shown on the privacy policy, terms and support pages and in the app.
// Set these before submitting to the App Store or Google Play: both require a
// working support contact and a public privacy policy URL.
window.COMPANY = {
  name: "Office Basics",
  supportEmail: "",       // e.g. "support@yourcompany.com"
  mailingAddress: "",     // shown on the policy pages if set
  siteUrl: "",            // public web address of this app, e.g. "https://sales.yourcompany.com"
};

// Google Maps Platform browser key for the Prospecting map and the "Add from
// Google Maps" business search. Create it in Google Cloud with the Maps
// JavaScript API and Places API (New) enabled, and restrict it to this site's
// web address (HTTP referrer) so it can't be used elsewhere. For the mobile
// apps also allow https://localhost/*. Leave empty to hide the map.
window.GOOGLE_MAPS_API_KEY = "";
// Optional: a Map ID from Google Cloud. With one, pins use Google's current
// AdvancedMarkerElement; without one, the classic markers.
window.GOOGLE_MAPS_MAP_ID = "";
