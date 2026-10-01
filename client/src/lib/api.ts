import { useAuth } from "@clerk/clerk-expo";
import { useCallback } from "react";

import { API_BASE } from "./config";

/**
 * Returns a POST helper that attaches the signed-in user's Clerk session token,
 * which the backend verifies on every API route. Throws an Error whose message
 * is the backend's `detail` (or `fallbackError`) so screens can show it as-is.
 */
export function useApiPost() {
  const { getToken } = useAuth();

  return useCallback(
    async <T>(path: string, body: FormData | object, fallbackError: string): Promise<T> => {
      const token = await getToken();
      const isForm = body instanceof FormData;
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (!isForm) headers["Content-Type"] = "application/json";

      let response: Response;
      try {
        response = await fetch(`${API_BASE}${path}`, {
          method: "POST",
          headers,
          body: isForm ? body : JSON.stringify(body),
        });
      } catch (e) {
        throw new Error(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        // non-JSON error body
      }
      if (response.status === 401) {
        throw new Error("Your session has expired. Sign out and sign back in.");
      }
      if (!response.ok) {
        const detail = (data as { detail?: unknown } | null)?.detail;
        throw new Error(typeof detail === "string" ? detail : fallbackError);
      }
      return data as T;
    },
    [getToken],
  );
}

/** Report links are returned as server paths (e.g. /reports/x.xlsx). */
export const reportUrl = (path: string) => `${API_BASE}${path}`;
