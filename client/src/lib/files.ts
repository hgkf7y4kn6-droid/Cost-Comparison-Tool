import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";

export type PickedFile = {
  name: string;
  uri: string;
  mimeType?: string;
  /** Present on web only: the browser File object. */
  file?: File;
};

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLS = "application/vnd.ms-excel";

export const SPREADSHEET_TYPES = ["text/csv", "text/comma-separated-values", XLS, XLSX];
export const PRODUCT_TYPES = ["image/*", "application/pdf", XLS, XLSX];

export async function pickDocument(types: string[]): Promise<PickedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: types,
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets.length) return null;
  const asset = result.assets[0];
  return { name: asset.name, uri: asset.uri, mimeType: asset.mimeType, file: asset.file };
}

/** Native only: photograph a competitor product with the camera. */
export async function takePhoto(): Promise<PickedFile | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error("Camera permission is needed to photograph a product.");
  }
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 });
  if (result.canceled || !result.assets.length) return null;
  const asset = result.assets[0];
  return {
    // the backend picks the parser from the extension, so always send one
    name: asset.fileName ?? `photo_${Date.now()}.jpg`,
    uri: asset.uri,
    mimeType: asset.mimeType ?? "image/jpeg",
  };
}

/** Builds a multipart form with `file` set, in the shape each platform's fetch expects. */
export function fileForm(picked: PickedFile, fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  if (Platform.OS === "web" && picked.file) {
    form.append("file", picked.file, picked.name);
  } else {
    // React Native's FormData accepts a {uri, name, type} descriptor for files.
    form.append("file", {
      uri: picked.uri,
      name: picked.name,
      type: picked.mimeType ?? "application/octet-stream",
    } as unknown as Blob);
  }
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}
