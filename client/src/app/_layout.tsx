import { ClerkProvider, useAuth, useUser } from "@clerk/clerk-expo";
import { tokenCache } from "@clerk/clerk-expo/token-cache";
import { Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { PostHogProvider, usePostHog } from "posthog-react-native";
import { useEffect, useRef, type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { colors } from "@/components/ui";
import { CLERK_PUBLISHABLE_KEY, POSTHOG_HOST, POSTHOG_KEY } from "@/lib/config";

export default function RootLayout() {
  if (!CLERK_PUBLISHABLE_KEY) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>App not configured</Text>
        <Text style={styles.body}>
          EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is missing. Set it in client/.env for local runs, as a
          Cloudflare build variable for the web build, or as an EAS environment variable for app builds.
        </Text>
      </View>
    );
  }

  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <Analytics>
        <StatusBar style="dark" />
        <RootNavigator />
      </Analytics>
    </ClerkProvider>
  );
}

function Analytics({ children }: { children: ReactNode }) {
  if (!POSTHOG_KEY) return <>{children}</>;
  return (
    <PostHogProvider
      apiKey={POSTHOG_KEY}
      options={{ host: POSTHOG_HOST }}
      // Screen autocapture targets React Navigation; expo-router screens are tracked in AnalyticsSync.
      autocapture={{ captureScreens: false, captureTouches: false }}
    >
      <AnalyticsSync />
      {children}
    </PostHogProvider>
  );
}

/** Ties PostHog to the Clerk user and records expo-router screen views. */
function AnalyticsSync() {
  const posthog = usePostHog();
  const { isLoaded, user } = useUser();
  const pathname = usePathname();
  const identifiedId = useRef<string | null>(null);
  const userId = user?.id ?? null;
  const email = user?.primaryEmailAddress?.emailAddress ?? null;

  useEffect(() => {
    if (!isLoaded) return;
    if (userId && identifiedId.current !== userId) {
      posthog.identify(userId, { email });
      identifiedId.current = userId;
    } else if (!userId && identifiedId.current) {
      // only on an actual sign-out, so anonymous visitors keep a stable id
      posthog.reset();
      identifiedId.current = null;
    }
  }, [isLoaded, userId, email, posthog]);

  useEffect(() => {
    posthog.screen(pathname);
  }, [pathname, posthog]);

  return null;
}

function RootNavigator() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.blue} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={!!isSignedIn}>
        <Stack.Screen name="index" />
      </Stack.Protected>
      <Stack.Protected guard={!isSignedIn}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 8,
    backgroundColor: colors.bg,
  },
  title: { fontSize: 18, fontWeight: "700", color: colors.text },
  body: { fontSize: 14, color: colors.muted, textAlign: "center", maxWidth: 420 },
});
