import { isClerkAPIResponseError, useSignIn, useSignUp } from "@clerk/clerk-expo";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button, Field, Status, colors } from "@/components/ui";
import { useTrack } from "@/lib/analytics";

type Mode = "signIn" | "signUp";

function errorMessage(e: unknown): string {
  if (isClerkAPIResponseError(e)) {
    return e.errors[0]?.longMessage ?? e.errors[0]?.message ?? "Sign-in failed.";
  }
  return e instanceof Error ? e.message : "Sign-in failed.";
}

/**
 * Passwordless email-code sign-in. Existing users get a sign-in code; new
 * emails fall through to sign-up with the same code step. Requires the
 * "Email verification code" strategy enabled in the Clerk dashboard.
 */
export default function SignInScreen() {
  const { isLoaded: signInLoaded, signIn, setActive } = useSignIn();
  const { isLoaded: signUpLoaded, signUp } = useSignUp();
  const track = useTrack();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ready = signInLoaded && signUpLoaded;

  async function sendCode() {
    if (!ready || !email.trim()) return;
    setBusy(true);
    setError("");
    try {
      try {
        const attempt = await signIn.create({ identifier: email.trim() });
        const factor = attempt.supportedFirstFactors?.find((f) => f.strategy === "email_code");
        if (!factor || factor.strategy !== "email_code") {
          throw new Error("Email codes aren't enabled for this account. Enable them in the Clerk dashboard.");
        }
        await signIn.prepareFirstFactor({ strategy: "email_code", emailAddressId: factor.emailAddressId });
        setMode("signIn");
      } catch (e) {
        const notFound =
          isClerkAPIResponseError(e) && e.errors.some((err) => err.code === "form_identifier_not_found");
        if (!notFound) throw e;
        await signUp.create({ emailAddress: email.trim() });
        await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
        setMode("signUp");
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    if (!ready || !mode || !code.trim()) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "signIn") {
        const result = await signIn.attemptFirstFactor({ strategy: "email_code", code: code.trim() });
        if (result.status !== "complete") throw new Error("Additional verification is required for this account.");
        await setActive({ session: result.createdSessionId });
        track("signed_in", { method: "email_code" });
      } else {
        const result = await signUp.attemptEmailAddressVerification({ code: code.trim() });
        if (result.status !== "complete") {
          throw new Error(
            "Sign-up needs more fields than an email. In the Clerk dashboard, make email the only required field.",
          );
        }
        await setActive({ session: result.createdSessionId });
        track("signed_up", { method: "email_code" });
      }
      // the root layout's auth guard swaps to the main screen once the session is active
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setMode(null);
    setCode("");
    setError("");
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Office Basics Comparison</Text>
          <Text style={styles.subtitle}>Sign in with your work email.</Text>

          {mode === null ? (
            <>
              <Field
                placeholder="you@company.com"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                inputMode="email"
                onSubmitEditing={sendCode}
                accessibilityLabel="Email address"
              />
              <Button label="Email me a code" onPress={sendCode} busy={busy} disabled={!ready || !email.trim()} />
            </>
          ) : (
            <>
              <Text style={styles.subtitle}>
                We sent a code to {email.trim()}. {mode === "signUp" ? "This will create your account." : ""}
              </Text>
              <Field
                placeholder="6-digit code"
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                inputMode="numeric"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                onSubmitEditing={verifyCode}
                accessibilityLabel="Verification code"
              />
              <Button label="Verify and continue" onPress={verifyCode} busy={busy} disabled={!code.trim()} />
              <Button label="Use a different email" onPress={startOver} variant="outline" color={colors.gray} />
            </>
          )}

          <Status text={error} kind="err" />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  container: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
    gap: 10,
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
  },
  title: { fontSize: 24, fontWeight: "700", color: colors.text, textAlign: "center" },
  subtitle: { fontSize: 15, color: colors.muted, textAlign: "center", marginBottom: 6 },
});
