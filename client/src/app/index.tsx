import { useAuth, useUser } from "@clerk/clerk-expo";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Badge, Button, Field, FileLabel, Notice, Section, Status, colors, styles as ui } from "@/components/ui";
import { useTrack } from "@/lib/analytics";
import { reportUrl, useApiPost } from "@/lib/api";
import { OFFICEBASICS_PORTAL_URL } from "@/lib/config";
import {
  PRODUCT_TYPES,
  SPREADSHEET_TYPES,
  fileForm,
  pickDocument,
  takePhoto,
  type PickedFile,
} from "@/lib/files";
import type {
  CatalogUploadResponse,
  CompareDownloadResponse,
  Comparison,
  SpendAnalysisResponse,
  SpendSummary,
} from "@/lib/types";

const TIER_ORDER = ["good", "better", "best"] as const;
type Tier = (typeof TIER_ORDER)[number];

const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const openUrl = (url: string) => WebBrowser.openBrowserAsync(url);

export default function HomeScreen() {
  const { signOut } = useAuth();
  const { user } = useUser();
  const post = useApiPost();
  const track = useTrack();

  // 1. catalog
  const [catalogFile, setCatalogFile] = useState<PickedFile | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogStatus, setCatalogStatus] = useState("");
  const [catalogError, setCatalogError] = useState("");

  // 2. comparison
  const [productFile, setProductFile] = useState<PickedFile | null>(null);
  const [competitorUses, setCompetitorUses] = useState("");
  const [compareBusy, setCompareBusy] = useState(false);
  const [compareError, setCompareError] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [downloadUrl, setDownloadUrl] = useState("");

  // confirmation
  const [overrides, setOverrides] = useState<Record<Tier, string>>({ good: "", better: "", best: "" });
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState<{ text: string; kind: "ok" | "err" }>({ text: "", kind: "ok" });

  // 3. spend analysis
  const [spendFile, setSpendFile] = useState<PickedFile | null>(null);
  const [spendTier, setSpendTier] = useState<Tier>("best");
  const [spendBusy, setSpendBusy] = useState(false);
  const [spendError, setSpendError] = useState("");
  const [spend, setSpend] = useState<{ summary: SpendSummary; workbook: string; exec: string } | null>(null);

  async function choose(types: string[], set: (f: PickedFile | null) => void, setError: (s: string) => void) {
    try {
      const picked = await pickDocument(types);
      if (picked) set(picked);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function uploadCatalog() {
    if (!catalogFile) return;
    setCatalogBusy(true);
    setCatalogError("");
    try {
      const data = await post<CatalogUploadResponse>("/catalog/upload/", fileForm(catalogFile), "Failed to load catalog");
      setCatalogStatus(`Loaded ${data.loaded_items} SKUs across ${data.categories.length} categories.`);
      track("catalog_uploaded", { loaded_items: data.loaded_items, categories: data.categories.length });
    } catch (e) {
      setCatalogStatus("");
      setCatalogError(errorText(e));
      track("catalog_upload_failed", { error: errorText(e) });
    } finally {
      setCatalogBusy(false);
    }
  }

  async function snapProduct() {
    setCompareError("");
    try {
      const photo = await takePhoto();
      if (photo) setProductFile(photo);
    } catch (e) {
      setCompareError(errorText(e));
    }
  }

  async function runComparison() {
    if (!productFile) return;
    setCompareBusy(true);
    setCompareError("");
    try {
      const fields: Record<string, string> = {};
      if (competitorUses.trim()) fields.competitor_uses_per_case = competitorUses.trim();
      const data = await post<CompareDownloadResponse>(
        "/compare/download/",
        fileForm(productFile, fields),
        "Comparison failed",
      );
      setComparison(data.comparison);
      setDownloadUrl(reportUrl(data.download_url));
      setOverrides({ good: "", better: "", best: "" });
      setConfirmStatus({ text: "", kind: "ok" });
      track("comparison_completed", {
        source: data.comparison.source,
        matched_category: data.comparison.matched_category,
        tiers_found: Object.keys(data.comparison.tiers).length,
        price_detected: data.comparison.competitor_price !== null,
      });
    } catch (e) {
      setCompareError(errorText(e));
      track("comparison_failed", { error: errorText(e) });
    } finally {
      setCompareBusy(false);
    }
  }

  async function confirmMatch() {
    if (!comparison) return;
    setConfirmBusy(true);
    setConfirmStatus({ text: "", kind: "ok" });
    const payload: Record<string, string> = { comparison_id: comparison.comparison_id };
    for (const tier of TIER_ORDER) {
      const sku = overrides[tier].trim();
      if (sku) payload[`${tier}_sku`] = sku;
    }
    try {
      await post("/feedback/confirm/", payload, "Could not save feedback");
      setConfirmStatus({ text: "Saved — future similar products will use this match.", kind: "ok" });
      track("match_confirmed", { overrides: Object.keys(payload).length - 1 });
    } catch (e) {
      setConfirmStatus({ text: errorText(e), kind: "err" });
    } finally {
      setConfirmBusy(false);
    }
  }

  async function runSpendAnalysis() {
    if (!spendFile) return;
    setSpendBusy(true);
    setSpendError("");
    try {
      const data = await post<SpendAnalysisResponse>(
        "/analysis/spend/",
        fileForm(spendFile, { recommended_tier: spendTier }),
        "Spend analysis failed",
      );
      setSpend({
        summary: data.summary,
        workbook: reportUrl(data.workbook_url),
        exec: reportUrl(data.executive_summary_url),
      });
      track("spend_analysis_completed", {
        recommended_tier: spendTier,
        rows_analyzed: data.summary.rows_analyzed,
        rows_unmatched: data.summary.rows_unmatched,
        savings_pct: Math.round(data.summary.savings_pct * 10) / 10,
      });
    } catch (e) {
      setSpendError(errorText(e));
      track("spend_analysis_failed", { error: errorText(e) });
    } finally {
      setSpendBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.title}>Office Basics Good / Better / Best</Text>
          <View style={styles.account}>
            <Text style={ui.hint} numberOfLines={1}>
              {user?.primaryEmailAddress?.emailAddress}
            </Text>
            <Button label="Sign out" variant="outline" color={colors.gray} onPress={() => signOut()} />
          </View>
        </View>

        {/* Step 1: catalog */}
        <Section
          title="1. Upload your Office Basics SKU/cost export"
          hint="Columns required: sku, name, description, category, tier (good/better/best), price"
        >
          <Button
            label="Choose catalog file (.csv, .xlsx, .xls)"
            variant="outline"
            onPress={() => choose(SPREADSHEET_TYPES, setCatalogFile, setCatalogError)}
          />
          <FileLabel name={catalogFile?.name} />
          <Button label="Load Catalog" onPress={uploadCatalog} busy={catalogBusy} disabled={!catalogFile} />
          <Status text={catalogStatus} />
          <Status text={catalogError} kind="err" />
        </Section>

        {/* Step 2: competitor product */}
        <Section
          title="2. Upload the current (competitor) product"
          hint="Photo, PDF, or Excel — price and product info are extracted automatically"
        >
          {Platform.OS !== "web" ? (
            <Button label="Take a photo" variant="outline" color={colors.green} onPress={snapProduct} />
          ) : null}
          <Button
            label="Choose product file (image, .pdf, .xlsx)"
            variant="outline"
            color={colors.green}
            onPress={() => choose(PRODUCT_TYPES, setProductFile, setCompareError)}
          />
          <FileLabel name={productFile?.name} />
          <Field
            placeholder="Competitor uses per case (optional, enables cost-per-use)"
            value={competitorUses}
            onChangeText={setCompetitorUses}
            keyboardType="decimal-pad"
            inputMode="decimal"
          />
          <Button
            label="Run Cost Comparison"
            color={colors.green}
            onPress={runComparison}
            busy={compareBusy}
            disabled={!productFile}
          />
          <Status text={compareError} kind="err" />

          {comparison ? (
            <View style={styles.results}>
              <Text style={styles.strong}>Current product: {comparison.competitor_product}</Text>
              <Text>
                Detected price:{" "}
                {comparison.competitor_price ? money(comparison.competitor_price) : "Not detected"}
              </Text>
              <Text style={ui.hint}>Matched category: {comparison.matched_category ?? "—"}</Text>
              <Badge
                label={comparison.source === "learned" ? "Learned from a confirmed match" : "Algorithmic match"}
              />

              {TIER_ORDER.map((tier) => {
                const item = comparison.tiers[tier];
                if (!item) return null;
                return (
                  <View key={tier} style={styles.tier}>
                    <Badge label={tier.toUpperCase()} tone="blue" />
                    <View style={styles.tierInfo}>
                      <Text style={styles.strong}>{item.name}</Text>
                      <Text style={ui.hint}>SKU: {item.sku}</Text>
                    </View>
                    <Text style={styles.price}>{money(item.price)}</Text>
                  </View>
                );
              })}

              {comparison.manual_lookup ? (
                <Notice>
                  <Text>{comparison.manual_lookup.note}</Text>
                  <Text style={ui.link} onPress={() => openUrl(comparison.manual_lookup!.portal_url)}>
                    Open supplies.officebasics.com
                  </Text>
                </Notice>
              ) : null}

              {downloadUrl ? (
                <Button label="Download Cost Comparison (.xlsx)" onPress={() => openUrl(downloadUrl)} />
              ) : null}

              <Text style={[ui.hint, styles.spaced]}>
                Was this the right call? Correct any tier below and confirm so similar products are matched this way
                next time.
              </Text>
              {TIER_ORDER.map((tier) => (
                <Field
                  key={tier}
                  placeholder={`${tier[0].toUpperCase()}${tier.slice(1)} SKU override (optional)`}
                  value={overrides[tier]}
                  onChangeText={(v) => setOverrides((o) => ({ ...o, [tier]: v }))}
                  autoCapitalize="characters"
                />
              ))}
              <Button label="Confirm This Match" color={colors.purple} onPress={confirmMatch} busy={confirmBusy} />
              <Status text={confirmStatus.text} kind={confirmStatus.kind} />
            </View>
          ) : null}
        </Section>

        {/* Step 3: spend analysis */}
        <Section
          title="3. Usage analysis & executive summary (optional)"
          hint="Upload historical spend data (date, location, product, quantity, unit_price or total_price) to see how much Office Basics equivalents would have saved."
        >
          <Button
            label="Choose spend history file (.csv, .xlsx)"
            variant="outline"
            color={colors.purple}
            onPress={() => choose(SPREADSHEET_TYPES, setSpendFile, setSpendError)}
          />
          <FileLabel name={spendFile?.name} />
          <Text style={ui.hint}>Recommend which tier?</Text>
          <View style={styles.segment}>
            {TIER_ORDER.map((tier) => (
              <View key={tier} style={styles.segmentItem}>
                <Button
                  label={tier.toUpperCase()}
                  color={colors.purple}
                  variant={spendTier === tier ? "solid" : "outline"}
                  onPress={() => setSpendTier(tier)}
                />
              </View>
            ))}
          </View>
          <Button
            label="Generate Usage Analysis"
            color={colors.purple}
            onPress={runSpendAnalysis}
            busy={spendBusy}
            disabled={!spendFile}
          />
          <Status text={spendError} kind="err" />

          {spend ? (
            <View style={styles.results}>
              <View style={styles.stats}>
                <Stat label="Current Spend" value={money(spend.summary.total_current_spend)} />
                <Stat label="Recommended Spend" value={money(spend.summary.total_recommended_spend)} />
                <Stat
                  label="Savings"
                  value={`${money(spend.summary.total_savings)} (${spend.summary.savings_pct.toFixed(1)}%)`}
                  color={colors.ok}
                />
              </View>
              <Text style={ui.hint}>
                {spend.summary.rows_analyzed} records analyzed, {spend.summary.rows_unmatched} unmatched
              </Text>
              {spend.summary.manual_lookup_note ? (
                <Notice>
                  <Text>{spend.summary.manual_lookup_note}</Text>
                  <Text style={ui.link} onPress={() => openUrl(OFFICEBASICS_PORTAL_URL)}>
                    Open supplies.officebasics.com
                  </Text>
                </Notice>
              ) : null}
              <Button label="Download Usage Analysis Workbook (.xlsx)" onPress={() => openUrl(spend.workbook)} />
              <Button label="Download Executive Summary (.docx)" onPress={() => openUrl(spend.exec)} />
            </View>
          ) : null}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value, color = colors.text }: { label: string; value: string; color?: string }) {
  return (
    <View>
      <Text style={ui.hint}>{label}</Text>
      <Text style={[styles.strong, { color }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { padding: 16, paddingBottom: 48, width: "100%", maxWidth: 700, alignSelf: "center" },
  header: { gap: 8, marginBottom: 8 },
  title: { fontSize: 22, fontWeight: "700", color: colors.text, textAlign: "center" },
  account: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  results: { gap: 8, marginTop: 8 },
  strong: { fontWeight: "700", color: colors.text },
  tier: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
  },
  tierInfo: { flex: 1, minWidth: 0 },
  price: { fontWeight: "700", fontSize: 16, color: colors.text },
  spaced: { marginTop: 8 },
  segment: { flexDirection: "row", gap: 8 },
  segmentItem: { flex: 1 },
  stats: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 12 },
});
