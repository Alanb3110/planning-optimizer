export async function fetchLocalArrayBuffer(
  assetPath: string,
  fetcher: typeof fetch = fetch,
): Promise<ArrayBuffer> {
  const baseUrl = typeof window === "undefined" ? "http://localhost/" : window.location.href;
  const target = new URL(assetPath, baseUrl);
  const applicationOrigin = new URL(baseUrl).origin;
  if (target.origin !== applicationOrigin) {
    throw new Error("External asset requests are not permitted.");
  }
  const response = await fetcher(target.href, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not load the local asset (${response.status}).`);
  return response.arrayBuffer();
}
