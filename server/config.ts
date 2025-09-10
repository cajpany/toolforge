export const CONFIG = {
  FRAME_TIMEOUT_MS: Number(process.env.FRAME_TIMEOUT_MS ?? 15000),
  TOOL_TIMEOUT_MS: Number(process.env.TOOL_TIMEOUT_MS ?? 8000),
  TOOL_RETRIES: Number(process.env.TOOL_RETRIES ?? 1),
  REPAIR_RETRIES: Number(process.env.REPAIR_RETRIES ?? 1),
  MODEL_ID: process.env.MODEL_ID ?? 'gpt-oss-20b',
  TEMPERATURE: Number(process.env.TEMPERATURE ?? 0.2),
  SEED: Number(process.env.SEED ?? 42),
  MAX_TOKENS: Number(process.env.MAX_TOKENS ?? 384),
};
