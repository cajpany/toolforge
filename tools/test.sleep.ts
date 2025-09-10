export async function executeTestSleep(args: { ms: number }) {
  const ms = Number(args?.ms ?? 0);
  await new Promise((res) => setTimeout(res, ms));
  return { ok: true, slept_ms: ms };
}
