// URL of the backend deployed on Render (no trailing slash).
// Update this after the Render service is created, then redeploy the frontend.
// This is the existing Render service "Cost-Comparison-Tool" (created by hand,
// not from render.yaml, which would have named it cost-comparison-backend).
window.API_BASE = "https://cost-comparison-tool.onrender.com";

// Google Maps Platform browser key for the Prospecting map and the "Add from
// Google Maps" business search. Create it in Google Cloud with the Maps
// JavaScript API and Places API (New) enabled, and restrict it to this site's
// web address (HTTP referrer) so it can't be used elsewhere. Leave empty to
// hide the map.
window.GOOGLE_MAPS_API_KEY = "";
// Optional: a Map ID from Google Cloud. With one, pins use Google's current
// AdvancedMarkerElement; without one, the classic markers.
window.GOOGLE_MAPS_MAP_ID = "";
