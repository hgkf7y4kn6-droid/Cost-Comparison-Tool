// Where the API lives (no trailing slash).
// When the backend serves this page itself (Render, or `uvicorn` locally on
// port 8000), the API is on the same address. A separate static host (e.g.
// Cloudflare) calls the Render service.
window.API_BASE =
  location.origin === "https://cost-comparison-tool.onrender.com" || location.port === "8000"
    ? ""
    : "https://cost-comparison-tool.onrender.com";

// Google Maps Platform browser key for the Prospecting map and the "Add from
// Google Maps" business search. Create it in Google Cloud with the Maps
// JavaScript API and Places API (New) enabled, and restrict it to this site's
// web address (HTTP referrer) so it can't be used elsewhere. Leave empty to
// hide the map.
window.GOOGLE_MAPS_API_KEY = "";
// Optional: a Map ID from Google Cloud. With one, pins use Google's current
// AdvancedMarkerElement; without one, the classic markers.
window.GOOGLE_MAPS_MAP_ID = "";
