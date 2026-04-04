export async function isModelCachedInAppCache(
  modelId: string,
): Promise<boolean> {
  if (typeof caches === "undefined") {
    return false;
  }

  try {
    const cache = await caches.open("transformers-cache");
    const requests = await cache.keys();

    for (const request of requests) {
      if (request.url.includes(`/${modelId}/resolve/main/onnx/model.onnx`)) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}
