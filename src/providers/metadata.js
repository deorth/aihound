// Free, offline check for provenance metadata that generators embed.
// High precision, low recall: most social platforms strip metadata on upload.
// Note that C2PA alone is NOT a signal (cameras and editors sign too); we only
// flag when the manifest/XMP declares an AI digital source type.

const MARKERS = [
  // IPTC DigitalSourceType, used in XMP and in C2PA action assertions.
  // Also matches compositeWithTrainedAlgorithmicMedia.
  { re: /trainedAlgorithmicMedia/i, label: 'IPTC/C2PA digital source type: AI-generated' },
  // Automatic1111 / Forge "parameters" text chunk.
  { re: /Steps: \d+, Sampler: /, label: 'Stable Diffusion generation parameters' },
  // ComfyUI embeds its node graph in a "prompt"/"workflow" text chunk.
  { re: /"class_type"\s*:\s*"(KSampler|CheckpointLoaderSimple)/, label: 'ComfyUI workflow' },
];

const SCAN_BYTES = 4 * 1024 * 1024;

/** @returns {Promise<string|null>} a description of the marker found, or null. */
export async function detectMetadata(blob) {
  const buf = await blob.slice(0, SCAN_BYTES).arrayBuffer();
  const text = new TextDecoder('latin1').decode(buf);
  for (const { re, label } of MARKERS) if (re.test(text)) return label;
  return null;
}
