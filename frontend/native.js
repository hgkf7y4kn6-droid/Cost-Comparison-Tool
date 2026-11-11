// Only does anything inside the iOS/Android app (Capacitor): status bar styling and the Android back button.
(function () {
  if (!window.IN_NATIVE_APP) return;
  const plugins = (window.Capacitor && window.Capacitor.Plugins) || {};
  document.documentElement.classList.add("native-app");
  try {
    if (plugins.StatusBar) {
      plugins.StatusBar.setStyle({ style: "DARK" }); // light text on the navy header
      plugins.StatusBar.setBackgroundColor && plugins.StatusBar.setBackgroundColor({ color: "#0f1a2c" });
    }
  } catch (_) {
    // not available on this platform
  }
  try {
    if (plugins.App && plugins.App.addListener) {
      plugins.App.addListener("backButton", ({ canGoBack }) => {
        // Close whatever is open first: dialogs, side panels, then go back; at the top level, leave the app.
        const dialog = [...document.querySelectorAll('[role="dialog"]:not([hidden])')].find((d) => d.id !== "signin");
        const closer = dialog && dialog.querySelector("[id$='close'], #ai-consent-no");
        if (closer) return closer.click();
        const drawer = document.querySelector("section.drawer:not([hidden]) .drawer-close, #d-close:not([hidden])");
        if (drawer) return drawer.click();
        if (canGoBack) return window.history.back();
        if (plugins.App.minimizeApp) plugins.App.minimizeApp();
      });
    }
  } catch (_) {
    // not available on this platform
  }
})();
