const seen = new Map<string, number>();

export async function executeTestFailOnce(args: { key?: string }) {
  const k = JSON.stringify(args ?? {});
  const count = (seen.get(k) ?? 0) + 1;
  seen.set(k, count);
  if (count === 1) {
    const err: any = new Error('test_fail_once: simulated failure');
    err.code = 'test_fail_once';
    throw err;
  }
  return { ok: true, attempt: count };
}
