// Minimal CLI that calls the local SSE endpoint and prints events
const res = await fetch('http://localhost:3000/v1/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'Find pizza near me; book a table at 7pm if open.' }),
});

if (!res.ok || !res.body) {
  console.error('HTTP error', res.status);
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const chunk = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    console.log(chunk);
  }
}
