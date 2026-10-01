// Response shapes of the backend endpoints the app uses (see backend.py).

export type CatalogUploadResponse = {
  loaded_items: number;
  skipped_rows: number;
  categories: string[];
};

export type TierItem = {
  sku: string;
  name: string;
  description: string;
  category: string;
  tier: "good" | "better" | "best";
  price: number;
  uses_per_case: number | null;
  format: string | null;
};

export type Comparison = {
  comparison_id: string;
  competitor_product: string;
  competitor_price: number | null;
  competitor_cost_per_use: number | null;
  matched_category: string | null;
  source: "learned" | "algorithmic";
  tiers: Partial<Record<"good" | "better" | "best", TierItem>>;
  manual_lookup: { missing_tiers: string[]; note: string; portal_url: string } | null;
};

export type CompareDownloadResponse = { comparison: Comparison; download_url: string };

export type SpendSummary = {
  recommended_tier: string;
  total_current_spend: number;
  total_recommended_spend: number;
  total_savings: number;
  savings_pct: number;
  rows_analyzed: number;
  rows_unmatched: number;
  manual_lookup_note: string | null;
};

export type SpendAnalysisResponse = {
  summary: SpendSummary;
  workbook_url: string;
  executive_summary_url: string;
};
