import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";

export const colors = {
  text: "#1a202c",
  muted: "#718096",
  border: "#e2e8f0",
  bg: "#ffffff",
  ok: "#2f855a",
  err: "#c53030",
  blue: "#2b6cb0",
  green: "#2f855a",
  purple: "#6b46c1",
  gray: "#4a5568",
};

type ButtonProps = {
  label: string;
  onPress: () => void;
  color?: string;
  busy?: boolean;
  disabled?: boolean;
  variant?: "solid" | "outline";
};

export function Button({ label, onPress, color = colors.blue, busy, disabled, variant = "solid" }: ButtonProps) {
  const inactive = busy || disabled;
  const outline = variant === "outline";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        outline ? { borderColor: color, borderWidth: 1.5 } : { backgroundColor: color },
        (pressed || inactive) && { opacity: 0.6 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={outline ? color : "#fff"} />
      ) : (
        <Text style={[styles.buttonText, outline && { color }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

/** Success / error line; renders nothing when empty. */
export function Status({ text, kind = "ok" }: { text: string; kind?: "ok" | "err" | "plain" }) {
  if (!text) return null;
  const color = kind === "ok" ? colors.ok : kind === "err" ? colors.err : colors.text;
  return (
    <Text accessibilityLiveRegion={kind === "err" ? "assertive" : "polite"} style={[styles.status, { color }]}>
      {text}
    </Text>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <View style={styles.notice}>{children}</View>;
}

export function Badge({ label, tone = "purple" }: { label: string; tone?: "purple" | "blue" }) {
  const palette = tone === "blue" ? { bg: "#bee3f8", fg: "#2a4365" } : { bg: "#e9d8fd", fg: "#44337a" };
  return (
    <View style={[styles.badge, { backgroundColor: palette.bg }]}>
      <Text style={[styles.badgeText, { color: palette.fg }]}>{label}</Text>
    </View>
  );
}

export function Field(props: TextInputProps) {
  return <TextInput placeholderTextColor={colors.muted} {...props} style={[styles.input, props.style]} />;
}

/** Shows the chosen file's name under a picker button. */
export function FileLabel({ name }: { name?: string }) {
  return <Text style={styles.hint}>{name ? `Selected: ${name}` : "No file selected"}</Text>;
}

export const styles = StyleSheet.create({
  button: {
    borderRadius: 6,
    paddingVertical: 11,
    paddingHorizontal: 16,
    marginVertical: 4,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  section: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 16,
    gap: 6,
  },
  sectionTitle: { fontWeight: "700", fontSize: 16, color: colors.text },
  hint: { fontSize: 13, color: colors.muted },
  status: { fontSize: 14, marginTop: 2 },
  notice: {
    borderWidth: 1,
    borderColor: "#f0c36d",
    backgroundColor: "#fff8e6",
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  badge: { alignSelf: "flex-start", borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 12, fontWeight: "700" },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  link: { color: colors.blue, textDecorationLine: "underline" },
});
