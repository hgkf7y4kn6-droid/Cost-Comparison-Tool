import { usePostHog } from "posthog-react-native";
import { useCallback } from "react";

type EventProperties = Record<string, string | number | boolean | null>;

/**
 * Thin wrapper so screens can always call `track(...)`: it is a no-op when no
 * PostHog key is configured (local dev, or before PostHog is set up).
 */
export function useTrack() {
  const posthog = usePostHog();
  return useCallback(
    (event: string, properties?: EventProperties) => {
      posthog?.capture(event, properties);
    },
    [posthog],
  );
}
