import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    // Same model Supabase.ai uses in the edge query → vectors share one space.
    extractorPromise = pipeline("feature-extraction", "Supabase/gte-small");
  }
  return extractorPromise;
}

/** 384-dim, mean-pooled, L2-normalized embedding (matches the edge brain-query). */
export async function embed(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}
