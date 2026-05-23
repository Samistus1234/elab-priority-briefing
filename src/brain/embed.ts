import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    // Same model Supabase.ai uses in the edge query → vectors share one space.
    // Reset on failure so a transient model-load error doesn't permanently break
    // a long-running worker (a cached rejected promise would re-reject forever).
    extractorPromise = pipeline("feature-extraction", "Supabase/gte-small").catch((e) => {
      extractorPromise = null;
      throw e;
    });
  }
  return extractorPromise;
}

/** 384-dim, mean-pooled, L2-normalized embedding (matches the edge brain-query). */
export async function embed(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  const vec = Array.from(output.data as Float32Array);
  // brain_entries.embedding is vector(384); a model-swap mismatch must fail loudly,
  // not silently store wrong-dimension vectors.
  if (vec.length !== 384) throw new Error(`unexpected embedding dim ${vec.length} (want 384)`);
  return vec;
}
